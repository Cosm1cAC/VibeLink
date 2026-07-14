use crate::sidecar_protocol::{
    now_iso, sidecar_arg, write_sidecar_error, write_sidecar_result, SidecarRequest,
};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    hash::{Hash, Hasher},
    io::{self, BufRead},
    path::{Path, PathBuf},
};

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

#[derive(Debug, Deserialize)]
struct WorkspaceTreeScanOptions {
    root: PathBuf,
    #[serde(default)]
    dir: PathBuf,
    #[serde(default = "default_workspace_tree_depth")]
    depth: usize,
    #[serde(rename = "maxEntries", default = "default_workspace_tree_max_entries")]
    max_entries: usize,
}

struct WorkspaceTreeSidecar {
    started_at: String,
    requests: u64,
    responses: u64,
    failures: u64,
    scans: u64,
    items: u64,
    truncated_scans: u64,
    last_request_at: String,
    last_response_at: String,
    last_failure_at: String,
    last_error: String,
}

fn default_workspace_tree_depth() -> usize {
    1
}

fn default_workspace_tree_max_entries() -> usize {
    240
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

pub(crate) fn run(root: &Path, dir: &Path, depth: usize, max_entries: usize) -> Result<()> {
    let tree = list_workspace_tree(root, dir, depth, max_entries)?;
    println!("{}", serde_json::to_string_pretty(&tree)?);
    Ok(())
}

pub(crate) fn run_sidecar() -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut sidecar = WorkspaceTreeSidecar::new();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: SidecarRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                sidecar.record_request();
                sidecar.record_failure(&error.to_string());
                write_sidecar_error(&mut stdout, &Value::Null, &error.to_string())?;
                continue;
            }
        };

        sidecar.record_request();
        if request.method == "__close" {
            sidecar.record_response();
            write_sidecar_result(&mut stdout, &request.id, Value::Bool(true))?;
            break;
        }

        match sidecar.handle(&request.method, &request.args) {
            Ok(result) => {
                sidecar.record_response();
                write_sidecar_result(&mut stdout, &request.id, result)?;
            }
            Err(error) => {
                sidecar.record_failure(&format!("{error:#}"));
                write_sidecar_error(&mut stdout, &request.id, &format!("{error:#}"))?;
            }
        }
    }
    Ok(())
}

impl WorkspaceTreeSidecar {
    fn new() -> Self {
        Self {
            started_at: now_iso(),
            requests: 0,
            responses: 0,
            failures: 0,
            scans: 0,
            items: 0,
            truncated_scans: 0,
            last_request_at: String::new(),
            last_response_at: String::new(),
            last_failure_at: String::new(),
            last_error: String::new(),
        }
    }

    fn record_request(&mut self) {
        self.requests += 1;
        self.last_request_at = now_iso();
    }

    fn record_response(&mut self) {
        self.responses += 1;
        self.last_response_at = now_iso();
    }

    fn record_failure(&mut self, message: &str) {
        self.failures += 1;
        self.last_failure_at = now_iso();
        self.last_error = message.to_string();
    }

    fn handle(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        match method {
            "__health" => Ok(json!({
                "ok": true,
                "implementation": "rust",
                "protocolVersion": 1,
                "supportedMethods": ["scan"],
                "controlMethods": ["__health", "stats", "__close"],
                "startedAt": self.started_at
            })),
            "stats" => Ok(self.stats()),
            "scan" => {
                let options: WorkspaceTreeScanOptions = sidecar_arg(args, 0)?;
                let tree = list_workspace_tree(
                    &options.root,
                    &options.dir,
                    options.depth,
                    options.max_entries,
                )?;
                self.scans += 1;
                self.items += tree.items.len() as u64;
                if tree.truncated {
                    self.truncated_scans += 1;
                }
                Ok(serde_json::to_value(tree)?)
            }
            _ => bail!("Unsupported workspace tree sidecar method: {method}"),
        }
    }

    fn stats(&self) -> Value {
        json!({
            "implementation": "rust",
            "protocolVersion": 1,
            "startedAt": self.started_at,
            "pending": 0,
            "requests": self.requests,
            "responses": self.responses,
            "failures": self.failures,
            "scans": self.scans,
            "items": self.items,
            "truncatedScans": self.truncated_scans,
            "lastRequestAt": self.last_request_at,
            "lastResponseAt": self.last_response_at,
            "lastFailureAt": self.last_failure_at,
            "lastError": self.last_error
        })
    }
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
    let mut queue = VecDeque::from([(
        target.clone(),
        0usize,
        gitignore_rules_for_ancestors(&root, &target),
    )]);
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
        ignore_rules.extend(gitignore_rules_for_dir(&root, &current));

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
            let full_path = entry.path();
            let rel = slash_path(full_path.strip_prefix(&root).unwrap_or(&full_path));
            if ignore_rules.is_ignored(&name, &rel, file_type.is_dir()) {
                continue;
            }
            children.push((name, full_path, file_type.is_dir()));
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
                size: workspace_metadata_size(&metadata),
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
                .map(system_time_rounded_millis)
                .unwrap_or(0);
            format!(
                "{kind}:{rel}:{}:{}:{modified_ms}",
                if metadata.is_dir() { "d" } else { "f" },
                workspace_metadata_size(&metadata)
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
    match_path: bool,
    directory_only: bool,
    negated: bool,
}

impl WorkspaceIgnoreRules {
    fn extend(&mut self, other: WorkspaceIgnoreRules) {
        self.rules.extend(other.rules);
    }

    fn is_ignored(&self, name: &str, rel_path: &str, is_dir: bool) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.directory_only && !is_dir {
                continue;
            }
            let matches = if rule.match_path {
                gitignore_path_matches(&rule.pattern, rel_path)
            } else {
                gitignore_basename_matches(&rule.pattern, name)
            };
            if matches {
                ignored = !rule.negated;
            }
        }
        ignored
    }
}

fn gitignore_rules_for_dir(root: &Path, dir: &Path) -> WorkspaceIgnoreRules {
    let mut rules = WorkspaceIgnoreRules::default();
    let Ok(content) = std::fs::read_to_string(dir.join(".gitignore")) else {
        return rules;
    };
    let base = slash_path(dir.strip_prefix(root).unwrap_or(Path::new("")));

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
        let anchored = body.starts_with('/');
        let pattern = body.trim_start_matches('/').trim_end_matches('/');
        if pattern.is_empty() {
            continue;
        }
        let match_path = anchored || pattern.contains('/');
        let pattern = if match_path && !base.is_empty() {
            format!("{base}/{pattern}")
        } else {
            pattern.to_string()
        };
        rules.rules.push(WorkspaceIgnoreRule {
            pattern,
            match_path,
            directory_only,
            negated,
        });
    }

    rules
}

fn gitignore_rules_for_ancestors(root: &Path, dir: &Path) -> WorkspaceIgnoreRules {
    let Ok(relative) = dir.strip_prefix(root) else {
        return WorkspaceIgnoreRules::default();
    };
    let components: Vec<_> = relative.components().collect();
    if components.is_empty() {
        return WorkspaceIgnoreRules::default();
    }

    let mut rules = gitignore_rules_for_dir(root, root);
    let mut current = root.to_path_buf();
    for component in components.iter().take(components.len() - 1) {
        if let std::path::Component::Normal(part) = component {
            current.push(part);
            rules.extend(gitignore_rules_for_dir(root, &current));
        }
    }
    rules
}

fn gitignore_path_matches(pattern: &str, path: &str) -> bool {
    let pattern_parts: Vec<_> = pattern.split('/').collect();
    let path_parts: Vec<_> = path.split('/').collect();
    if pattern_parts.len() != path_parts.len() {
        return false;
    }
    pattern_parts
        .iter()
        .zip(path_parts.iter())
        .all(|(pattern_part, path_part)| gitignore_basename_matches(pattern_part, path_part))
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

fn workspace_metadata_size(metadata: &std::fs::Metadata) -> u64 {
    if cfg!(windows) && metadata.is_dir() {
        0
    } else {
        metadata.len()
    }
}

fn rounded_system_time(value: std::time::SystemTime) -> DateTime<Utc> {
    let datetime: DateTime<Utc> = value.into();
    datetime
        .checked_add_signed(chrono::Duration::microseconds(500))
        .unwrap_or(datetime)
}

fn system_time_rounded_millis(value: std::time::SystemTime) -> i64 {
    rounded_system_time(value).timestamp_millis()
}

fn system_time_iso(value: Option<std::time::SystemTime>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    let datetime = rounded_system_time(value);
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, time::Duration};

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
    fn workspace_tree_honors_gitignore_path_patterns() {
        let root = env::temp_dir().join(format!(
            "vibelink-workspace-tree-gitignore-paths-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src").join("generated")).unwrap();
        fs::write(
            root.join(".gitignore"),
            "src/generated/*.tmp\n!src/generated/keep.tmp\n",
        )
        .unwrap();
        fs::write(root.join("src").join("app.rs"), "fn main() {}").unwrap();
        fs::write(
            root.join("src").join("generated").join("noise.tmp"),
            "ignored",
        )
        .unwrap();
        fs::write(root.join("src").join("generated").join("keep.tmp"), "kept").unwrap();
        fs::write(root.join("src").join("generated").join("note.txt"), "kept").unwrap();

        let tree = list_workspace_tree(&root, Path::new(""), 3, 20).unwrap();

        let paths: Vec<_> = tree.items.iter().map(|item| item.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "src",
                "src/generated",
                "src/app.rs",
                "src/generated/keep.tmp",
                "src/generated/note.txt",
            ]
        );

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

    #[test]
    fn workspace_tree_rounds_submillisecond_timestamps_like_node() {
        let value = std::time::UNIX_EPOCH + Duration::from_millis(123) + Duration::from_micros(600);
        assert_eq!(system_time_iso(Some(value)), "1970-01-01T00:00:00.124Z");
        assert_eq!(system_time_rounded_millis(value), 124);
    }
}
