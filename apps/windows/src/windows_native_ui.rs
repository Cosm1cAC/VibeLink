use anyhow::{Context, Result};
use std::ffi::c_void;
use std::io::Read;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{GlobalFree, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CreateFontW, CreateSolidBrush, DeleteObject, UpdateWindow, HBRUSH, HFONT,
};
use windows_sys::Win32::System::Console::FreeConsole;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::System::SystemServices::SS_LEFT;
use windows_sys::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows_sys::Win32::UI::Shell::{
    ShellExecuteW, Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE,
    NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const WINDOW_CLASS: &str = "VibeLinkNativeAdmin";
const WM_TRAY: u32 = WM_USER + 42;
const ID_PAIR: usize = 101;
const ID_REFRESH: usize = 102;
const ID_DOCTOR: usize = 103;
const ID_SETTINGS: usize = 104;
const ID_ROLLBACK: usize = 105;
const ID_EXIT: usize = 106;
const ID_UPDATE: usize = 107;
const ID_START: usize = 108;
const SMOKE_EXIT_TIMER: usize = 9001;
const SMOKE_VALIDATE_TIMER: usize = 9002;
const SMOKE_ACTION_TIMER: usize = 9003;
const SMOKE_START_TIMER: usize = 9004;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdminAction {
    Exit,
    StartServer,
    RestartCompatibility,
}

pub struct AdminConfig {
    pub base_url: String,
    pub pairing_base_url: String,
    pub device_label: String,
    pub data_dir: PathBuf,
    pub compatibility_mode: bool,
    pub server_started: bool,
}

struct AdminState {
    config: AdminConfig,
    action: AdminAction,
    status_label: HWND,
    pairing_value: HWND,
    tray: NOTIFYICONDATAW,
    regular_font: HFONT,
    heading_font: HFONT,
    smoke_error: Option<String>,
}

pub fn run(config: AdminConfig) -> Result<AdminAction> {
    if let Some(action) = headless_smoke_action(&config) {
        return Ok(action);
    }

    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let instance = GetModuleHandleW(std::ptr::null());
        if instance.is_null() {
            anyhow::bail!("GetModuleHandleW failed");
        }
        let class = wide(WINDOW_CLASS);
        let cursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
        let background = CreateSolidBrush(0x00FA_FBFB);
        if background.is_null() {
            anyhow::bail!("CreateSolidBrush failed");
        }
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: cursor,
            hbrBackground: background as HBRUSH,
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        if RegisterClassW(&wc) == 0 {
            DeleteObject(background);
            anyhow::bail!("RegisterClassW failed: {}", std::io::Error::last_os_error());
        }
        let regular_font = create_font(17, 400);
        let heading_font = create_font(23, 600);
        if regular_font.is_null() || heading_font.is_null() {
            if !regular_font.is_null() {
                DeleteObject(regular_font);
            }
            if !heading_font.is_null() {
                DeleteObject(heading_font);
            }
            DeleteObject(background);
            anyhow::bail!("CreateFontW failed");
        }
        let mut state = Box::new(AdminState {
            config,
            action: AdminAction::Exit,
            status_label: std::ptr::null_mut(),
            pairing_value: std::ptr::null_mut(),
            tray: std::mem::zeroed(),
            regular_font,
            heading_font,
            smoke_error: None,
        });
        let title = wide("VibeLink Administration");
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            700,
            470,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            state.as_mut() as *mut AdminState as *mut c_void,
        );
        if hwnd.is_null() {
            DeleteObject(regular_font);
            DeleteObject(heading_font);
            UnregisterClassW(class.as_ptr(), instance);
            DeleteObject(background);
            anyhow::bail!("CreateWindowExW failed");
        }
        if let Err(error) =
            create_controls(hwnd, &mut state).and_then(|_| add_tray_icon(hwnd, &mut state))
        {
            DestroyWindow(hwnd);
            UnregisterClassW(class.as_ptr(), instance);
            DeleteObject(background);
            return Err(error);
        }
        if let Some(milliseconds) = smoke_exit_milliseconds() {
            SetTimer(hwnd, SMOKE_EXIT_TIMER, milliseconds, None);
        }
        if smoke_start_server() && !state.config.server_started {
            SetTimer(hwnd, SMOKE_START_TIMER, 750, None);
        }
        if state.config.server_started && smoke_validate_admin_endpoints() {
            SetTimer(hwnd, SMOKE_VALIDATE_TIMER, 750, None);
        }
        if state.config.server_started
            && !state.config.compatibility_mode
            && (smoke_pair_android() || smoke_restart_compatibility())
        {
            SetTimer(hwnd, SMOKE_ACTION_TIMER, 1200, None);
        }
        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);
        let _ = FreeConsole();
        let mut message: MSG = std::mem::zeroed();
        let message_error = loop {
            let result = GetMessageW(&mut message, std::ptr::null_mut(), 0, 0);
            if result == -1 {
                break Some(std::io::Error::last_os_error());
            }
            if result == 0 {
                break None;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        };
        let action = state.action;
        if let Some(error) = state.smoke_error.as_deref() {
            UnregisterClassW(class.as_ptr(), instance);
            DeleteObject(background);
            anyhow::bail!("Native admin validation failed: {error}");
        }
        if let Some(error) = message_error {
            DestroyWindow(hwnd);
            UnregisterClassW(class.as_ptr(), instance);
            DeleteObject(background);
            return Err(error.into());
        }
        UnregisterClassW(class.as_ptr(), instance);
        DeleteObject(background);
        Ok(action)
    }
}

unsafe fn create_controls(hwnd: HWND, state: &mut AdminState) -> Result<()> {
    let font = state.regular_font;
    create_label(hwnd, "VibeLink", 28, 22, 620, 34, state.heading_font)?;
    create_label(hwnd, "Native bridge administration", 28, 56, 620, 22, font)?;
    create_label(hwnd, "Bridge", 28, 98, 100, 22, font)?;
    state.status_label = create_label(
        hwnd,
        &format!(
            "{} at {} | {}",
            if state.config.server_started {
                "Ready"
            } else {
                "Stopped"
            },
            state.config.base_url,
            if state.config.compatibility_mode {
                "Compatibility runtime"
            } else {
                "Rust runtime"
            }
        ),
        132,
        98,
        520,
        22,
        font,
    )?;
    create_label(hwnd, "Android pairing", 28, 138, 120, 22, font)?;
    state.pairing_value = create_label(hwnd, "No active pairing session", 28, 164, 624, 44, font)?;
    create_button(
        hwnd,
        if state.config.server_started {
            "Server running"
        } else {
            "Start server"
        },
        ID_START,
        472,
        222,
        136,
        34,
        font,
    )?;
    if state.config.server_started {
        EnableWindow(GetDlgItem(hwnd, ID_START as i32), 0);
    }
    create_button(hwnd, "Pair Android", ID_PAIR, 28, 222, 136, 34, font)?;
    create_button(hwnd, "Refresh status", ID_REFRESH, 176, 222, 136, 34, font)?;
    create_button(hwnd, "Run diagnostics", ID_DOCTOR, 324, 222, 136, 34, font)?;
    create_button(hwnd, "Settings folder", ID_SETTINGS, 28, 274, 136, 34, font)?;
    create_button(
        hwnd,
        "Check for updates",
        ID_UPDATE,
        176,
        274,
        148,
        34,
        font,
    )?;
    create_button(
        hwnd,
        "Restart in compatibility mode",
        ID_ROLLBACK,
        28,
        334,
        244,
        34,
        font,
    )?;
    if state.config.compatibility_mode {
        EnableWindow(GetDlgItem(hwnd, ID_ROLLBACK as i32), 0);
    }
    if !state.config.server_started {
        EnableWindow(GetDlgItem(hwnd, ID_PAIR as i32), 0);
        EnableWindow(GetDlgItem(hwnd, ID_REFRESH as i32), 0);
        EnableWindow(GetDlgItem(hwnd, ID_DOCTOR as i32), 0);
        EnableWindow(GetDlgItem(hwnd, ID_ROLLBACK as i32), 0);
    }
    create_button(hwnd, "Exit VibeLink", ID_EXIT, 472, 334, 136, 34, font)?;
    create_label(
        hwnd,
        "Closing this window exits VibeLink and stops the managed server.",
        28,
        394,
        624,
        22,
        font,
    )?;
    Ok(())
}

unsafe fn create_label(
    parent: HWND,
    text: &str,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    font: HFONT,
) -> Result<HWND> {
    let class = wide("STATIC");
    let value = wide(text);
    let hwnd = CreateWindowExW(
        0,
        class.as_ptr(),
        value.as_ptr(),
        WS_CHILD | WS_VISIBLE | SS_LEFT,
        x,
        y,
        width,
        height,
        parent,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null(),
    );
    if hwnd.is_null() {
        anyhow::bail!("CreateWindowExW STATIC failed");
    }
    SendMessageW(hwnd, WM_SETFONT, font as WPARAM, 1);
    Ok(hwnd)
}

#[allow(
    clippy::too_many_arguments,
    reason = "thin wrapper keeps Win32 control geometry explicit at each call site"
)]
unsafe fn create_button(
    parent: HWND,
    text: &str,
    id: usize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    font: HFONT,
) -> Result<()> {
    let class = wide("BUTTON");
    let value = wide(text);
    let hwnd = CreateWindowExW(
        0,
        class.as_ptr(),
        value.as_ptr(),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON as u32,
        x,
        y,
        width,
        height,
        parent,
        id as *mut c_void,
        std::ptr::null_mut(),
        std::ptr::null(),
    );
    if hwnd.is_null() {
        anyhow::bail!("CreateWindowExW BUTTON failed");
    }
    SendMessageW(hwnd, WM_SETFONT, font as WPARAM, 1);
    Ok(())
}

unsafe fn add_tray_icon(hwnd: HWND, state: &mut AdminState) -> Result<()> {
    state.tray.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    state.tray.hWnd = hwnd;
    state.tray.uID = 1;
    state.tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    state.tray.uCallbackMessage = WM_TRAY;
    state.tray.hIcon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);
    let tip = wide("VibeLink | Bridge ready");
    for (target, source) in state.tray.szTip.iter_mut().zip(tip.iter()) {
        *target = *source;
    }
    if Shell_NotifyIconW(NIM_ADD, &state.tray) == 0 {
        anyhow::bail!("Shell_NotifyIconW failed");
    }
    Ok(())
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut AdminState;
    match message {
        WM_COMMAND if !state.is_null() => {
            handle_command(hwnd, &mut *state, wparam & 0xffff);
            0
        }
        WM_TIMER if wparam == SMOKE_EXIT_TIMER && !state.is_null() => {
            (*state).action = AdminAction::Exit;
            DestroyWindow(hwnd);
            0
        }
        WM_TIMER if wparam == SMOKE_START_TIMER && !state.is_null() => {
            KillTimer(hwnd, SMOKE_START_TIMER);
            if !(*state).config.server_started {
                (*state).action = AdminAction::StartServer;
                DestroyWindow(hwnd);
            }
            0
        }
        WM_TIMER if wparam == SMOKE_VALIDATE_TIMER && !state.is_null() => {
            KillTimer(hwnd, SMOKE_VALIDATE_TIMER);
            let validation = crate::status_http::native_admin_status(&(*state).config.data_dir)
                .and_then(|_| crate::doctor_http::native_admin_doctor(&(*state).config.data_dir));
            if let Err(error) = validation {
                (*state).smoke_error = Some(format!("{error:#}"));
                DestroyWindow(hwnd);
            }
            0
        }
        WM_TIMER if wparam == SMOKE_ACTION_TIMER && !state.is_null() => {
            KillTimer(hwnd, SMOKE_ACTION_TIMER);
            if smoke_pair_android() {
                if let Err(error) = super::create_pairing_session(
                    &(*state).config.base_url,
                    &(*state).config.device_label,
                ) {
                    (*state).smoke_error = Some(format!("pairing: {error:#}"));
                    DestroyWindow(hwnd);
                    return 0;
                }
            }
            if smoke_restart_compatibility() {
                (*state).action = AdminAction::RestartCompatibility;
                DestroyWindow(hwnd);
            }
            0
        }
        WM_CLOSE => {
            if !state.is_null() {
                (*state).action = AdminAction::Exit;
            }
            DestroyWindow(hwnd);
            0
        }
        WM_TRAY if lparam as u32 == WM_LBUTTONUP || lparam as u32 == WM_RBUTTONUP => {
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, SMOKE_EXIT_TIMER);
            KillTimer(hwnd, SMOKE_VALIDATE_TIMER);
            KillTimer(hwnd, SMOKE_ACTION_TIMER);
            KillTimer(hwnd, SMOKE_START_TIMER);
            if !state.is_null() {
                Shell_NotifyIconW(NIM_DELETE, &(*state).tray);
                DeleteObject((*state).regular_font);
                DeleteObject((*state).heading_font);
            }
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

unsafe fn handle_command(hwnd: HWND, state: &mut AdminState, id: usize) {
    match id {
        ID_START => {
            if !state.config.server_started {
                state.action = AdminAction::StartServer;
                DestroyWindow(hwnd);
            }
        }
        ID_PAIR => {
            match super::create_pairing_session(&state.config.base_url, &state.config.device_label)
            {
                Ok(session) => {
                    let uri = super::android_pairing_uri(&state.config.pairing_base_url, &session);
                    set_text(state.pairing_value, &uri);
                    if copy_text(hwnd, &uri).is_err() {
                        message(
                            hwnd,
                            "Pairing session created, but the link could not be copied.",
                            "VibeLink",
                        );
                    }
                }
                Err(error) => message(
                    hwnd,
                    &format!("Could not create pairing session.\n\n{error:#}"),
                    "VibeLink pairing",
                ),
            }
        }
        ID_REFRESH => {
            let status = crate::status_http::native_admin_status(&state.config.data_dir);
            set_text(
                state.status_label,
                &format!(
                    "{} at {} | {}",
                    if status.is_ok() {
                        "Ready"
                    } else {
                        "Unavailable"
                    },
                    state.config.base_url,
                    if state.config.compatibility_mode {
                        "Compatibility runtime"
                    } else {
                        "Rust runtime"
                    }
                ),
            );
        }
        ID_DOCTOR => match crate::doctor_http::native_admin_doctor(&state.config.data_dir) {
            Ok(report) => {
                let checks = report["checks"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let failed = checks
                    .iter()
                    .filter(|check| check["ok"].as_bool() == Some(false))
                    .count();
                message(
                    hwnd,
                    &format!(
                        "{} checks completed. {} require attention.",
                        checks.len(),
                        failed
                    ),
                    "VibeLink diagnostics",
                );
            }
            Err(error) => message(
                hwnd,
                &format!("Diagnostics request failed.\n\n{error:#}"),
                "VibeLink diagnostics",
            ),
        },
        ID_SETTINGS => {
            let operation = wide("open");
            let path = wide(&state.config.data_dir.to_string_lossy());
            ShellExecuteW(
                hwnd,
                operation.as_ptr(),
                path.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
        ID_UPDATE => check_for_updates(hwnd),
        ID_ROLLBACK => {
            state.action = AdminAction::RestartCompatibility;
            DestroyWindow(hwnd);
        }
        ID_EXIT => {
            state.action = AdminAction::Exit;
            DestroyWindow(hwnd);
        }
        _ => {}
    }
}

unsafe fn check_for_updates(hwnd: HWND) {
    let result: Result<serde_json::Value> = (|| {
        let response = ureq::get("https://api.github.com/repos/Cosm1cAC/VibeLink/releases/latest")
            .set("User-Agent", "VibeLink-native-admin")
            .timeout(std::time::Duration::from_secs(8))
            .call()?;
        let mut reader = response.into_reader().take(1024 * 1024);
        Ok(serde_json::from_reader(&mut reader)?)
    })();
    match result {
        Ok(release) => match latest_release_tag(&release) {
            Ok(latest) => message(
                hwnd,
                &format!(
                    "Installed: {}\nLatest release: {latest}",
                    env!("CARGO_PKG_VERSION")
                ),
                "VibeLink updates",
            ),
            Err(error) => message(
                hwnd,
                &format!("Release response was invalid.\n\n{error:#}"),
                "VibeLink updates",
            ),
        },
        Err(error) => message(
            hwnd,
            &format!("Could not check releases.\n\n{error}"),
            "VibeLink updates",
        ),
    }
}

fn latest_release_tag(release: &serde_json::Value) -> Result<&str> {
    release["tag_name"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .context("Latest release tag is missing or invalid")
}

unsafe fn set_text(hwnd: HWND, text: &str) {
    let value = wide(text);
    SetWindowTextW(hwnd, value.as_ptr());
}
unsafe fn message(hwnd: HWND, text: &str, title: &str) {
    let text = wide(text);
    let title = wide(title);
    MessageBoxW(
        hwnd,
        text.as_ptr(),
        title.as_ptr(),
        MB_OK | MB_ICONINFORMATION,
    );
}

unsafe fn copy_text(hwnd: HWND, text: &str) -> Result<()> {
    let value = wide(text);
    if OpenClipboard(hwnd) == 0 {
        anyhow::bail!("OpenClipboard failed");
    }
    EmptyClipboard();
    let memory = GlobalAlloc(GMEM_MOVEABLE, value.len() * 2);
    if memory.is_null() {
        CloseClipboard();
        anyhow::bail!("GlobalAlloc failed");
    }
    let target = GlobalLock(memory) as *mut u16;
    if target.is_null() {
        GlobalFree(memory);
        CloseClipboard();
        anyhow::bail!("GlobalLock failed");
    }
    std::ptr::copy_nonoverlapping(value.as_ptr(), target, value.len());
    GlobalUnlock(memory);
    if SetClipboardData(CF_UNICODETEXT as u32, memory).is_null() {
        GlobalFree(memory);
        CloseClipboard();
        anyhow::bail!("SetClipboardData failed");
    }
    CloseClipboard();
    Ok(())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn smoke_exit_milliseconds() -> Option<u32> {
    std::env::var("VIBELINK_NATIVE_UI_SMOKE_EXIT_MS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .map(|value| value.clamp(250, 60_000))
}

fn smoke_validate_admin_endpoints() -> bool {
    smoke_flag("VIBELINK_NATIVE_UI_SMOKE_VALIDATE")
}

fn smoke_pair_android() -> bool {
    smoke_flag("VIBELINK_NATIVE_UI_SMOKE_PAIR")
}

fn smoke_restart_compatibility() -> bool {
    smoke_flag("VIBELINK_NATIVE_UI_SMOKE_ROLLBACK")
}

fn smoke_start_server() -> bool {
    smoke_flag("VIBELINK_NATIVE_UI_SMOKE_START")
}

fn headless_smoke_action(config: &AdminConfig) -> Option<AdminAction> {
    if smoke_start_server() && !config.server_started {
        return Some(AdminAction::StartServer);
    }
    if smoke_start_server() && config.server_started {
        if let Some(milliseconds) = smoke_exit_milliseconds() {
            thread::sleep(Duration::from_millis(milliseconds as u64));
            return Some(AdminAction::Exit);
        }
    }
    None
}

fn smoke_flag(name: &str) -> bool {
    std::env::var(name).ok().as_deref() == Some("1")
}

unsafe fn create_font(height: i32, weight: i32) -> HFONT {
    let face = wide("Segoe UI");
    CreateFontW(
        -height,
        0,
        0,
        0,
        weight,
        0,
        0,
        0,
        1,
        0,
        0,
        5,
        0,
        face.as_ptr(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_bounded_release_tags() {
        assert_eq!(
            latest_release_tag(&serde_json::json!({ "tag_name": "v1.2.3" })).unwrap(),
            "v1.2.3"
        );
        assert!(latest_release_tag(&serde_json::json!({ "tag_name": "" })).is_err());
        assert!(latest_release_tag(&serde_json::json!({ "tag_name": "x".repeat(65) })).is_err());
    }

    #[test]
    fn start_server_action_is_distinct_from_exit_and_rollback() {
        assert_ne!(AdminAction::StartServer, AdminAction::Exit);
        assert_ne!(AdminAction::StartServer, AdminAction::RestartCompatibility);
    }

    #[test]
    fn headless_smoke_starts_server_without_a_window() {
        std::env::set_var("VIBELINK_NATIVE_UI_SMOKE_START", "1");
        std::env::remove_var("VIBELINK_NATIVE_UI_SMOKE_EXIT_MS");
        let action = headless_smoke_action(&AdminConfig {
            base_url: "http://127.0.0.1:1".to_string(),
            pairing_base_url: "http://127.0.0.1:1".to_string(),
            device_label: "test".to_string(),
            data_dir: PathBuf::from("C:/tmp/vibelink-test"),
            compatibility_mode: false,
            server_started: false,
        });
        std::env::remove_var("VIBELINK_NATIVE_UI_SMOKE_START");
        assert_eq!(action, Some(AdminAction::StartServer));
    }
}
