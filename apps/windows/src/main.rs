use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use qrcode::{render::unicode, QrCode};
use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsString,
    net::{SocketAddr, TcpListener, UdpSocket},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

mod audio_pipeline_sidecar;
mod audit_http;
mod compression_sidecar;
mod device_http;
mod doctor_http;
mod event_store_sidecar;
mod event_sync_http;
mod execution_host;
mod http_frontdoor;
mod mcp_session_sidecar;
mod pairing_http;
mod public_tunnel;
mod settings_contract;
mod settings_credentials;
mod settings_http;
mod sidecar_protocol;
mod status_http;
mod status_sidecar;
mod tool_events_http;
mod tool_events_store;
mod workspace_http;
mod workspace_tree;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Parser)]
#[command(name = "vibelink", version, about = "VibeLink Windows single entry")]
struct Cli {
    #[command(subcommand)]
    command: Option<Mode>,

    #[arg(long, global = true, default_value = "0.0.0.0")]
    host: String,

    #[arg(long, global = true, default_value_t = 8787)]
    port: u16,

    #[arg(long, global = true, default_value = "VibeLink Windows")]
    device_label: String,

    #[arg(long, global = true)]
    rust_canary: bool,

    #[arg(long, global = true)]
    rust_http_canary: bool,

    #[arg(long, global = true)]
    rust_status_http: bool,

    #[arg(long, global = true)]
    rust_doctor_http: bool,

    #[arg(long, global = true)]
    rust_devices_http: bool,

    #[arg(long, global = true)]
    rust_device_mutations_http: bool,

    #[arg(long, global = true)]
    rust_pairing_http: bool,

    #[arg(long, global = true)]
    rust_audit_http: bool,

    #[arg(long, global = true)]
    rust_settings_http: bool,

    #[arg(long, global = true)]
    rust_tool_events_http: bool,

    #[arg(long, global = true)]
    rust_tool_events_sse: bool,

    #[arg(long, global = true)]
    rust_event_sync_http: bool,

    #[arg(long, global = true)]
    rust_workspace_http: bool,
}

#[derive(Debug, Clone, Subcommand)]
enum Mode {
    /// User-facing default mode: supervise bridge and show pairing QR.
    Run,
    /// Internal role: host the existing bridge process.
    Bridge,
    /// Create and print a QR pairing session for a running bridge.
    Pair,
    /// Check bridge health.
    Doctor,
    /// Validate or run a fixed, allowlisted Cloudflare Tunnel.
    Tunnel {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        settings: Option<PathBuf>,
        #[arg(long)]
        check_only: bool,
    },
    /// List a workspace directory using the Rust filesystem scanner.
    WorkspaceTree {
        #[arg(long)]
        root: PathBuf,
        #[arg(long, default_value = "")]
        dir: PathBuf,
        #[arg(long, default_value_t = 1)]
        depth: usize,
        #[arg(long = "max-entries", default_value_t = 240)]
        max_entries: usize,
    },
    /// Run the persistent workspace tree JSONL sidecar.
    WorkspaceTreeSidecar,
    /// Run the MCP stdio session JSONL sidecar.
    McpSessionSidecar,
    /// Run the event-store SQLite JSONL sidecar.
    EventStoreSidecar {
        #[arg(value_name = "DB_PATH")]
        db_path: PathBuf,
        #[arg(long)]
        read_only: bool,
    },
    /// Run the deterministic compression helper JSONL sidecar.
    CompressionSidecar,
    /// Validate and assemble status snapshots as a persistent JSONL sidecar.
    StatusSidecar,
    /// Run deterministic PCM preprocessing as a bounded JSONL sidecar.
    AudioPipelineSidecar {
        #[arg(long = "max-buffered-samples", default_value_t = 48_000)]
        max_buffered_samples: usize,
        #[arg(long = "max-samples-per-chunk", default_value_t = 8_192)]
        max_samples_per_chunk: usize,
    },
    /// Run the durable local execution router and worker discovery daemon.
    Execd {
        #[arg(long)]
        data_dir: Option<PathBuf>,
        #[arg(long)]
        pipe: Option<String>,
    },
    /// Internal role: own one execution and its OS process handles.
    #[command(hide = true)]
    ExecutionWorker {
        #[arg(long)]
        bootstrap: PathBuf,
    },
}

#[derive(Debug, Serialize)]
struct CreatePairingRequest<'a> {
    #[serde(rename = "deviceLabel")]
    device_label: &'a str,
    #[serde(rename = "trustLocalLauncher")]
    trust_local_launcher: bool,
}

#[derive(Debug, Deserialize)]
struct CreatePairingResponse {
    ok: bool,
    session: Option<PairingSession>,
}

#[derive(Debug, Deserialize)]
struct PairingSession {
    id: String,
    code: String,
    status: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("VibeLink failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command.clone().unwrap_or(Mode::Run) {
        Mode::Run => run_user_entry(&cli),
        Mode::Bridge => run_bridge_role(&cli),
        Mode::Pair => run_pairing_flow(&cli),
        Mode::Doctor => run_doctor(&cli),
        Mode::Tunnel {
            config,
            settings,
            check_only,
        } => public_tunnel::run(config.as_deref(), settings.as_deref(), check_only),
        Mode::WorkspaceTree {
            root,
            dir,
            depth,
            max_entries,
        } => workspace_tree::run(&root, &dir, depth, max_entries),
        Mode::WorkspaceTreeSidecar => workspace_tree::run_sidecar(),
        Mode::McpSessionSidecar => mcp_session_sidecar::run(),
        Mode::EventStoreSidecar { db_path, read_only } => {
            event_store_sidecar::run(&db_path, read_only)
        }
        Mode::CompressionSidecar => compression_sidecar::run(),
        Mode::StatusSidecar => status_sidecar::run(),
        Mode::AudioPipelineSidecar {
            max_buffered_samples,
            max_samples_per_chunk,
        } => audio_pipeline_sidecar::run(max_buffered_samples, max_samples_per_chunk),
        Mode::Execd { data_dir, pipe } => {
            let root = project_root()?;
            let data_dir = data_dir.unwrap_or_else(|| {
                resolve_data_dir(
                    &root,
                    env::var_os("VIBELINK_DATA_DIR"),
                    env::var_os("LOCALAPPDATA"),
                    Path::exists,
                )
            });
            execution_host::run_execd(&data_dir, pipe.as_deref())
        }
        Mode::ExecutionWorker { bootstrap } => execution_host::run_worker(&bootstrap),
    }
}

fn run_user_entry(cli: &Cli) -> Result<()> {
    println!("Starting VibeLink bridge on {}:{}", cli.host, cli.port);
    let effective_cli = default_rust_profile(cli);
    let mut bridge = spawn_bridge_role(&effective_cli)?;
    let base_url = local_base_url(cli.port);

    if let Err(error) = wait_for_bridge(&base_url, Duration::from_secs(30)) {
        let _ = bridge.kill();
        return Err(error);
    }

    println!("Bridge is ready: {base_url}");
    let pairing_base_url = pairing_base_url(cli.port);
    println!("Android pairing URL base: {pairing_base_url}");
    print_pairing_qr(&base_url, &pairing_base_url, &cli.device_label)?;
    println!();
    println!("Development mode: keep this process open to keep the supervised bridge running.");
    println!("Next milestone: replace this console surface with a native Windows tray/window.");

    let status = bridge
        .wait()
        .context("Bridge role failed to exit cleanly")?;
    if !status.success() {
        bail!("Bridge role exited with status {status}");
    }
    Ok(())
}

fn run_bridge_role(cli: &Cli) -> Result<()> {
    let root = project_root()?;
    let server = root.join("src").join("server.js");
    if !server.exists() {
        bail!("Cannot find bridge server at {}", server.display());
    }

    if cli.rust_http_canary {
        return run_rust_http_frontdoor(cli, &root, &server);
    }

    let plan = node_bridge_plan(cli, cli.port);
    let status = spawn_node_bridge(cli, &root, &server, &plan, None)?
        .wait()
        .context("Failed while waiting for Node bridge")?;

    if !status.success() {
        bail!("Node bridge exited with status {status}");
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct NodeBridgeBinding {
    host: String,
    port: u16,
}

#[derive(Debug, PartialEq, Eq)]
struct NodeBridgePlan {
    persisted: NodeBridgeBinding,
    runtime: NodeBridgeBinding,
}

fn node_bridge_plan(cli: &Cli, internal_port: u16) -> NodeBridgePlan {
    let persisted = NodeBridgeBinding {
        host: cli.host.clone(),
        port: cli.port,
    };
    let runtime = if cli.rust_http_canary {
        NodeBridgeBinding {
            host: "127.0.0.1".to_string(),
            port: internal_port,
        }
    } else {
        NodeBridgeBinding {
            host: persisted.host.clone(),
            port: persisted.port,
        }
    };
    NodeBridgePlan { persisted, runtime }
}

fn rust_status_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_status_http
}

fn rust_doctor_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_doctor_http
}

fn rust_devices_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_devices_http
}

fn rust_device_mutations_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_device_mutations_http
}

fn rust_pairing_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_pairing_http
}

fn rust_audit_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_audit_http
}

fn rust_settings_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_settings_http
}

fn rust_tool_events_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_tool_events_http
}

fn rust_tool_events_sse_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_tool_events_sse
}

fn rust_event_sync_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_event_sync_http
}

fn default_rust_profile(cli: &Cli) -> Cli {
    let mut effective = cli.clone();
    effective.rust_canary = true;
    effective.rust_http_canary = true;
    effective.rust_status_http = true;
    effective.rust_doctor_http = true;
    effective.rust_devices_http = true;
    effective.rust_device_mutations_http = true;
    effective.rust_pairing_http = true;
    effective.rust_audit_http = true;
    effective.rust_settings_http = true;
    effective.rust_tool_events_http = true;
    effective.rust_tool_events_sse = true;
    effective.rust_event_sync_http = true;
    effective.rust_workspace_http = true;
    effective
}

fn rust_workspace_http_enabled(cli: &Cli) -> bool {
    cli.rust_http_canary && cli.rust_workspace_http
}

fn reserve_loopback_port() -> Result<u16> {
    let reservation = TcpListener::bind(("127.0.0.1", 0))
        .context("Failed to reserve loopback port for Node bridge")?;
    Ok(reservation
        .local_addr()
        .context("Failed to inspect reserved loopback port")?
        .port())
}

fn run_rust_http_frontdoor(cli: &Cli, root: &Path, server: &Path) -> Result<()> {
    let listener = TcpListener::bind((cli.host.as_str(), cli.port)).with_context(|| {
        format!(
            "Failed to bind Rust HTTP front door on {}:{}",
            cli.host, cli.port
        )
    })?;
    let internal_port = reserve_loopback_port()?;
    let plan = node_bridge_plan(cli, internal_port);
    let upstream = SocketAddr::from(([127, 0, 0, 1], plan.runtime.port));
    let internal_token = (rust_status_http_enabled(cli)
        || rust_doctor_http_enabled(cli)
        || rust_pairing_http_enabled(cli)
        || rust_settings_http_enabled(cli))
    .then(generate_internal_control_token)
    .transpose()?;
    let route_data_dir = resolve_data_dir(
        root,
        env::var_os("VIBELINK_DATA_DIR"),
        env::var_os("LOCALAPPDATA"),
        Path::exists,
    );
    let status_route = if rust_status_http_enabled(cli) {
        Some(status_http::StatusRouteConfig::new(
            route_data_dir.clone(),
            upstream,
            internal_token
                .clone()
                .context("Status route internal token is missing")?,
        ))
    } else {
        None
    };
    let doctor_route = if rust_doctor_http_enabled(cli) {
        Some(doctor_http::DoctorRouteConfig::new(
            route_data_dir.clone(),
            upstream,
            internal_token
                .clone()
                .context("Doctor route internal token is missing")?,
        ))
    } else {
        None
    };
    let device_route = rust_devices_http_enabled(cli)
        .then(|| device_http::DeviceRouteConfig::new(route_data_dir.clone()));
    let device_mutation_route = rust_device_mutations_http_enabled(cli)
        .then(|| device_http::DeviceMutationRouteConfig::new(route_data_dir.clone()));
    let audit_route = rust_audit_http_enabled(cli)
        .then(|| audit_http::AuditRouteConfig::new(route_data_dir.clone()));
    let tool_events_route = rust_tool_events_http_enabled(cli)
        .then(|| tool_events_http::ToolEventsRouteConfig::new(route_data_dir.clone()));
    let tool_events_sse_route = rust_tool_events_sse_enabled(cli)
        .then(|| tool_events_http::ToolEventsRouteConfig::new(route_data_dir.clone()));
    let event_sync_route = rust_event_sync_http_enabled(cli)
        .then(|| event_sync_http::EventSyncRouteConfig::new(route_data_dir.clone()));
    let workspace_route = rust_workspace_http_enabled(cli)
        .then(|| workspace_http::WorkspaceRouteConfig::new(route_data_dir.clone()));
    let settings_route = if rust_settings_http_enabled(cli) {
        Some(
            settings_http::SettingsRouteConfig::new(route_data_dir.clone(), root.to_path_buf())
                .with_internal_settings(
                    upstream,
                    internal_token
                        .clone()
                        .context("Settings route internal token is missing")?,
                ),
        )
    } else {
        None
    };
    let pairing_route = if rust_pairing_http_enabled(cli) {
        Some(
            pairing_http::PairingRouteConfig::new(route_data_dir.clone()).with_internal_settings(
                upstream,
                internal_token
                    .clone()
                    .context("Pairing route internal token is missing")?,
            ),
        )
    } else {
        None
    };
    let mut node = spawn_node_bridge(cli, root, server, &plan, internal_token.as_deref())?;

    println!(
        "Rust HTTP front door listening on {}:{}; Node backend is loopback-only on {}",
        cli.host, cli.port, upstream
    );
    let routes = http_frontdoor::FrontdoorRoutes::default()
        .with_status(status_route)
        .with_doctor(doctor_route)
        .with_device(device_route)
        .with_device_mutation(device_mutation_route)
        .with_audit(audit_route)
        .with_tool_events(tool_events_route)
        .with_tool_events_sse(tool_events_sse_route)
        .with_event_sync(event_sync_route)
        .with_settings(settings_route)
        .with_pairing(pairing_route);
    let routes = routes.with_workspace(workspace_route);
    let result = http_frontdoor::serve(listener, upstream, &mut node, routes);
    if node
        .try_wait()
        .context("Failed to inspect Node bridge after front-door shutdown")?
        .is_none()
    {
        let _ = node.kill();
        let _ = node.wait();
    }
    result
}

fn spawn_node_bridge(
    cli: &Cli,
    root: &Path,
    server: &Path,
    plan: &NodeBridgePlan,
    internal_control_token: Option<&str>,
) -> Result<Child> {
    let executable = env::current_exe().context("Cannot resolve current executable path")?;
    let data_dir = resolve_data_dir(
        root,
        env::var_os("VIBELINK_DATA_DIR"),
        env::var_os("LOCALAPPDATA"),
        Path::exists,
    );
    let mut command = Command::new(resolve_node_command(
        root,
        env::var_os("VIBELINK_NODE_COMMAND"),
        Path::exists,
    ));
    for (key, value) in missing_sidecar_command_envs(&executable, |key| env::var_os(key)) {
        command.env(key, value);
    }
    for (key, value) in missing_rust_canary_envs(cli.rust_canary, |key| env::var_os(key)) {
        command.env(key, value);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .arg(server)
        .current_dir(root)
        .env("VIBELINK_DATA_DIR", data_dir)
        .env("VIBELINK_SUPERVISOR_PID", std::process::id().to_string())
        .env("MOBILE_AGENT_HOST", &plan.persisted.host)
        .env("MOBILE_AGENT_PORT", plan.persisted.port.to_string())
        .stdin(Stdio::null());

    if cli.rust_http_canary {
        command
            .env("VIBELINK_RUNTIME_HOST", &plan.runtime.host)
            .env("VIBELINK_RUNTIME_PORT", plan.runtime.port.to_string());
    }
    if let Some(token) = internal_control_token {
        command.env("VIBELINK_INTERNAL_CONTROL_TOKEN", token);
    }

    command
        .spawn()
        .context("Failed to launch Node bridge. Is node.exe on PATH?")
}

fn missing_sidecar_command_envs<F>(
    executable: &Path,
    mut existing: F,
) -> Vec<(&'static str, OsString)>
where
    F: FnMut(&str) -> Option<OsString>,
{
    [
        "VIBELINK_MCP_RUST_SIDECAR_COMMAND",
        "VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND",
        "VIBELINK_CONTROL_PLANE_RUST_SIDECAR_COMMAND",
        "VIBELINK_RUST_BIN",
    ]
    .into_iter()
    .filter(|key| existing(key).is_none())
    .map(|key| (key, executable.as_os_str().to_os_string()))
    .collect()
}

fn missing_rust_canary_envs<F>(enabled: bool, mut existing: F) -> Vec<(&'static str, OsString)>
where
    F: FnMut(&str) -> Option<OsString>,
{
    if !enabled {
        return Vec::new();
    }
    [
        ("VIBELINK_RUST_STATUS", "1"),
        ("VIBELINK_RUST_WORKSPACE_TREE", "auto"),
        ("VIBELINK_RUST_WORKSPACE_TREE_SESSION", "auto"),
        ("VIBELINK_MCP_RUST_SIDECAR", "auto"),
        ("VIBELINK_MCP_PERSISTENT_SESSIONS", "1"),
        ("VIBELINK_EVENT_STORE_RUST_SIDECAR", "auto"),
        ("VIBELINK_EVENT_STORE_BATCH_APPEND", "1"),
        ("VIBELINK_EVENT_STORE_BATCH_TASK_APPEND", "1"),
        ("VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND", "1"),
    ]
    .into_iter()
    .filter(|(key, _)| existing(key).is_none())
    .map(|(key, value)| (key, OsString::from(value)))
    .collect()
}

fn resolve_node_command<F>(root: &Path, configured: Option<OsString>, mut exists: F) -> OsString
where
    F: FnMut(&Path) -> bool,
{
    if let Some(command) = configured.filter(|value| !value.is_empty()) {
        return command;
    }
    let bundled = root.join("runtime").join("node.exe");
    if exists(&bundled) {
        return bundled.into_os_string();
    }
    OsString::from("node")
}

fn resolve_data_dir<F>(
    root: &Path,
    configured: Option<OsString>,
    local_app_data: Option<OsString>,
    mut exists: F,
) -> PathBuf
where
    F: FnMut(&Path) -> bool,
{
    if let Some(path) = configured.filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    if exists(&root.join("runtime").join("node.exe")) {
        if let Some(local) = local_app_data.filter(|value| !value.is_empty()) {
            return PathBuf::from(local).join("VibeLink");
        }
    }
    root.join(".agent-mobile-terminal")
}

fn run_pairing_flow(cli: &Cli) -> Result<()> {
    let base_url = local_base_url(cli.port);
    wait_for_bridge(&base_url, Duration::from_secs(3))?;
    let pairing_base_url = pairing_base_url(cli.port);
    print_pairing_qr(&base_url, &pairing_base_url, &cli.device_label)
}

fn run_doctor(cli: &Cli) -> Result<()> {
    let base_url = local_base_url(cli.port);
    wait_for_bridge(&base_url, Duration::from_secs(3))?;
    println!("Bridge reachable: {base_url}");
    Ok(())
}

fn spawn_bridge_role(cli: &Cli) -> Result<Child> {
    let exe = env::current_exe().context("Cannot resolve current executable path")?;
    let mut command = Command::new(exe);
    command
        .arg("--host")
        .arg(&cli.host)
        .arg("--port")
        .arg(cli.port.to_string());
    if cli.rust_canary {
        command.arg("--rust-canary");
    }
    if cli.rust_http_canary {
        command.arg("--rust-http-canary");
    }
    if cli.rust_status_http {
        command.arg("--rust-status-http");
    }
    if cli.rust_doctor_http {
        command.arg("--rust-doctor-http");
    }
    if cli.rust_devices_http {
        command.arg("--rust-devices-http");
    }
    if cli.rust_device_mutations_http {
        command.arg("--rust-device-mutations-http");
    }
    if cli.rust_pairing_http {
        command.arg("--rust-pairing-http");
    }
    if cli.rust_audit_http {
        command.arg("--rust-audit-http");
    }
    if cli.rust_settings_http {
        command.arg("--rust-settings-http");
    }
    if cli.rust_tool_events_http {
        command.arg("--rust-tool-events-http");
    }
    if cli.rust_tool_events_sse {
        command.arg("--rust-tool-events-sse");
    }
    if cli.rust_event_sync_http {
        command.arg("--rust-event-sync-http");
    }
    if cli.rust_workspace_http {
        command.arg("--rust-workspace-http");
    }
    command
        .arg("bridge")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn().context("Failed to start bridge role")
}

fn generate_internal_control_token() -> Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| anyhow::anyhow!("Cannot generate internal Status route token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn print_pairing_qr(api_base_url: &str, pairing_base_url: &str, label: &str) -> Result<()> {
    let session = create_pairing_session(api_base_url, label)?;
    let payload = android_pairing_uri(pairing_base_url, &session);
    let code = QrCode::new(payload.as_bytes()).context("Failed to encode QR payload")?;
    let image = code.render::<unicode::Dense1x2>().quiet_zone(true).build();

    println!();
    println!("Android pairing QR");
    println!("Session: {}", session.id);
    println!("Status: {}", session.status);
    println!("Expires: {}", session.expires_at);
    println!("Payload: {payload}");
    println!("{image}");
    Ok(())
}

fn create_pairing_session(base_url: &str, label: &str) -> Result<PairingSession> {
    let endpoint = format!("{}/api/pairing-sessions", base_url.trim_end_matches('/'));
    let body = CreatePairingRequest {
        device_label: label,
        trust_local_launcher: true,
    };
    let response: CreatePairingResponse = ureq::post(&endpoint)
        .set("Content-Type", "application/json")
        .send_json(serde_json::to_value(body)?)
        .with_context(|| format!("Failed to create pairing session at {endpoint}"))?
        .into_json()
        .context("Failed to parse pairing response")?;

    if !response.ok {
        bail!("Bridge rejected pairing session creation");
    }

    response
        .session
        .context("Bridge response did not include a pairing session")
}

fn android_pairing_uri(base_url: &str, session: &PairingSession) -> String {
    format!(
        "vibelink://pair?server={}&session={}&code={}",
        urlencoding::encode(base_url.trim_end_matches('/')),
        urlencoding::encode(&session.id),
        urlencoding::encode(&session.code)
    )
}

fn wait_for_bridge(base_url: &str, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let endpoint = format!("{}/api/status", base_url.trim_end_matches('/'));

    loop {
        match ureq::get(&endpoint).timeout(Duration::from_secs(2)).call() {
            Ok(response) if response.status() == 200 => return Ok(()),
            Ok(response) if response.status() == 401 => return Ok(()),
            Ok(response) => {
                if Instant::now() >= deadline {
                    bail!("Bridge status returned HTTP {}", response.status());
                }
            }
            Err(ureq::Error::Status(401, _)) => return Ok(()),
            Err(error) => {
                if Instant::now() >= deadline {
                    return Err(error).context("Timed out waiting for bridge status");
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn local_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn pairing_base_url(port: u16) -> String {
    let host = lan_ipv4().unwrap_or_else(|| "127.0.0.1".to_string());
    format!("http://{host}:{port}")
}

fn lan_ipv4() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip().to_string();
    if ip.starts_with("127.") || ip == "0.0.0.0" {
        None
    } else {
        Some(ip)
    }
}
fn project_root() -> Result<PathBuf> {
    if let Ok(root) = env::var("VIBELINK_ROOT") {
        return Ok(PathBuf::from(root));
    }

    let exe = env::current_exe().context("Cannot resolve current executable path")?;
    if let Some(parent) = exe.parent() {
        if let Some(root) = find_project_root_from(parent) {
            return Ok(root);
        }
    }

    let cwd = env::current_dir().context("Cannot read current directory")?;
    if let Some(root) = find_project_root_from(&cwd) {
        return Ok(root);
    }

    bail!("Cannot find VibeLink project root. Set VIBELINK_ROOT to the directory containing src/server.js.")
}

fn find_project_root_from(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|candidate| candidate.join("src").join("server.js").exists())
        .map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn packaged_sidecar_envs_use_current_executable_and_preserve_overrides() {
        let executable = Path::new("C:/Program Files/VibeLink/vibelink.exe");

        let all_values = missing_sidecar_command_envs(executable, |_| None);
        assert_eq!(
            all_values.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
            vec![
                "VIBELINK_MCP_RUST_SIDECAR_COMMAND",
                "VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND",
                "VIBELINK_CONTROL_PLANE_RUST_SIDECAR_COMMAND",
                "VIBELINK_RUST_BIN"
            ]
        );
        assert!(all_values
            .iter()
            .all(|(_, value)| value == executable.as_os_str()));

        let values = missing_sidecar_command_envs(executable, |key| {
            (key == "VIBELINK_MCP_RUST_SIDECAR_COMMAND")
                .then(|| OsString::from("C:/custom/mcp-sidecar.exe"))
        });

        assert_eq!(
            values,
            vec![
                (
                    "VIBELINK_EVENT_STORE_RUST_SIDECAR_COMMAND",
                    executable.as_os_str().to_os_string()
                ),
                (
                    "VIBELINK_CONTROL_PLANE_RUST_SIDECAR_COMMAND",
                    executable.as_os_str().to_os_string()
                ),
                ("VIBELINK_RUST_BIN", executable.as_os_str().to_os_string())
            ]
        );
    }

    #[test]
    fn rust_canary_envs_enable_current_slices_and_preserve_overrides() {
        let values = missing_rust_canary_envs(true, |_| None);
        assert_eq!(
            values,
            vec![
                ("VIBELINK_RUST_STATUS", OsString::from("1")),
                ("VIBELINK_RUST_WORKSPACE_TREE", OsString::from("auto")),
                (
                    "VIBELINK_RUST_WORKSPACE_TREE_SESSION",
                    OsString::from("auto")
                ),
                ("VIBELINK_MCP_RUST_SIDECAR", OsString::from("auto")),
                ("VIBELINK_MCP_PERSISTENT_SESSIONS", OsString::from("1")),
                ("VIBELINK_EVENT_STORE_RUST_SIDECAR", OsString::from("auto")),
                ("VIBELINK_EVENT_STORE_BATCH_APPEND", OsString::from("1")),
                (
                    "VIBELINK_EVENT_STORE_BATCH_TASK_APPEND",
                    OsString::from("1")
                ),
                (
                    "VIBELINK_EVENT_STORE_BATCH_LIVE_CALL_APPEND",
                    OsString::from("1")
                )
            ]
        );

        let overridden = missing_rust_canary_envs(true, |key| {
            (key == "VIBELINK_RUST_STATUS").then(|| OsString::from("0"))
        });
        assert!(overridden
            .iter()
            .all(|(key, _)| *key != "VIBELINK_RUST_STATUS"));
        assert!(missing_rust_canary_envs(false, |_| None).is_empty());
    }

    #[test]
    fn rust_canary_is_an_additive_global_cli_flag() {
        let enabled = Cli::try_parse_from(["vibelink", "--rust-canary", "bridge"]).unwrap();
        assert!(enabled.rust_canary);
        assert!(matches!(enabled.command, Some(Mode::Bridge)));

        let defaulted = Cli::try_parse_from(["vibelink", "bridge"]).unwrap();
        assert!(!defaulted.rust_canary);
    }

    #[test]
    fn user_entry_defaults_to_rust_frontdoor_with_current_route_ownership() {
        let cli = Cli::try_parse_from(["vibelink"]).unwrap();
        let effective = default_rust_profile(&cli);
        assert!(effective.rust_canary);
        assert!(effective.rust_http_canary);
        assert!(effective.rust_status_http);
        assert!(effective.rust_doctor_http);
        assert!(effective.rust_devices_http);
        assert!(effective.rust_device_mutations_http);
        assert!(effective.rust_pairing_http);
        assert!(effective.rust_audit_http);
        assert!(effective.rust_settings_http);
        assert!(effective.rust_tool_events_http);
        assert!(effective.rust_workspace_http);
        assert!(effective.rust_tool_events_sse);
        assert!(effective.rust_event_sync_http);
    }

    #[test]
    fn rust_http_canary_is_additive_and_keeps_node_on_loopback() {
        let enabled = Cli::try_parse_from(["vibelink", "--rust-http-canary", "bridge"]).unwrap();
        assert!(enabled.rust_http_canary);

        let plan = node_bridge_plan(&enabled, 49_152);
        assert_eq!(plan.persisted.host, "0.0.0.0");
        assert_eq!(plan.persisted.port, 8787);
        assert_eq!(plan.runtime.host, "127.0.0.1");
        assert_eq!(plan.runtime.port, 49_152);

        let defaulted =
            Cli::try_parse_from(["vibelink", "--host", "0.0.0.0", "--port", "8787", "bridge"])
                .unwrap();
        assert!(!defaulted.rust_http_canary);

        let plan = node_bridge_plan(&defaulted, 49_152);
        assert_eq!(plan.persisted.host, "0.0.0.0");
        assert_eq!(plan.persisted.port, 8787);
        assert_eq!(plan.runtime, plan.persisted);
    }

    #[test]
    fn rust_status_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-status-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_status_http);
        assert!(rust_status_http_enabled(&enabled));

        let status_only =
            Cli::try_parse_from(["vibelink", "--rust-status-http", "bridge"]).unwrap();
        assert!(status_only.rust_status_http);
        assert!(!rust_status_http_enabled(&status_only));
    }

    #[test]
    fn rust_doctor_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-doctor-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_doctor_http);
        assert!(rust_doctor_http_enabled(&enabled));

        let doctor_only =
            Cli::try_parse_from(["vibelink", "--rust-doctor-http", "bridge"]).unwrap();
        assert!(doctor_only.rust_doctor_http);
        assert!(!rust_doctor_http_enabled(&doctor_only));
    }

    #[test]
    fn rust_devices_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-devices-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_devices_http);
        assert!(rust_devices_http_enabled(&enabled));

        let devices_only =
            Cli::try_parse_from(["vibelink", "--rust-devices-http", "bridge"]).unwrap();
        assert!(devices_only.rust_devices_http);
        assert!(!rust_devices_http_enabled(&devices_only));
    }

    #[test]
    fn rust_device_mutations_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-device-mutations-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_device_mutations_http);
        assert!(rust_device_mutations_http_enabled(&enabled));

        let mutations_only =
            Cli::try_parse_from(["vibelink", "--rust-device-mutations-http", "bridge"]).unwrap();
        assert!(mutations_only.rust_device_mutations_http);
        assert!(!rust_device_mutations_http_enabled(&mutations_only));
    }

    #[test]
    fn rust_pairing_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-pairing-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_pairing_http);
        assert!(rust_pairing_http_enabled(&enabled));

        let pairing_only =
            Cli::try_parse_from(["vibelink", "--rust-pairing-http", "bridge"]).unwrap();
        assert!(pairing_only.rust_pairing_http);
        assert!(!rust_pairing_http_enabled(&pairing_only));
    }

    #[test]
    fn rust_audit_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-audit-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_audit_http);
        assert!(rust_audit_http_enabled(&enabled));

        let audit_only = Cli::try_parse_from(["vibelink", "--rust-audit-http", "bridge"]).unwrap();
        assert!(audit_only.rust_audit_http);
        assert!(!rust_audit_http_enabled(&audit_only));
    }

    #[test]
    fn rust_settings_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-settings-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_settings_http);
        assert!(rust_settings_http_enabled(&enabled));

        let settings_only =
            Cli::try_parse_from(["vibelink", "--rust-settings-http", "bridge"]).unwrap();
        assert!(settings_only.rust_settings_http);
        assert!(!rust_settings_http_enabled(&settings_only));
    }

    #[test]
    fn rust_tool_events_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-tool-events-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_tool_events_http);
        assert!(rust_tool_events_http_enabled(&enabled));

        let route_only =
            Cli::try_parse_from(["vibelink", "--rust-tool-events-http", "bridge"]).unwrap();
        assert!(route_only.rust_tool_events_http);
        assert!(!rust_tool_events_http_enabled(&route_only));
    }

    #[test]
    fn rust_event_sync_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-event-sync-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_event_sync_http);
        assert!(rust_event_sync_http_enabled(&enabled));

        let route_only =
            Cli::try_parse_from(["vibelink", "--rust-event-sync-http", "bridge"]).unwrap();
        assert!(route_only.rust_event_sync_http);
        assert!(!rust_event_sync_http_enabled(&route_only));
    }

    #[test]
    fn rust_workspace_http_requires_the_rust_frontdoor() {
        let enabled = Cli::try_parse_from([
            "vibelink",
            "--rust-http-canary",
            "--rust-workspace-http",
            "bridge",
        ])
        .unwrap();
        assert!(enabled.rust_workspace_http);
        assert!(rust_workspace_http_enabled(&enabled));

        let route_only =
            Cli::try_parse_from(["vibelink", "--rust-workspace-http", "bridge"]).unwrap();
        assert!(!rust_workspace_http_enabled(&route_only));
    }

    #[test]
    fn packaged_node_runtime_precedes_path_and_preserves_override() {
        let root = Path::new("C:/Program Files/VibeLink");
        let bundled = root.join("runtime").join("node.exe");

        assert_eq!(
            resolve_node_command(root, Some(OsString::from("C:/custom/node.exe")), |_| true),
            OsString::from("C:/custom/node.exe")
        );
        assert_eq!(
            resolve_node_command(root, None, |path| path == bundled),
            bundled.as_os_str()
        );
        assert_eq!(
            resolve_node_command(root, None, |_| false),
            OsString::from("node")
        );
    }

    #[test]
    fn packaged_data_dir_uses_local_app_data_and_preserves_override() {
        let root = Path::new("C:/Program Files/VibeLink");
        let local = Path::new("C:/Users/test/AppData/Local");
        assert_eq!(
            resolve_data_dir(
                root,
                Some(OsString::from("D:/VibeLinkData")),
                Some(local.as_os_str().to_os_string()),
                |_| true
            ),
            PathBuf::from("D:/VibeLinkData")
        );
        assert_eq!(
            resolve_data_dir(root, None, Some(local.as_os_str().to_os_string()), |path| {
                path == root.join("runtime").join("node.exe")
            }),
            local.join("VibeLink")
        );
        assert_eq!(
            resolve_data_dir(root, None, Some(local.as_os_str().to_os_string()), |_| {
                false
            }),
            root.join(".agent-mobile-terminal")
        );
    }

    #[test]
    fn android_pairing_uri_uses_deep_link_and_escapes_server() {
        let session = PairingSession {
            id: "session 1".to_string(),
            code: "ABC123".to_string(),
            status: "pending".to_string(),
            expires_at: "2026-07-07T00:00:00.000Z".to_string(),
        };

        let uri = android_pairing_uri("http://192.168.1.10:8787/", &session);

        assert_eq!(
            uri,
            "vibelink://pair?server=http%3A%2F%2F192.168.1.10%3A8787&session=session%201&code=ABC123"
        );
    }
}
