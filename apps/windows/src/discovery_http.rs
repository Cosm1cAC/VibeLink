use crate::device_http::apply_fields;
use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

const MAX_SKILL_BYTES: u64 = 1024 * 1024;

pub const DISCOVERY_RUNTIME_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/tool-registry"),
    ("GET", "/api/command-registry"),
    ("POST", "/api/command-registry/refresh"),
];

static BUILTIN_CATALOG: OnceLock<Value> = OnceLock::new();

#[derive(Clone)]
pub struct DiscoveryRouteConfig {
    data_dir: PathBuf,
    skill_dirs: Vec<PathBuf>,
}

impl DiscoveryRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_default();
        Self {
            data_dir,
            skill_dirs: vec![home.join(".vibelink/skills"), home.join(".claude/skills")],
        }
    }

    #[cfg(test)]
    fn with_skill_dirs(data_dir: PathBuf, skill_dirs: Vec<PathBuf>) -> Self {
        Self {
            data_dir,
            skill_dirs,
        }
    }
}

pub fn route_discovery_request(
    request: &ParsedRequest,
    config: &DiscoveryRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    let route = (request.method.as_str(), request.path());
    if !DISCOVERY_RUNTIME_ROUTES.contains(&route) {
        return Ok(None);
    }
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => Ok(None),
        RouteAuthentication::HostDenied => {
            Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")))
        }
        RouteAuthentication::Unauthorized => {
            Ok(Some(HttpRouteResponse::error(401, "Unauthorized")))
        }
        RouteAuthentication::Device(_) => match route {
            ("GET", "/api/tool-registry") => Ok(Some(HttpRouteResponse::json(
                200,
                json!({ "items": project_items(tool_registry(config)?, request) }),
            ))),
            ("GET", "/api/command-registry") => {
                let filter = request.query_parameter("filter").unwrap_or_default();
                let commands = command_registry(config)?
                    .into_iter()
                    .filter(|command| command_matches(command, &filter))
                    .collect::<Vec<_>>();
                Ok(Some(HttpRouteResponse::json(
                    200,
                    json!({ "items": project_items(commands, request) }),
                )))
            }
            ("POST", "/api/command-registry/refresh") => Ok(Some(HttpRouteResponse::json(
                200,
                json!({ "ok": true, "skillsLoaded": command_registry(config)?.len() }),
            ))),
            _ => Ok(None),
        },
    }
}

fn builtin_catalog() -> &'static Value {
    BUILTIN_CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../resources/discovery-catalog.json"))
            .expect("embedded discovery catalog must be valid JSON")
    })
}

fn builtin_items(key: &str) -> Vec<Value> {
    builtin_catalog()
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn tool_registry(config: &DiscoveryRouteConfig) -> Result<Vec<Value>> {
    let mut tools = builtin_items("tools");
    let mut names = tools
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
        .collect::<HashSet<_>>();
    for tool in cached_mcp_tools(&config.data_dir)? {
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            continue;
        };
        if names.insert(name.to_string()) {
            tools.push(tool);
        }
    }
    Ok(tools)
}

fn cached_mcp_tools(data_dir: &Path) -> Result<Vec<Value>> {
    let database = Connection::open_with_flags(
        data_dir.join("mobile-agent.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("Cannot open MCP tool cache")?;
    database.busy_timeout(Duration::from_secs(5))?;
    let exists = database
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_tools'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(Vec::new());
    }
    let mut statement = database.prepare(
        "SELECT server_name, tool_name, full_name, title, description, input_schema
         FROM mcp_tools ORDER BY server_name, tool_name",
    )?;
    let rows = statement.query_map([], |row| {
        let server_name = row.get::<_, String>(0)?;
        let tool_name = row.get::<_, String>(1)?;
        let full_name = row.get::<_, String>(2)?;
        let title = row
            .get::<_, Option<String>>(3)?
            .unwrap_or_else(|| tool_name.clone());
        let description = row
            .get::<_, Option<String>>(4)?
            .unwrap_or_else(|| "Discovered MCP tool.".to_string());
        let input_schema = row
            .get::<_, Option<String>>(5)?
            .and_then(|source| serde_json::from_str(&source).ok())
            .unwrap_or(Value::Null);
        Ok(json!({
            "name": full_name,
            "kind": "plugin",
            "label": title,
            "permission": "plugin.mcp",
            "risk": "medium",
            "description": description,
            "inputSchema": input_schema,
            "outputSchema": null,
            "source": { "type": "mcp", "server": server_name, "toolName": tool_name }
        }))
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("Cannot read MCP tool cache")
}

fn command_registry(config: &DiscoveryRouteConfig) -> Result<Vec<Value>> {
    let mut commands = builtin_items("commands");
    for directory in &config.skill_dirs {
        commands.extend(scan_skills(directory)?);
    }
    Ok(commands)
}

fn scan_skills(directory: &Path) -> Result<Vec<Value>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Ok(Vec::new()),
    };
    let mut skill_dirs = entries
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .collect::<Vec<_>>();
    skill_dirs.sort_by_key(|entry| entry.file_name());
    Ok(skill_dirs
        .into_iter()
        .filter_map(|entry| parse_skill(&entry.path()).ok().flatten())
        .collect())
}

fn parse_skill(directory: &Path) -> Result<Option<Value>> {
    let skill_path = directory.join("SKILL.md");
    let metadata = match fs::metadata(&skill_path) {
        Ok(metadata) if metadata.len() <= MAX_SKILL_BYTES => metadata,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    let mut raw = String::new();
    match fs::File::open(&skill_path) {
        Ok(file) => file.take(MAX_SKILL_BYTES + 1).read_to_string(&mut raw)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };
    if raw.len() as u64 > MAX_SKILL_BYTES {
        return Ok(None);
    }
    let raw = raw.replace("\r\n", "\n");
    let (meta, body) = parse_frontmatter(&raw);
    let dir_name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if dir_name.is_empty() {
        return Ok(None);
    }
    let name = meta.get("name").and_then(Value::as_str).unwrap_or(dir_name);
    let description = meta
        .get("description")
        .or_else(|| meta.get("when_to_use"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Skill: {name}"));
    Ok(Some(json!({
        "id": format!("skill:{dir_name}"),
        "name": format!("/skill {name}"),
        "description": description,
        "args": [],
        "usage": format!("/skill {name}"),
        "permission": if meta.contains_key("allowed_tools") { "ask" } else { "none" },
        "toolKind": "plugin",
        "icon": "Code2",
        "source": skill_path.to_string_lossy(),
        "body": body,
        "meta": meta
    })))
}

fn parse_frontmatter(raw: &str) -> (Map<String, Value>, String) {
    let Some(rest) = raw.strip_prefix("---\n") else {
        return (Map::new(), raw.to_string());
    };
    let Some((frontmatter, body)) = rest.split_once("\n---\n") else {
        return (Map::new(), raw.to_string());
    };
    let mut meta = Map::new();
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            continue;
        }
        let value = value
            .trim()
            .trim_start_matches(['"', '\''])
            .trim_end_matches(['"', '\''])
            .trim();
        meta.insert(key.to_string(), Value::String(value.to_string()));
    }
    (meta, body.trim().to_string())
}

fn command_matches(command: &Value, filter: &str) -> bool {
    if filter.is_empty() {
        return true;
    }
    let text = [
        "id",
        "name",
        "description",
        "usage",
        "toolKind",
        "permission",
    ]
    .into_iter()
    .filter_map(|key| command.get(key).and_then(Value::as_str))
    .chain(
        ["label", "detail"]
            .into_iter()
            .filter_map(|key| command.get("ui")?.get(key)?.as_str()),
    )
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
    text.contains(&filter.to_lowercase())
}

fn project_items(items: Vec<Value>, request: &ParsedRequest) -> Vec<Value> {
    let fields = request.query_parameter("fields");
    items
        .into_iter()
        .map(|item| apply_fields(item, fields.as_deref()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request};
    use rusqlite::{params, Connection};

    fn fixture() -> (PathBuf, DiscoveryRouteConfig) {
        let directory =
            std::env::temp_dir().join(format!("vibelink-discovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("skills/example")).unwrap();
        fs::write(
            directory.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"]}"#,
        )
        .unwrap();
        fs::write(
            directory.join("skills/example/SKILL.md"),
            "---\nname: example\ndescription: Example skill\nallowed_tools: Read\n---\nUse the example.",
        )
        .unwrap();
        let database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        database.execute_batch("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT); CREATE TABLE mcp_tools (server_name TEXT, tool_name TEXT, full_name TEXT PRIMARY KEY, title TEXT, description TEXT, input_schema TEXT);").unwrap();
        database.execute("INSERT INTO devices VALUES ('device', 'Device', ?1, '', '', NULL, '2099-01-01T00:00:00.000Z', NULL, '{}')", params![hash_token("token")]).unwrap();
        database.execute("INSERT INTO mcp_tools VALUES ('memory', 'search_graph', 'mcp__memory__search_graph', 'Search graph', 'Search code.', '{\"type\":\"object\"}')", []).unwrap();
        let config = DiscoveryRouteConfig::with_skill_dirs(
            directory.clone(),
            vec![directory.join("skills")],
        );
        (directory, config)
    }

    fn request(path: &str, method: &str) -> ParsedRequest {
        parse_request(
            format!(
                "{method} {path} HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn serves_builtin_and_cached_tools_with_field_projection() {
        let (directory, config) = fixture();
        let response = route_discovery_request(
            &request("/api/tool-registry?fields=name,inputSchema", "GET"),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 200);
        let items = response.body["items"].as_array().unwrap();
        assert!(items
            .iter()
            .any(|item| item["name"] == "agent_reach.status"));
        assert!(items
            .iter()
            .any(|item| item["name"] == "mcp__memory__search_graph"));
        assert!(items.iter().all(|item| item.get("description").is_none()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn serves_filters_and_refreshes_builtin_and_skill_commands() {
        let (directory, config) = fixture();
        let response = route_discovery_request(
            &request("/api/command-registry?filter=example", "GET"),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(response.body["items"].as_array().unwrap().len(), 1);
        assert_eq!(response.body["items"][0]["id"], "skill:example");
        assert_eq!(response.body["items"][0]["permission"], "ask");

        let refresh =
            route_discovery_request(&request("/api/command-registry/refresh", "POST"), &config)
                .unwrap()
                .unwrap();
        assert_eq!(refresh.body["ok"], true);
        assert_eq!(refresh.body["skillsLoaded"], 22);
        fs::remove_dir_all(directory).unwrap();
    }
}
