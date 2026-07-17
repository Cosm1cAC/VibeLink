use crate::sidecar_protocol::{
    now_iso, sidecar_arg, sidecar_arg_or_default, write_sidecar_error, write_sidecar_result,
    SidecarRequest,
};
#[cfg(windows)]
use crate::CREATE_NO_WINDOW;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    io::{self, BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc, Mutex, TryLockError,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct McpServerConfig {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct McpSidecarOptions {
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(rename = "maxIdleMs")]
    max_idle_ms: Option<u64>,
    #[serde(rename = "maxPendingRequests")]
    max_pending_requests: Option<usize>,
    timeout: Option<u64>,
}

struct McpStdioSession {
    server: McpServerConfig,
    child: Child,
    stdin: ChildStdin,
    stdout_rx: Receiver<Value>,
    closed: bool,
    next_id: u64,
    initialized: Option<Value>,
    tools: Option<Vec<Value>>,
    started_at: String,
    last_used_at: String,
    last_request_at: String,
    last_response_at: String,
    last_failure_at: String,
    last_backpressure_at: String,
    requests: u64,
    responses: u64,
    failures: u64,
    timeouts: u64,
    backpressure_rejects: u64,
    timeout_ms: u64,
    max_pending_requests: usize,
    max_pending_observed: usize,
    last_used: Instant,
}

struct McpSidecarManager {
    sessions: HashMap<String, McpStdioSession>,
}

struct McpSidecarRuntimeStats {
    active_requests: AtomicUsize,
    max_active_observed: AtomicUsize,
    backpressure_rejects: AtomicUsize,
    max_active_requests: usize,
}

pub(crate) fn run() -> Result<()> {
    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let manager = Arc::new(Mutex::new(McpSidecarManager {
        sessions: HashMap::new(),
    }));
    let runtime = Arc::new(McpSidecarRuntimeStats::from_env());
    let mut workers = Vec::new();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: SidecarRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let mut stdout = stdout.lock().expect("MCP sidecar stdout lock poisoned");
                write_sidecar_error(&mut stdout, &Value::Null, &error.to_string())?;
                continue;
            }
        };

        if request.method == "__close" {
            let mut manager = manager.lock().expect("MCP sidecar manager lock poisoned");
            manager.close_all();
            let mut stdout = stdout.lock().expect("MCP sidecar stdout lock poisoned");
            write_sidecar_result(&mut stdout, &request.id, json!({ "ok": true }))?;
            break;
        }

        if request.method == "stats" {
            let result = match manager.try_lock() {
                Ok(manager) => manager.stats_with_runtime(&runtime),
                Err(TryLockError::WouldBlock) => McpSidecarManager::busy_stats(&runtime),
                Err(TryLockError::Poisoned(_)) => McpSidecarManager::busy_stats(&runtime),
            };
            let mut stdout = stdout.lock().expect("MCP sidecar stdout lock poisoned");
            write_sidecar_result(&mut stdout, &request.id, result)?;
            continue;
        }

        if !runtime.try_acquire() {
            let mut stdout = stdout.lock().expect("MCP sidecar stdout lock poisoned");
            write_sidecar_error(
                &mut stdout,
                &request.id,
                &format!(
                    "MCP session sidecar backpressure: {} rejected because {} request(s) are already active.",
                    request.method, runtime.max_active_requests
                ),
            )?;
            continue;
        }

        let manager = Arc::clone(&manager);
        let stdout = Arc::clone(&stdout);
        let runtime = Arc::clone(&runtime);
        workers.push(thread::spawn(move || {
            let result = {
                let mut manager = manager.lock().expect("MCP sidecar manager lock poisoned");
                manager.handle(&request.method, &request.args)
            };
            runtime.release();
            let mut stdout = stdout.lock().expect("MCP sidecar stdout lock poisoned");
            match result {
                Ok(result) => write_sidecar_result(&mut stdout, &request.id, result),
                Err(error) => write_sidecar_error(&mut stdout, &request.id, &format!("{error:#}")),
            }
        }));
    }

    for worker in workers {
        let result = worker
            .join()
            .map_err(|_| anyhow::anyhow!("MCP sidecar worker thread panicked"))?;
        result?;
    }
    manager
        .lock()
        .expect("MCP sidecar manager lock poisoned")
        .close_all();
    Ok(())
}

fn mcp_server_key(server: &McpServerConfig) -> String {
    let mut env = BTreeMap::new();
    for (key, value) in &server.env {
        env.insert(key, value);
    }
    serde_json::to_string(&json!({
        "id": server.id,
        "name": server.name,
        "command": server.command,
        "args": server.args,
        "cwd": server.cwd,
        "env": env
    }))
    .unwrap_or_default()
}

impl McpSidecarManager {
    fn busy_stats(runtime: &McpSidecarRuntimeStats) -> Value {
        runtime.apply(json!({
            "sessions": 0,
            "activeSessions": 0,
            "totalPending": 0,
            "totalRequests": 0,
            "totalResponses": 0,
            "totalFailures": 0,
            "totalTimeouts": 0,
            "totalBackpressureRejects": 0,
            "maxPendingObserved": 0,
            "items": []
        }))
    }

    fn handle(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "probeStdioServer" => {
                let server: McpServerConfig = sidecar_arg(args, 0)?;
                let options: McpSidecarOptions = sidecar_arg_or_default(args, 1)?;
                let session = self.session_for(server, &options)?;
                let initialize = session.ensure_initialized()?;
                let tools = session.list_tools()?;
                Ok(json!({
                    "ok": true,
                    "transport": "stdio",
                    "protocolVersion": initialize.get("protocolVersion").and_then(Value::as_str).unwrap_or(""),
                    "serverInfo": initialize.get("serverInfo").cloned().unwrap_or(Value::Null),
                    "capabilities": initialize.get("capabilities").cloned().unwrap_or(Value::Null),
                    "tools": tools,
                    "stderr": ""
                }))
            }
            "listTools" => {
                let server: McpServerConfig = sidecar_arg(args, 0)?;
                let options: McpSidecarOptions = sidecar_arg_or_default(args, 1)?;
                let session = self.session_for(server, &options)?;
                Ok(Value::Array(session.list_tools()?))
            }
            "callTool" => {
                let server: McpServerConfig = sidecar_arg(args, 0)?;
                let tool_name: String = sidecar_arg(args, 1)?;
                let tool_arguments: Value = args.get(2).cloned().unwrap_or_else(|| json!({}));
                let options: McpSidecarOptions = sidecar_arg_or_default(args, 3)?;
                let session = self.session_for(server, &options)?;
                session.call_tool(&tool_name, tool_arguments)
            }
            "closeIdleSessions" => {
                let options: McpSidecarOptions = sidecar_arg_or_default(args, 0)?;
                let closed = self.close_idle(options.max_idle_ms.unwrap_or(10 * 60 * 1000));
                Ok(json!({ "closed": closed, "remaining": self.sessions.len() }))
            }
            "closeAll" => {
                self.close_all();
                Ok(json!({ "ok": true }))
            }
            "stats" => Ok(self.stats()),
            _ => bail!("Unsupported MCP session sidecar method: {method}"),
        }
    }

    fn session_for(
        &mut self,
        server: McpServerConfig,
        options: &McpSidecarOptions,
    ) -> Result<&mut McpStdioSession> {
        let key = mcp_server_key(&server);
        let replace = self
            .sessions
            .get_mut(&key)
            .map(|session| session.is_closed())
            .unwrap_or(true);
        if replace {
            self.sessions
                .insert(key.clone(), McpStdioSession::spawn(server, options)?);
        }
        let session = self
            .sessions
            .get_mut(&key)
            .context("MCP session was not available after spawn")?;
        session.apply_options(options);
        Ok(session)
    }

    fn close_idle(&mut self, max_idle_ms: u64) -> usize {
        let max_idle = Duration::from_millis(max_idle_ms);
        let idle_keys: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| session.last_used.elapsed() >= max_idle)
            .map(|(key, _)| key.clone())
            .collect();
        let closed = idle_keys.len();
        for key in idle_keys {
            if let Some(mut session) = self.sessions.remove(&key) {
                session.close();
            }
        }
        closed
    }

    fn close_all(&mut self) {
        for (_, mut session) in self.sessions.drain() {
            session.close();
        }
    }

    fn stats(&self) -> Value {
        let items: Vec<Value> = self.sessions.values().map(McpStdioSession::stats).collect();
        let total_requests: u64 = items
            .iter()
            .map(|item| item.get("requests").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let total_responses: u64 = items
            .iter()
            .map(|item| item.get("responses").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let total_failures: u64 = items
            .iter()
            .map(|item| item.get("failures").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let total_timeouts: u64 = items
            .iter()
            .map(|item| item.get("timeouts").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        let total_backpressure_rejects: u64 = items
            .iter()
            .map(|item| {
                item.get("backpressureRejects")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            })
            .sum();
        let max_pending_observed = items
            .iter()
            .filter_map(|item| item.get("maxPendingObserved").and_then(Value::as_u64))
            .max()
            .unwrap_or(0);
        json!({
            "sessions": self.sessions.len(),
            "activeSessions": items.iter().filter(|item| item.get("closed").and_then(Value::as_bool) == Some(false)).count(),
            "totalPending": 0,
            "totalRequests": total_requests,
            "totalResponses": total_responses,
            "totalFailures": total_failures,
            "totalTimeouts": total_timeouts,
            "totalBackpressureRejects": total_backpressure_rejects,
            "maxPendingObserved": max_pending_observed,
            "items": items
        })
    }

    fn stats_with_runtime(&self, runtime: &McpSidecarRuntimeStats) -> Value {
        runtime.apply(self.stats())
    }
}

impl McpSidecarRuntimeStats {
    fn from_env() -> Self {
        let max_active_requests = env::var("VIBELINK_MCP_SESSION_SIDECAR_MAX_ACTIVE_REQUESTS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(64);
        Self {
            active_requests: AtomicUsize::new(0),
            max_active_observed: AtomicUsize::new(0),
            backpressure_rejects: AtomicUsize::new(0),
            max_active_requests,
        }
    }

    fn try_acquire(&self) -> bool {
        loop {
            let current = self.active_requests.load(Ordering::SeqCst);
            if current >= self.max_active_requests {
                self.backpressure_rejects.fetch_add(1, Ordering::SeqCst);
                return false;
            }
            if self
                .active_requests
                .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                self.record_max_active(current + 1);
                return true;
            }
        }
    }

    fn release(&self) {
        self.active_requests.fetch_sub(1, Ordering::SeqCst);
    }

    fn record_max_active(&self, observed: usize) {
        let mut current = self.max_active_observed.load(Ordering::SeqCst);
        while observed > current {
            match self.max_active_observed.compare_exchange(
                current,
                observed,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(next) => current = next,
            }
        }
    }

    fn apply(&self, mut value: Value) -> Value {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "activeRequests".to_string(),
                json!(self.active_requests.load(Ordering::SeqCst)),
            );
            object.insert(
                "maxActiveObserved".to_string(),
                json!(self.max_active_observed.load(Ordering::SeqCst)),
            );
            object.insert(
                "sidecarBackpressureRejects".to_string(),
                json!(self.backpressure_rejects.load(Ordering::SeqCst)),
            );
            object.insert(
                "maxActiveRequests".to_string(),
                json!(self.max_active_requests),
            );
        }
        value
    }
}

impl McpStdioSession {
    fn spawn(server: McpServerConfig, options: &McpSidecarOptions) -> Result<Self> {
        if server.command.trim().is_empty() {
            bail!("MCP stdio server command is empty.");
        }

        let mut command = Command::new(&server.command);
        command.args(&server.args);
        if !server.cwd.trim().is_empty() {
            command.current_dir(&server.cwd);
        }
        for (key, value) in &server.env {
            command.env(key, value);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .with_context(|| format!("Failed to spawn MCP stdio server: {}", server.command))?;
        let stdin = child
            .stdin
            .take()
            .context("MCP stdio server stdin was not piped")?;
        let stdout = child
            .stdout
            .take()
            .context("MCP stdio server stdout was not piped")?;
        let (stdout_tx, stdout_rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                if stdout_tx.send(message).is_err() {
                    break;
                }
            }
        });
        let now = now_iso();
        let timeout_ms = options.timeout_ms.or(options.timeout).unwrap_or(10_000);
        let max_pending_requests = options.max_pending_requests.unwrap_or(1).max(1);

        Ok(Self {
            server,
            child,
            stdin,
            stdout_rx,
            closed: false,
            next_id: 1,
            initialized: None,
            tools: None,
            started_at: now.clone(),
            last_used_at: now,
            last_request_at: String::new(),
            last_response_at: String::new(),
            last_failure_at: String::new(),
            last_backpressure_at: String::new(),
            requests: 0,
            responses: 0,
            failures: 0,
            timeouts: 0,
            backpressure_rejects: 0,
            timeout_ms,
            max_pending_requests,
            max_pending_observed: 0,
            last_used: Instant::now(),
        })
    }

    fn ensure_initialized(&mut self) -> Result<Value> {
        if let Some(value) = &self.initialized {
            return Ok(value.clone());
        }
        let result = self.request(
            "initialize",
            Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "vibelink-rust",
                    "version": "0.1.0"
                }
            })),
        )?;
        self.notify("notifications/initialized", None)?;
        self.initialized = Some(result.clone());
        Ok(result)
    }

    fn apply_options(&mut self, options: &McpSidecarOptions) {
        if let Some(timeout_ms) = options.timeout_ms.or(options.timeout) {
            self.timeout_ms = timeout_ms.max(1);
        }
        if let Some(max_pending_requests) = options.max_pending_requests {
            self.max_pending_requests = max_pending_requests.max(1);
        }
    }

    fn list_tools(&mut self) -> Result<Vec<Value>> {
        self.ensure_initialized()?;
        if let Some(tools) = &self.tools {
            let tools = tools.clone();
            self.touch();
            return Ok(tools);
        }
        let result = self.request("tools/list", None)?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.tools = Some(tools.clone());
        Ok(tools)
    }

    fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value> {
        self.ensure_initialized()?;
        self.request(
            "tools/call",
            Some(json!({
                "name": name,
                "arguments": arguments
            })),
        )
    }

    fn notify(&mut self, method: &str, params: Option<Value>) -> Result<()> {
        if self.closed {
            bail!("MCP stdio session is closed.");
        }
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        if let Err(error) = writeln!(self.stdin, "{}", message).and_then(|_| self.stdin.flush()) {
            self.mark_failed();
            return Err(error).context("Failed to write MCP stdio notification");
        }
        self.touch();
        Ok(())
    }

    fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value> {
        if self.closed {
            bail!("MCP stdio session is closed.");
        }
        let id = self.next_id;
        self.next_id += 1;
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        if let Err(error) = writeln!(self.stdin, "{}", message).and_then(|_| self.stdin.flush()) {
            self.mark_failed();
            return Err(error).context(format!("Failed to write MCP stdio request: {method}"));
        }
        self.requests += 1;
        self.max_pending_observed = self.max_pending_observed.max(1);
        self.last_request_at = now_iso();
        self.touch();

        loop {
            let message = match self
                .stdout_rx
                .recv_timeout(Duration::from_millis(self.timeout_ms.max(1)))
            {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => {
                    self.timeouts += 1;
                    self.mark_failed();
                    bail!(
                        "MCP stdio request timed out: {method} after {}ms",
                        self.timeout_ms
                    );
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.mark_failed();
                    bail!("MCP stdio session exited before replying to {method}");
                }
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                self.mark_failed();
                bail!(
                    "{}",
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("MCP stdio request failed")
                );
            }
            self.responses += 1;
            self.last_response_at = now_iso();
            self.touch();
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn touch(&mut self) {
        self.last_used = Instant::now();
        self.last_used_at = now_iso();
    }

    fn mark_failed(&mut self) {
        self.failures += 1;
        self.last_failure_at = now_iso();
        self.closed = true;
        let _ = self.child.kill();
    }

    fn is_closed(&mut self) -> bool {
        if self.closed {
            return true;
        }
        match self.child.try_wait() {
            Ok(Some(_)) => {
                self.closed = true;
                true
            }
            Ok(None) => false,
            Err(_) => {
                self.closed = true;
                true
            }
        }
    }

    fn close(&mut self) {
        self.closed = true;
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn stats(&self) -> Value {
        json!({
            "id": if self.server.id.is_empty() { &self.server.name } else { &self.server.id },
            "name": if self.server.name.is_empty() { &self.server.id } else { &self.server.name },
            "closed": self.closed,
            "pending": 0,
            "maxPendingRequests": self.max_pending_requests,
            "maxPendingObserved": self.max_pending_observed,
            "timeoutMs": self.timeout_ms,
            "requests": self.requests,
            "responses": self.responses,
            "failures": self.failures,
            "timeouts": self.timeouts,
            "backpressureRejects": self.backpressure_rejects,
            "toolsCached": self.tools.is_some(),
            "toolCount": self.tools.as_ref().map(Vec::len).unwrap_or(0),
            "startedAt": self.started_at,
            "lastUsedAt": self.last_used_at,
            "lastRequestAt": self.last_request_at,
            "lastResponseAt": self.last_response_at,
            "lastFailureAt": self.last_failure_at,
            "lastBackpressureAt": self.last_backpressure_at,
            "stderr": ""
        })
    }
}
