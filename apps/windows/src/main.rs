use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use qrcode::{render::unicode, QrCode};
use serde::{Deserialize, Serialize};
use std::{
    env,
    net::UdpSocket,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Parser)]
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
    }
}

fn run_user_entry(cli: &Cli) -> Result<()> {
    println!("Starting VibeLink bridge on {}:{}", cli.host, cli.port);
    let mut bridge = spawn_bridge_role(cli)?;
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

    let status = bridge.wait().context("Bridge role failed to exit cleanly")?;
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

    let mut command = Command::new("node");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .arg(&server)
        .current_dir(&root)
        .env("MOBILE_AGENT_HOST", &cli.host)
        .env("MOBILE_AGENT_PORT", cli.port.to_string())
        .stdin(Stdio::null());

    let status = command
        .spawn()
        .context("Failed to launch Node bridge. Is node.exe on PATH?")?
        .wait()
        .context("Failed while waiting for Node bridge")?;

    if !status.success() {
        bail!("Node bridge exited with status {status}");
    }
    Ok(())
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
        .arg(cli.port.to_string())
        .arg("bridge")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn().context("Failed to start bridge role")
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

    response.session.context("Bridge response did not include a pairing session")
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

    let cwd = env::current_dir().context("Cannot read current directory")?;
    if let Some(root) = find_project_root_from(&cwd) {
        return Ok(root);
    }

    let exe = env::current_exe().context("Cannot resolve current executable path")?;
    if let Some(parent) = exe.parent() {
        if let Some(root) = find_project_root_from(parent) {
            return Ok(root);
        }
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

