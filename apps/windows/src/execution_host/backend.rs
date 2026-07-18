use super::{codex_app_server, protocol::BackendKind, windows::Job};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::protocol::StartParams;

pub(super) type EventCallback = Arc<dyn Fn(&str, Value) + Send + Sync + 'static>;
pub(super) type ExitCallback = Arc<dyn Fn(u32) + Send + Sync + 'static>;

pub struct BackendControl {
    kind: BackendKind,
    pid: u32,
    process_started_at_ticks: u64,
    input: Option<Arc<Mutex<Box<dyn Write + Send>>>>,
    terminal: Option<Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>>,
    job: Arc<Job>,
    activation: Arc<(Mutex<bool>, Condvar)>,
}

impl BackendControl {
    pub fn start(
        start: &StartParams,
        on_event: EventCallback,
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        match start.backend {
            BackendKind::Stdio => Self::start_stdio(start, on_event, on_exit),
            BackendKind::ConPty => Self::start_conpty(start, on_event, on_exit),
            BackendKind::AppServer => Self::start_app_server(start, on_event, on_exit),
        }
    }

    fn start_app_server(
        start: &StartParams,
        on_event: EventCallback,
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        let launched = codex_app_server::start(start, on_event, on_exit)?;
        Ok(Arc::new(Self {
            kind: BackendKind::AppServer,
            pid: launched.pid,
            process_started_at_ticks: launched.process_started_at_ticks,
            input: None,
            terminal: None,
            job: launched.job,
            activation: launched.activation,
        }))
    }

    fn start_stdio(
        start: &StartParams,
        on_event: EventCallback,
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        let job = Arc::new(Job::create()?);
        let activation = Arc::new((Mutex::new(false), Condvar::new()));
        let mut command = Command::new(&start.command);
        command
            .args(&start.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &start.cwd {
            command.current_dir(cwd);
        }
        command.envs(&start.env);
        #[cfg(windows)]
        command.creation_flags(
            super::windows::CREATE_NEW_PROCESS_GROUP | super::windows::CREATE_NO_WINDOW,
        );

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to start stdio command {}", start.command))?;
        let pid = child.id();
        if let Err(error) = job.assign_pid(pid) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let process_started_at_ticks = super::windows::process_creation_ticks(pid)?;
        let stdin = child
            .stdin
            .take()
            .context("stdio child stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("stdio child stdout is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("stdio child stderr is unavailable")?;
        let stdout_thread = pump_reader(stdout, "stream.stdout", Arc::clone(&on_event));
        let stderr_thread = pump_reader(stderr, "stream.stderr", on_event);
        let exit_activation = Arc::clone(&activation);
        thread::Builder::new()
            .name(format!("execution-{pid}-wait"))
            .spawn(move || {
                let exit_code = child
                    .wait()
                    .ok()
                    .and_then(|status| status.code())
                    .unwrap_or(1) as u32;
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                wait_for_activation(&exit_activation);
                on_exit(exit_code);
            })
            .context("failed to start stdio child wait thread")?;

        Ok(Arc::new(Self {
            kind: BackendKind::Stdio,
            pid,
            process_started_at_ticks,
            input: Some(Arc::new(Mutex::new(Box::new(stdin)))),
            terminal: None,
            job,
            activation,
        }))
    }

    fn start_conpty(
        start: &StartParams,
        on_event: EventCallback,
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        let job = Arc::new(Job::create()?);
        let activation = Arc::new((Mutex::new(false), Condvar::new()));
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: start.rows,
                cols: start.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to create ConPTY")?;
        let mut command = CommandBuilder::new(&start.command);
        for argument in &start.args {
            command.arg(argument);
        }
        if let Some(cwd) = &start.cwd {
            command.cwd(cwd);
        }
        for (key, value) in &start.env {
            command.env(key, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("failed to start ConPTY command {}", start.command))?;
        drop(pair.slave);
        let pid = child
            .process_id()
            .context("ConPTY backend did not expose the child process id")?;
        if let Err(error) = job.assign_pid(pid) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let process_started_at_ticks = super::windows::process_creation_ticks(pid)?;
        let reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone ConPTY output reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("failed to take ConPTY input writer")?;
        let input = Arc::new(Mutex::new(writer));
        let terminal_ready = Arc::new((Mutex::new(false), Condvar::new()));
        let terminal = Arc::new(Mutex::new(Some(pair.master)));
        let output_thread = pump_conpty_reader(
            reader,
            Arc::clone(&input),
            Arc::clone(&terminal_ready),
            on_event,
        );
        let exit_activation = Arc::clone(&activation);
        let exit_terminal = Arc::clone(&terminal);
        thread::Builder::new()
            .name(format!("execution-{pid}-wait"))
            .spawn(move || {
                let exit_code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
                if let Ok(mut terminal) = exit_terminal.lock() {
                    terminal.take();
                }
                let _ = output_thread.join();
                wait_for_activation(&exit_activation);
                on_exit(exit_code);
            })
            .context("failed to start ConPTY child wait thread")?;
        wait_for_terminal_ready(&terminal_ready);

        Ok(Arc::new(Self {
            kind: BackendKind::ConPty,
            pid,
            process_started_at_ticks,
            input: Some(input),
            terminal: Some(terminal),
            job,
            activation,
        }))
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn process_started_at_ticks(&self) -> u64 {
        self.process_started_at_ticks
    }

    pub fn write_input(&self, bytes: &[u8]) -> Result<()> {
        let mut input = self
            .input
            .as_ref()
            .context("CAPABILITY_UNSUPPORTED: this execution does not support live input")?
            .lock()
            .map_err(|_| anyhow::anyhow!("input lock poisoned"))?;
        input
            .write_all(bytes)
            .context("failed to write execution input")?;
        input.flush().context("failed to flush execution input")
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            bail!("terminal size must be positive");
        }
        let terminal = self
            .terminal
            .as_ref()
            .context("stdio executions do not support resize")?;
        let terminal = terminal
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal lock poisoned"))?;
        terminal
            .as_ref()
            .context("ConPTY has already closed")?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize ConPTY")
    }

    pub fn signal(&self, signal: &str) -> Result<()> {
        match signal {
            "interrupt" if self.kind == BackendKind::ConPty => self.write_input(&[3]),
            "interrupt" => bail!("stdio executions do not support an interrupt signal"),
            "terminate" | "stop" => self.job.terminate(0xC000_013A),
            _ => bail!("unsupported execution signal {signal}"),
        }
    }

    pub fn capabilities(&self) -> Value {
        json!({
            "input": self.kind != BackendKind::AppServer,
            "resize": self.kind == BackendKind::ConPty,
            "interrupt": self.kind == BackendKind::ConPty,
            "terminate": true,
            "eventReplay": true,
            "reattach": true,
            "terminalReadyHandshake": self.kind == BackendKind::ConPty,
            "backend": self.kind,
            "executionOwnership": "vibelink-host",
            "structuredToolEvents": if self.kind == BackendKind::AppServer { "authoritative" } else { "unavailable" },
            "toolOutput": if self.kind == BackendKind::AppServer { "complete" } else { "unavailable" },
            "exitStatus": "authoritative",
            "approvalContinuation": false,
            "liveInput": false,
            "protocol": if self.kind == BackendKind::AppServer { "codex-app-server" } else { "process" },
            "protocolVersion": if self.kind == BackendKind::AppServer { "probed" } else { "v1" }
        })
    }

    pub fn activate(&self) {
        let (active, condition) = &*self.activation;
        if let Ok(mut active) = active.lock() {
            *active = true;
            condition.notify_all();
        }
    }
}

fn wait_for_activation(activation: &Arc<(Mutex<bool>, Condvar)>) {
    let (active, condition) = &**activation;
    if let Ok(mut active) = active.lock() {
        while !*active {
            match condition.wait(active) {
                Ok(next) => active = next,
                Err(_) => return,
            }
        }
    }
}

fn pump_reader<R: Read + Send + 'static>(
    mut reader: R,
    event_type: &'static str,
    on_event: EventCallback,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name(format!("execution-{event_type}"))
        .spawn(move || {
            let mut buffer = vec![0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => on_event(
                        event_type,
                        json!({
                            "data": BASE64.encode(&buffer[..length]),
                            "encoding": "base64"
                        }),
                    ),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
        .expect("execution output reader thread must start")
}

fn pump_conpty_reader<R: Read + Send + 'static>(
    mut reader: R,
    input: Arc<Mutex<Box<dyn Write + Send>>>,
    terminal_ready: Arc<(Mutex<bool>, Condvar)>,
    on_event: EventCallback,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name("execution-stream.pty".to_string())
        .spawn(move || {
            let mut buffer = vec![0_u8; 8192];
            let mut scan_tail = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        scan_tail.extend_from_slice(&buffer[..length]);
                        if scan_tail.windows(4).any(|window| window == b"\x1b[6n") {
                            if let Ok(mut input) = input.lock() {
                                let _ = input.write_all(b"\x1b[1;1R");
                                let _ = input.flush();
                            }
                            let (ready, condition) = &*terminal_ready;
                            if let Ok(mut ready) = ready.lock() {
                                *ready = true;
                                condition.notify_all();
                            }
                        }
                        if scan_tail.len() > 3 {
                            scan_tail.drain(..scan_tail.len() - 3);
                        }
                        on_event(
                            "stream.pty",
                            json!({
                                "data": BASE64.encode(&buffer[..length]),
                                "encoding": "base64"
                            }),
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
        .expect("ConPTY output reader thread must start")
}

fn wait_for_terminal_ready(terminal_ready: &Arc<(Mutex<bool>, Condvar)>) {
    let (ready, condition) = &**terminal_ready;
    if let Ok(ready) = ready.lock() {
        if !*ready {
            drop(condition.wait_timeout(ready, std::time::Duration::from_secs(1)));
        }
    }
}
