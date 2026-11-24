use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use jni::JNIEnv;
use jni::objects::{JObject, JString};
use jni::sys::jint;
use tokio_util::sync::CancellationToken;
use tun2proxy::{ArgDns, Args, ProxyParameters, general_run_async};

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_STOP_TOKEN: OnceLock<Mutex<Option<(u64, CancellationToken)>>> = OnceLock::new();

fn stop_token_slot() -> &'static Mutex<Option<(u64, CancellationToken)>> {
    ACTIVE_STOP_TOKEN.get_or_init(|| Mutex::new(None))
}

fn cancel_active_session() -> bool {
    if let Ok(mut guard) = stop_token_slot().lock()
        && let Some((_id, token)) = guard.take()
    {
        token.cancel();
        return true;
    }
    false
}

fn clear_session_if_current(session_id: u64) {
    if let Ok(mut guard) = stop_token_slot().lock()
        && guard.as_ref().is_some_and(|(id, _)| *id == session_id)
    {
        guard.take();
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_vibelink_app_VibeLinkVpnService_nativeStartTun2Proxy(
    mut env: JNIEnv,
    _thiz: JObject,
    proxy_url: JString,
    tun_fd: jint,
    tun_mtu: jint,
    dns_strategy: jint,
) -> jint {
    let proxy_str = match env.get_string(&proxy_url) {
        Ok(s) => s.to_string_lossy().into_owned(),
        Err(err) => {
            tracing::error!("[VibeLinkVpnTun] Failed to read proxy_url JNI string: {err}");
            return -10;
        }
    };

    if tun_fd < 0 {
        tracing::error!("[VibeLinkVpnTun] Invalid tun_fd: {tun_fd}");
        return -11;
    }

    let proxy_params = match ProxyParameters::try_from(proxy_str.as_str()) {
        Ok(p) => p,
        Err(err) => {
            tracing::error!("[VibeLinkVpnTun] Invalid proxy URL '{proxy_str}': {err}");
            return -12;
        }
    };

    let dns = match dns_strategy {
        0 => ArgDns::Virtual,
        1 => ArgDns::OverTcp,
        _ => ArgDns::Direct,
    };

    let mtu_u16 = u16::try_from(tun_mtu.clamp(1200, 9000)).unwrap_or(1500);

    // Ensure any lingering prior session token is cancelled before registering the new session.
    cancel_active_session();

    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let token = CancellationToken::new();
    if let Ok(mut guard) = stop_token_slot().lock() {
        *guard = Some((session_id, token.clone()));
    } else {
        return -13;
    }

    let mut args = Args::default();
    args.proxy(proxy_params)
        .tun_fd(Some(tun_fd))
        .close_fd_on_drop(false)
        .setup(false)
        .dns(dns);
    args.mtu = mtu_u16;

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            tracing::error!("[VibeLinkVpnTun] Failed to create Tokio runtime: {err}");
            clear_session_if_current(session_id);
            return -14;
        }
    };

    tracing::info!(
        "[VibeLinkVpnTun] Starting tun2proxy session={session_id} fd={tun_fd} mtu={mtu_u16} dns={dns:?}"
    );

    let run_res = rt.block_on(general_run_async(args, mtu_u16, false, token));

    clear_session_if_current(session_id);
    drop(rt);

    match run_res {
        Ok(sessions) => {
            tracing::info!("[VibeLinkVpnTun] Session={session_id} exited cleanly (sessions={sessions})");
            0
        }
        Err(err) => {
            tracing::error!("[VibeLinkVpnTun] Session={session_id} exited with error: {err}");
            -15
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_vibelink_app_VibeLinkVpnService_nativeStopTun2Proxy(
    _env: JNIEnv,
    _thiz: JObject,
) -> jint {
    if cancel_active_session() {
        tracing::info!("[VibeLinkVpnTun] Requested shutdown");
        0
    } else {
        1
    }
}
