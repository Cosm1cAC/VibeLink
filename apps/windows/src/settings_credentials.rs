use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const API_KEY_NAMES: [&str; 3] = ["openai", "anthropic", "zhipu"];

#[derive(Debug)]
pub(crate) struct SecretSnapshot {
    path: PathBuf,
    content: Option<Vec<u8>>,
}

pub(crate) fn write_requested_secrets(
    data_dir: &Path,
    sanitized_patch: &Value,
    raw_body: &Value,
) -> Result<(Value, Vec<SecretSnapshot>)> {
    let mut requested = Vec::new();
    if let Some(api_keys) = sanitized_patch.get("apiKeys").and_then(Value::as_object) {
        for key in API_KEY_NAMES {
            if let Some(value) = api_keys
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                requested.push((key, value.to_string()));
            }
        }
    }
    if let Some(value) = raw_body
        .get("nativePush")
        .and_then(|value| value.get("fcmServiceAccountJson"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        requested.push(("fcmServiceAccount", value.to_string()));
    }

    let mut snapshots = Vec::new();
    let mut results = Map::new();
    for (key, value) in requested {
        snapshots.push(snapshot_secret(data_dir, key)?);
        match write_secret(data_dir, key, &value) {
            Ok(written) => {
                results.insert(key.to_string(), Value::Bool(written));
            }
            Err(error) => {
                let rollback = restore_secret_snapshots(&snapshots);
                rollback.context("Cannot restore credentials after write failure")?;
                return Err(error);
            }
        }
    }
    Ok((Value::Object(results), snapshots))
}

pub(crate) fn restore_secret_snapshots(snapshots: &[SecretSnapshot]) -> Result<()> {
    for snapshot in snapshots.iter().rev() {
        match &snapshot.content {
            Some(content) => {
                if let Some(parent) = snapshot.path.parent() {
                    fs::create_dir_all(parent).with_context(|| {
                        format!("Cannot create secret directory {}", parent.display())
                    })?;
                }
                fs::write(&snapshot.path, content).with_context(|| {
                    format!("Cannot restore secret {}", snapshot.path.display())
                })?;
            }
            None => match fs::remove_file(&snapshot.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("Cannot remove restored secret {}", snapshot.path.display())
                    })
                }
            },
        }
    }
    Ok(())
}

pub(crate) fn public_credential_state(data_dir: &Path) -> Value {
    let available = credential_backend_available();
    json!({
        "credentials": {
            "backend": if cfg!(windows) { "windows-dpapi" } else { "memory-only" },
            "available": available,
            "persistent": available,
            "description": if cfg!(windows) {
                "Windows DPAPI user-protected secret file"
            } else {
                "No supported OS credential helper found"
            }
        },
        "hasOpenAIKey": secret_is_configured(data_dir, "openai", "OPENAI_API_KEY"),
        "hasAnthropicKey": secret_is_configured(data_dir, "anthropic", "ANTHROPIC_API_KEY"),
        "hasZhipuKey": secret_is_configured(data_dir, "zhipu", "ZHIPU_API_KEY"),
        "nativePushConfigured": secret_is_configured(
            data_dir,
            "fcmServiceAccount",
            "VIBELINK_FCM_SERVICE_ACCOUNT_JSON"
        )
    })
}

fn snapshot_secret(data_dir: &Path, key: &str) -> Result<SecretSnapshot> {
    let path = secret_file(data_dir, key)?;
    let content = match fs::read(&path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(error).with_context(|| format!("Cannot snapshot secret {}", path.display()))
        }
    };
    Ok(SecretSnapshot { path, content })
}

fn secret_is_configured(data_dir: &Path, key: &str, environment: &str) -> bool {
    std::env::var_os(environment).is_some_and(|value| !value.is_empty())
        || secret_file(data_dir, key).is_ok_and(|path| path.exists())
}

fn credential_backend_available() -> bool {
    #[cfg(windows)]
    {
        let path = windows_powershell_path();
        if !path.exists() {
            return false;
        }
        let mut command = Command::new(&path);
        command.args(["-NoProfile", "-Command", "exit 0"]);
        command.creation_flags(CREATE_NO_WINDOW);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn write_secret(data_dir: &Path, key: &str, value: &str) -> Result<bool> {
    if value.is_empty() || !credential_backend_available() {
        return Ok(false);
    }
    let target = secret_file(data_dir, key)?;
    let parent = target.parent().context("Secret path has no parent")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("Cannot create secret directory {}", parent.display()))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(".{key}-{}-{nonce}.tmp", std::process::id()));
    let script = "$ErrorActionPreference = 'Stop'; \
        Import-Module \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1\" -Force; \
        $secure = ConvertTo-SecureString $env:VIBELINK_SECRET_VALUE -AsPlainText -Force; \
        $encrypted = $secure | ConvertFrom-SecureString; \
        Set-Content -LiteralPath $env:VIBELINK_SECRET_FILE -Value $encrypted -Encoding UTF8";
    let output = powershell(script)
        .env("VIBELINK_SECRET_VALUE", value)
        .env("VIBELINK_SECRET_FILE", &temp)
        .output()
        .context("Cannot start Windows credential helper")?;
    if !output.status.success() {
        let _ = fs::remove_file(&temp);
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "Windows credential helper failed{}",
            if message.is_empty() {
                String::new()
            } else {
                format!(": {message}")
            }
        );
    }
    replace_secret_file(&temp, &target)?;
    Ok(true)
}

#[cfg(test)]
fn read_secret(data_dir: &Path, key: &str) -> Result<String> {
    let target = secret_file(data_dir, key)?;
    if !target.exists() {
        return Ok(String::new());
    }
    let script = "$ErrorActionPreference = 'Stop'; \
        Import-Module \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1\" -Force; \
        $encrypted = (Get-Content -LiteralPath $env:VIBELINK_SECRET_FILE -Raw).Trim(); \
        $secure = ConvertTo-SecureString $encrypted; \
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); \
        try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } \
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }";
    let output = powershell(script)
        .env("VIBELINK_SECRET_FILE", &target)
        .output()
        .context("Cannot start Windows credential reader")?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "Windows credential reader failed{}",
            if message.is_empty() {
                String::new()
            } else {
                format!(": {message}")
            }
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn replace_secret_file(temp: &Path, target: &Path) -> Result<()> {
    let parent = target.parent().context("Secret path has no parent")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let backup = parent.join(format!(".secret-{}-{nonce}.bak", std::process::id()));
    let had_target = target.exists();
    if had_target {
        fs::rename(target, &backup)
            .with_context(|| format!("Cannot move secret {} to backup", target.display()))?;
    }
    if let Err(error) = fs::rename(temp, target) {
        if had_target {
            let _ = fs::rename(&backup, target);
        }
        let _ = fs::remove_file(temp);
        return Err(error).with_context(|| format!("Cannot replace secret {}", target.display()));
    }
    if had_target {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn secret_file(data_dir: &Path, key: &str) -> Result<PathBuf> {
    if !matches!(key, "openai" | "anthropic" | "zhipu" | "fcmServiceAccount") {
        bail!("Unsupported credential key");
    }
    Ok(data_dir.join("secrets").join(format!("{key}.dpapi")))
}

fn powershell(script: &str) -> Command {
    #[cfg(windows)]
    let executable = windows_powershell_path();
    #[cfg(not(windows))]
    let executable = PathBuf::from("powershell.exe");
    let mut command = Command::new(executable);
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn windows_powershell_path() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

#[cfg(test)]
mod tests {
    use super::{
        credential_backend_available, read_secret, restore_secret_snapshots, snapshot_secret,
        write_secret,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    #[cfg(windows)]
    fn windows_dpapi_round_trip_is_node_compatible_and_rollback_restores_bytes() {
        if !credential_backend_available() {
            return;
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!(
            "vibelink-settings-credentials-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        assert!(write_secret(&data_dir, "openai", "first-secret").unwrap());
        assert_eq!(read_secret(&data_dir, "openai").unwrap(), "first-secret");
        let snapshot = snapshot_secret(&data_dir, "openai").unwrap();
        assert!(write_secret(&data_dir, "openai", "second-secret").unwrap());
        assert_eq!(read_secret(&data_dir, "openai").unwrap(), "second-secret");
        restore_secret_snapshots(&[snapshot]).unwrap();
        assert_eq!(read_secret(&data_dir, "openai").unwrap(), "first-secret");
        fs::remove_dir_all(data_dir).unwrap();
    }
}
