use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::Path,
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY,
        ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
    },
    Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    },
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
        SYNCHRONIZE,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, WaitNamedPipeW, PIPE_READMODE_BYTE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
        },
        Threading::{
            GetCurrentProcessId, GetProcessTimes, OpenProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        },
    },
};

pub const DETACHED_PROCESS: u32 = 0x0000_0008;
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Job {
    handle: HANDLE,
}

unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn create() -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error()).context("failed to create Job Object");
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const _,
                std::mem::size_of_val(&information) as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(error).context("failed to configure kill-on-close Job Object");
        }
        Ok(Self { handle })
    }

    pub fn assign_pid(&self, pid: u32) -> Result<()> {
        let process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if process.is_null() {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("failed to open child process {pid} for Job assignment"));
        }
        let assigned = unsafe { AssignProcessToJobObject(self.handle, process) };
        let error = (assigned == 0).then(std::io::Error::last_os_error);
        unsafe { CloseHandle(process) };
        if let Some(error) = error {
            return Err(error)
                .with_context(|| format!("failed to assign process {pid} to Job Object"));
        }
        Ok(())
    }

    pub fn terminate(&self, exit_code: u32) -> Result<()> {
        if unsafe { TerminateJobObject(self.handle, exit_code) } == 0 {
            return Err(std::io::Error::last_os_error()).context("failed to terminate Job Object");
        }
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { CloseHandle(self.handle) };
        }
    }
}

pub fn current_process_creation_ticks() -> Result<u64> {
    process_creation_ticks(unsafe { GetCurrentProcessId() })
        .context("failed to inspect execution worker creation time")
}

pub fn process_creation_ticks(pid: u32) -> Result<u64> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("failed to open process {pid}"));
    }
    let mut created = unsafe { std::mem::zeroed() };
    let mut exited = unsafe { std::mem::zeroed() };
    let mut kernel = unsafe { std::mem::zeroed() };
    let mut user = unsafe { std::mem::zeroed() };
    let inspected =
        unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) };
    let error = (inspected == 0).then(std::io::Error::last_os_error);
    unsafe { CloseHandle(process) };
    if let Some(error) = error {
        return Err(error).with_context(|| format!("failed to read process {pid} creation time"));
    }
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

pub fn process_matches(pid: u32, expected_creation_ticks: u64) -> bool {
    process_creation_ticks(pid)
        .map(|actual| actual == expected_creation_ticks && process_is_alive(pid))
        .unwrap_or(false)
}

fn process_is_alive(pid: u32) -> bool {
    let process = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return false;
    }
    let result = unsafe { WaitForSingleObject(process, 0) };
    unsafe { CloseHandle(process) };
    result == WAIT_TIMEOUT
}

pub fn execd_pipe_name(data_dir: &Path) -> String {
    let normalized = data_dir.to_string_lossy().to_ascii_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let digest = format!("{digest:x}");
    format!("\\\\.\\pipe\\vibelink-execd-v1-{}", &digest[..16])
}

pub fn worker_pipe_name(execution_id: &str, worker_instance_id: &str) -> String {
    let safe_execution = execution_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect::<String>();
    let safe_instance = worker_instance_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect::<String>();
    format!("\\\\.\\pipe\\vibelink-worker-v1-{safe_execution}-{safe_instance}")
}

pub fn accept_named_pipe(name: &str) -> Result<File> {
    let wide_name = wide(name);
    let descriptor_sddl = wide("D:P(A;;GA;;;SY)(A;;GA;;;OW)");
    let mut descriptor = null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    };
    if converted == 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to build current-owner named-pipe ACL");
    }
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateNamedPipeW(
            wide_name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            super::protocol::MAX_FRAME_BYTES as u32 + 4,
            super::protocol::MAX_FRAME_BYTES as u32 + 4,
            0,
            &mut attributes,
        )
    };
    unsafe { LocalFree(descriptor) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("failed to create restricted named pipe {name}"));
    }
    let connected = unsafe { ConnectNamedPipe(handle, null_mut()) };
    if connected == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_PIPE_CONNECTED {
            unsafe { CloseHandle(handle) };
            return Err(std::io::Error::from_raw_os_error(error as i32))
                .with_context(|| format!("failed to accept named pipe {name}"));
        }
    }
    Ok(unsafe { File::from_raw_handle(handle as _) })
}

pub fn connect_named_pipe(name: &str, timeout: Duration) -> Result<File> {
    let wide_name = wide(name);
    let deadline = Instant::now() + timeout;
    loop {
        let handle = unsafe {
            CreateFileW(
                wide_name.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            return Ok(unsafe { File::from_raw_handle(handle as _) });
        }
        let error = unsafe { GetLastError() };
        if !is_transient_pipe_connect_error(error) || Instant::now() >= deadline {
            return Err(std::io::Error::from_raw_os_error(error as i32))
                .with_context(|| format!("failed to connect to named pipe {name}"));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if error == ERROR_PIPE_BUSY {
            let wait_ms = remaining.min(Duration::from_millis(200)).as_millis() as u32;
            unsafe { WaitNamedPipeW(wide_name.as_ptr(), wait_ms.max(1)) };
        } else {
            // The worker recreates a pipe instance after each connection. CreateFileW can
            // briefly observe no instance between accept loop iterations.
            std::thread::sleep(remaining.min(Duration::from_millis(5)));
        }
    }
}

fn is_transient_pipe_connect_error(error: u32) -> bool {
    matches!(error, ERROR_PIPE_BUSY | ERROR_FILE_NOT_FOUND)
}

fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub fn validate_pipe_name(name: &str) -> Result<()> {
    if !name.starts_with("\\\\.\\pipe\\vibelink-") || name.len() > 240 {
        bail!("manifest contains an invalid VibeLink named-pipe path");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_are_local_bounded_and_stable() {
        let first = execd_pipe_name(Path::new("C:/Users/test/VibeLink"));
        let second = execd_pipe_name(Path::new("c:/users/test/vibelink"));
        assert_eq!(first, second);
        assert!(first.starts_with("\\\\.\\pipe\\vibelink-execd-v1-"));
        assert!(validate_pipe_name(&first).is_ok());
        assert!(validate_pipe_name("tcp://127.0.0.1").is_err());
    }

    #[test]
    fn current_process_identity_uses_creation_time_not_pid_alone() {
        let pid = unsafe { GetCurrentProcessId() };
        let ticks = current_process_creation_ticks().unwrap();
        assert!(process_matches(pid, ticks));
        assert!(!process_matches(pid, ticks.saturating_add(1)));
    }

    #[test]
    fn pipe_instance_handoff_errors_are_retried() {
        assert!(is_transient_pipe_connect_error(ERROR_PIPE_BUSY));
        assert!(is_transient_pipe_connect_error(ERROR_FILE_NOT_FOUND));
        assert!(!is_transient_pipe_connect_error(5));
    }
}
