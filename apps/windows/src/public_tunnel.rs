use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use crate::{project_root, resolve_data_dir, wait_for_bridge};

#[derive(Debug, Deserialize)]
struct CloudflaredConfig {
    tunnel: String,
    #[serde(default)]
    ingress: Vec<CloudflaredIngress>,
}

#[derive(Debug, Deserialize)]
struct CloudflaredIngress {
    #[serde(default)]
    hostname: String,
    service: String,
}

#[derive(Debug, Deserialize)]
struct TunnelSettings {
    port: u16,
    #[serde(rename = "hostAllowlist", default)]
    host_allowlist: Vec<String>,
    #[serde(rename = "allowLegacyPairingTokenLogin", default)]
    allow_legacy_pairing_token_login: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct TunnelPlan {
    pub(crate) tunnel: String,
    pub(crate) hostname: String,
    upstream: String,
    pub(crate) upstream_port: u16,
}

pub(crate) fn validate_plan(config_text: &str, settings_text: &str) -> Result<TunnelPlan> {
    let config: CloudflaredConfig =
        serde_yaml_ng::from_str(config_text).context("Cloudflare config is invalid YAML")?;
    let settings: TunnelSettings =
        serde_json::from_str(settings_text).context("VibeLink settings are invalid JSON")?;
    if config.tunnel.trim().is_empty() {
        bail!("Cloudflare config must declare a named tunnel");
    }
    let ingress = config
        .ingress
        .iter()
        .find(|item| !item.hostname.trim().is_empty())
        .context("Cloudflare config must declare a fixed hostname ingress")?;
    let hostname = ingress.hostname.trim().to_ascii_lowercase();
    if hostname.ends_with(".trycloudflare.com") || hostname.contains('*') || !hostname.contains('.')
    {
        bail!("Cloudflare ingress must use a fixed hostname");
    }
    let prefix = "http://127.0.0.1:";
    let port_text = ingress
        .service
        .strip_prefix(prefix)
        .context("Cloudflare ingress must target http://127.0.0.1:<port>")?;
    let upstream_port = port_text
        .parse::<u16>()
        .context("Cloudflare upstream port is invalid")?;
    if upstream_port != settings.port {
        bail!(
            "Cloudflare upstream port {upstream_port} does not match VibeLink port {}",
            settings.port
        );
    }
    if settings.allow_legacy_pairing_token_login {
        bail!("Legacy pairing-token login must be disabled for public deployment");
    }
    if !settings
        .host_allowlist
        .iter()
        .any(|item| item.trim().eq_ignore_ascii_case(&hostname))
    {
        bail!("Host allowlist does not contain {hostname}");
    }
    if !config.ingress.last().is_some_and(|item| {
        item.hostname.trim().is_empty()
            && item.service.trim().eq_ignore_ascii_case("http_status:404")
    }) {
        bail!("Cloudflare ingress must end with a 404 fallback");
    }
    Ok(TunnelPlan {
        tunnel: config.tunnel.trim().to_string(),
        hostname,
        upstream: ingress.service.trim().to_string(),
        upstream_port,
    })
}

pub(crate) fn run(
    config_path: Option<&Path>,
    settings_path: Option<&Path>,
    check_only: bool,
) -> Result<()> {
    let root = project_root()?;
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .context("Cannot resolve the user home directory")?;
    let config_path = config_path
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".cloudflared").join("config.yml"));
    let settings_path = settings_path.map(PathBuf::from).unwrap_or_else(|| {
        resolve_data_dir(
            &root,
            env::var_os("VIBELINK_DATA_DIR"),
            env::var_os("LOCALAPPDATA"),
            Path::exists,
        )
        .join("settings.json")
    });
    let config_text = fs::read_to_string(&config_path)
        .with_context(|| format!("Cannot read Cloudflare config at {}", config_path.display()))?;
    let settings_text = fs::read_to_string(&settings_path).with_context(|| {
        format!(
            "Cannot read VibeLink settings at {}",
            settings_path.display()
        )
    })?;
    let plan = validate_plan(&config_text, &settings_text)?;
    println!("{}", serde_json::to_string_pretty(&plan)?);
    if check_only {
        return Ok(());
    }
    wait_for_bridge(
        &format!("http://127.0.0.1:{}", plan.upstream_port),
        Duration::from_secs(5),
    )?;
    let command = env::var_os("VIBELINK_CLOUDFLARED_COMMAND").unwrap_or_else(|| {
        let bundled = root.join("runtime").join("cloudflared.exe");
        if bundled.exists() {
            bundled.into_os_string()
        } else {
            OsString::from("cloudflared")
        }
    });
    let status = Command::new(command)
        .arg("tunnel")
        .arg("--config")
        .arg(&config_path)
        .arg("run")
        .arg(&plan.tunnel)
        .status()
        .context("Failed to launch cloudflared")?;
    if !status.success() {
        bail!("cloudflared exited with status {status}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_requires_fixed_allowlisted_loopback_ingress() {
        let config = r#"
tunnel: 4380b9d0-4542-4bc3-862d-4f6176c708f8
ingress:
  - hostname: bridge.vibelink.cloud
    service: http://127.0.0.1:8787
  - service: http_status:404
"#;
        let settings = r#"{
  "port": 8787,
  "hostAllowlist": ["bridge.vibelink.cloud"],
  "allowLegacyPairingTokenLogin": false
}"#;

        let plan = validate_plan(config, settings).unwrap();
        assert_eq!(plan.tunnel, "4380b9d0-4542-4bc3-862d-4f6176c708f8");
        assert_eq!(plan.hostname, "bridge.vibelink.cloud");
        assert_eq!(plan.upstream_port, 8787);

        let unsafe_settings = settings.replace("false", "true");
        assert!(validate_plan(config, &unsafe_settings).is_err());

        let misplaced_fallback = config.replace(
            "  - hostname: bridge.vibelink.cloud\n    service: http://127.0.0.1:8787\n  - service: http_status:404",
            "  - service: http_status:404\n  - hostname: bridge.vibelink.cloud\n    service: http://127.0.0.1:8787",
        );
        assert!(validate_plan(&misplaced_fallback, settings).is_err());
    }
}
