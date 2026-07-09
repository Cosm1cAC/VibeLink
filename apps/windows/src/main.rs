use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use qrcode::{render::unicode, QrCode};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::{
    env,
    hash::{Hash, Hasher},
    net::UdpSocket,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
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

#[derive(Debug, Serialize)]
struct WorkspaceTree {
    ok: bool,
    dir: String,
    truncated: bool,
    signature: String,
    items: Vec<WorkspaceTreeItem>,
}

#[derive(Debug, Serialize)]
struct WorkspaceTreeItem {
    name: String,
    path: String,
    #[serde(rename = "type")]
    kind: String,
    size: u64,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

const IGNORED_WORKSPACE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    "coverage",
    ".agent-mobile-terminal",
];

fn run_workspace_tree(root: &Path, dir: &Path, depth: usize, max_entries: usize) -> Result<()> {
    let tree = list_workspace_tree(root, dir, depth, max_entries)?;
    println!("{}", serde_json::to_string_pretty(&tree)?);
    Ok(())
}

fn list_workspace_tree(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_entries: usize,
) -> Result<WorkspaceTree> {
    let root = root
        .canonicalize()
        .with_context(|| format!("Cannot resolve workspace root {}", root.display()))?;
    let target = safe_workspace_child(&root, dir)?;
    if !target.is_dir() {
        bail!(
            "Workspace tree path must be a directory: {}",
            target.display()
        );
    }

    let mut items = Vec::new();
    let mut signature_parts = Vec::new();
    let mut truncated = false;
    let mut queue = VecDeque::from([(target.clone(), 0usize, gitignore_rules_for_dir(&root))]);
    let max_entries = max_entries.max(1);
    let depth = depth.max(1);

    while let Some((current, current_depth, inherited_rules)) = queue.pop_front() {
        if items.len() >= max_entries {
            truncated = true;
            break;
        }

        let mut ignore_rules = inherited_rules;
        signature_parts.push(metadata_signature_part("dir", &root, &current));
        signature_parts.push(metadata_signature_part(
            "gitignore",
            &root,
            &current.join(".gitignore"),
        ));
        if current != root {
            ignore_rules.extend(gitignore_rules_for_dir(&current));
        }

        let mut children = Vec::new();
        for entry in std::fs::read_dir(&current)
            .with_context(|| format!("Cannot read {}", current.display()))?
        {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry.file_type()?;
            if name.starts_with('.') && name != ".env" {
                continue;
            }
            if file_type.is_dir() && IGNORED_WORKSPACE_DIRS.contains(&name.as_str()) {
                continue;
            }
            if ignore_rules.is_ignored(&name, file_type.is_dir()) {
                continue;
            }
            children.push((name, entry.path(), file_type.is_dir()));
        }

        children.sort_by(|a, b| {
            b.2.cmp(&a.2)
                .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
        });

        for (name, full_path, is_dir) in children {
            if items.len() >= max_entries {
                truncated = true;
                break;
            }
            let metadata = std::fs::metadata(&full_path)?;
            let rel = slash_path(full_path.strip_prefix(&root).unwrap_or(&full_path));
            signature_parts.push(metadata_signature_part("entry", &root, &full_path));
            items.push(WorkspaceTreeItem {
                name,
                path: rel,
                kind: if is_dir { "directory" } else { "file" }.to_string(),
                size: metadata.len(),
                updated_at: system_time_iso(metadata.modified().ok()),
            });
            if is_dir && current_depth + 1 < depth {
                queue.push_back((full_path, current_depth + 1, ignore_rules.clone()));
            }
        }
    }

    Ok(WorkspaceTree {
        ok: true,
        dir: slash_path(target.strip_prefix(&root).unwrap_or(Path::new(""))),
        truncated,
        signature: scan_signature(&signature_parts),
        items,
    })
}

fn metadata_signature_part(kind: &str, root: &Path, path: &Path) -> String {
    let rel = slash_path(path.strip_prefix(root).unwrap_or(path));
    match std::fs::metadata(path) {
        Ok(metadata) => {
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            format!(
                "{kind}:{rel}:{}:{}:{modified_ms}",
                if metadata.is_dir() { "d" } else { "f" },
                metadata.len()
            )
        }
        Err(_) => format!("{kind}:{rel}:missing"),
    }
}

fn scan_signature(parts: &[String]) -> String {
    let mut hasher = Fnv64::default();
    for part in parts {
        part.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

#[derive(Default)]
struct Fnv64(u64);

impl Hasher for Fnv64 {
    fn write(&mut self, bytes: &[u8]) {
        if self.0 == 0 {
            self.0 = 0xcbf29ce484222325;
        }
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

#[derive(Clone, Debug, Default)]
struct WorkspaceIgnoreRules {
    rules: Vec<WorkspaceIgnoreRule>,
}

#[derive(Clone, Debug)]
struct WorkspaceIgnoreRule {
    pattern: String,
    directory_only: bool,
    negated: bool,
}

impl WorkspaceIgnoreRules {
    fn extend(&mut self, other: WorkspaceIgnoreRules) {
        self.rules.extend(other.rules);
    }

    fn is_ignored(&self, name: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.directory_only && !is_dir {
                continue;
            }
            if gitignore_basename_matches(&rule.pattern, name) {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

fn gitignore_rules_for_dir(dir: &Path) -> WorkspaceIgnoreRules {
    let mut rules = WorkspaceIgnoreRules::default();
    let Ok(content) = std::fs::read_to_string(dir.join(".gitignore")) else {
        return rules;
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let negated = trimmed.starts_with('!');
        let body = if negated {
            trimmed[1..].trim()
        } else {
            trimmed
        };
        if body.is_empty() {
            continue;
        }
        let directory_only = body.ends_with('/');
        let pattern = body.trim_start_matches('/').trim_end_matches('/');
        if pattern.is_empty() || pattern.contains('/') {
            continue;
        }
        rules.rules.push(WorkspaceIgnoreRule {
            pattern: pattern.to_string(),
            directory_only,
            negated,
        });
    }

    rules
}

fn gitignore_basename_matches(pattern: &str, name: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == name;
    }
    if pattern == "*" {
        return true;
    }

    let mut remaining = name;
    let mut parts = pattern.split('*').peekable();
    let mut first_part = true;

    while let Some(part) = parts.next() {
        if part.is_empty() {
            first_part = false;
            continue;
        }
        if first_part && !pattern.starts_with('*') {
            let Some(next_remaining) = remaining.strip_prefix(part) else {
                return false;
            };
            remaining = next_remaining;
        } else if parts.peek().is_none() && !pattern.ends_with('*') {
            return remaining.ends_with(part);
        } else {
            let Some(index) = remaining.find(part) else {
                return false;
            };
            remaining = &remaining[index + part.len()..];
        }
        first_part = false;
    }

    pattern.ends_with('*') || remaining.is_empty()
}

fn safe_workspace_child(root: &Path, child: &Path) -> Result<PathBuf> {
    let mut target = PathBuf::from(root);
    for component in child.components() {
        match component {
            std::path::Component::Normal(part) => target.push(part),
            std::path::Component::CurDir => {}
            _ => bail!("Path is outside workspace: {}", child.display()),
        }
    }
    let canonical = target
        .canonicalize()
        .with_context(|| format!("Cannot resolve {}", target.display()))?;
    if !canonical.starts_with(root) {
        bail!("Path is outside workspace: {}", child.display());
    }
    Ok(canonical)
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn system_time_iso(value: Option<std::time::SystemTime>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    let datetime: DateTime<Utc> = value.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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
        Mode::WorkspaceTree {
            root,
            dir,
            depth,
            max_entries,
        } => run_workspace_tree(&root, &dir, depth, max_entries),
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
    use std::fs;

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
    #[test]
    fn workspace_tree_lists_directories_first_and_skips_heavy_dirs() {
        let root = env::temp_dir().join(format!("vibelink-workspace-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("tmp-cache")).unwrap();
        fs::write(root.join(".gitignore"), "tmp-cache/\n").unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("node_modules").join("noise.js"), "ignored").unwrap();
        fs::write(root.join("target").join("noise.txt"), "ignored").unwrap();
        fs::write(root.join("tmp-cache").join("noise.txt"), "ignored").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();

        let names: Vec<_> = tree.items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"]);
        assert_eq!(tree.items[0].kind, "directory");
        assert_eq!(tree.items[1].kind, "file");
        assert!(tree.items[1].updated_at.contains("T"));
        assert!(tree
            .items
            .iter()
            .all(|item| !item.path.starts_with("node_modules")));
        assert!(tree
            .items
            .iter()
            .all(|item| !item.path.starts_with("target")));
        assert!(tree
            .items
            .iter()
            .all(|item| !item.path.starts_with("tmp-cache")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_honors_root_gitignore_file_patterns() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-gitignore-files-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(root.join(".gitignore"), "*.log\nsecrets.local\nlogs/\n").unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();
        fs::write(root.join("debug.log"), "ignored").unwrap();
        fs::write(root.join("secrets.local"), "ignored").unwrap();
        fs::write(root.join("logs").join("debug.txt"), "ignored").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();

        let names: Vec<_> = tree.items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["README.md"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_honors_gitignore_negation_rules() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-gitignore-negation-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".gitignore"), "*.log\n!keep.log\n").unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();
        fs::write(root.join("debug.log"), "ignored").unwrap();
        fs::write(root.join("keep.log"), "kept").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();

        let names: Vec<_> = tree.items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["keep.log", "README.md"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_honors_nested_gitignore_rules() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-nested-gitignore-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src").join("private")).unwrap();
        fs::write(
            root.join("src").join(".gitignore"),
            "generated.tmp\nprivate/\n",
        )
        .unwrap();
        fs::write(root.join("src").join("README.md"), "hello").unwrap();
        fs::write(root.join("src").join("generated.tmp"), "ignored").unwrap();
        fs::write(root.join("src").join("private").join("note.txt"), "ignored").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 2, 20).unwrap();

        let paths: Vec<_> = tree.items.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(paths, vec!["src", "src/README.md"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_marks_truncated_when_max_entries_is_reached() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-truncated-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        fs::write(root.join("c.txt"), "c").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 1, 2).unwrap();

        assert_eq!(tree.items.len(), 2);
        assert!(tree.truncated);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_tree_signature_changes_when_metadata_changes() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-signature-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "hello").unwrap();

        let first = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();
        fs::write(root.join("README.md"), "hello with more bytes").unwrap();
        let second = list_workspace_tree(&root, Path::new(""), 1, 20).unwrap();

        assert!(!first.signature.is_empty());
        assert_ne!(first.signature, second.signature);

        let _ = fs::remove_dir_all(&root);
    }
}
