pub mod protocol;
pub mod spool;

#[cfg(windows)]
mod backend;
#[cfg(windows)]
mod codex_app_server;
#[cfg(windows)]
mod daemon;
#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
mod worker;

#[cfg(not(windows))]
use anyhow::bail;
use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use std::{path::Path, time::SystemTime};

pub fn now_rfc3339() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(windows)]
pub fn run_execd(data_dir: &Path, pipe_override: Option<&str>) -> Result<()> {
    daemon::run(data_dir, pipe_override)
}

#[cfg(not(windows))]
pub fn run_execd(_data_dir: &Path, _pipe_override: Option<&str>) -> Result<()> {
    bail!("execd is available only on Windows")
}

#[cfg(windows)]
pub fn run_worker(bootstrap_path: &Path) -> Result<()> {
    worker::run(bootstrap_path)
}

#[cfg(not(windows))]
pub fn run_worker(_bootstrap_path: &Path) -> Result<()> {
    bail!("execution-worker is available only on Windows")
}
