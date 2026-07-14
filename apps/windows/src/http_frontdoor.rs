use crate::audit_http::{route_audit_request, AuditRouteConfig};
use crate::device_http::{
    route_device_mutation_request, route_device_request, DeviceMutationRouteConfig,
    DeviceRouteConfig,
};
use crate::doctor_http::{route_doctor_request, DoctorRouteConfig};
use crate::pairing_http::{
    pairing_request_requires_body, route_pairing_request, route_pairing_request_with_body,
    PairingRouteConfig,
};
use crate::settings_http::{
    route_settings_request, route_settings_request_with_body, settings_request_requires_body,
    SettingsRouteConfig,
};
use crate::status_http::{
    parse_request, route_status_request, StatusRouteConfig, MAX_HEADER_BYTES,
};
use anyhow::{bail, Context, Result};
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::process::Child;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const MAX_ACTIVE_CONNECTIONS: usize = 256;
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DIRECT_JSON_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone, Default)]
pub struct FrontdoorRoutes {
    status: Option<StatusRouteConfig>,
    doctor: Option<DoctorRouteConfig>,
    device: Option<DeviceRouteConfig>,
    device_mutation: Option<DeviceMutationRouteConfig>,
    audit: Option<AuditRouteConfig>,
    settings: Option<SettingsRouteConfig>,
    pairing: Option<PairingRouteConfig>,
}

impl FrontdoorRoutes {
    pub fn with_status(mut self, route: Option<StatusRouteConfig>) -> Self {
        self.status = route;
        self
    }

    pub fn with_doctor(mut self, route: Option<DoctorRouteConfig>) -> Self {
        self.doctor = route;
        self
    }

    pub fn with_device(mut self, route: Option<DeviceRouteConfig>) -> Self {
        self.device = route;
        self
    }

    pub fn with_device_mutation(mut self, route: Option<DeviceMutationRouteConfig>) -> Self {
        self.device_mutation = route;
        self
    }

    pub fn with_audit(mut self, route: Option<AuditRouteConfig>) -> Self {
        self.audit = route;
        self
    }

    pub fn with_settings(mut self, route: Option<SettingsRouteConfig>) -> Self {
        self.settings = route;
        self
    }

    pub fn with_pairing(mut self, route: Option<PairingRouteConfig>) -> Self {
        self.pairing = route;
        self
    }

    fn is_empty(&self) -> bool {
        self.status.is_none()
            && self.doctor.is_none()
            && self.device.is_none()
            && self.device_mutation.is_none()
            && self.audit.is_none()
            && self.settings.is_none()
            && self.pairing.is_none()
    }
}

pub fn serve(
    listener: TcpListener,
    upstream: SocketAddr,
    node: &mut Child,
    routes: FrontdoorRoutes,
) -> Result<()> {
    listener
        .set_nonblocking(true)
        .context("Failed to configure Rust HTTP front door")?;
    let active = Arc::new(AtomicUsize::new(0));

    loop {
        if let Some(status) = node
            .try_wait()
            .context("Failed to inspect loopback Node bridge")?
        {
            if status.success() {
                return Ok(());
            }
            bail!("Loopback Node bridge exited with status {status}");
        }

        match listener.accept() {
            Ok((mut client, _)) => {
                if active.fetch_add(1, Ordering::AcqRel) >= MAX_ACTIVE_CONNECTIONS {
                    active.fetch_sub(1, Ordering::AcqRel);
                    let _ = write_service_unavailable(&mut client);
                    continue;
                }

                let active = Arc::clone(&active);
                let routes = routes.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(client, upstream, &routes) {
                        eprintln!("Rust HTTP front door connection failed: {error}");
                    }
                    active.fetch_sub(1, Ordering::AcqRel);
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error).context("Rust HTTP front door accept failed"),
        }
    }
}

fn handle_connection(
    mut client: TcpStream,
    upstream: SocketAddr,
    routes: &FrontdoorRoutes,
) -> io::Result<()> {
    if routes.is_empty() {
        return proxy_connection(client, upstream);
    }

    let peer_ip = client
        .peer_addr()
        .map(|address| address.ip().to_string())
        .unwrap_or_default();
    let mut prefix = read_request_head(&mut client)?;
    if let Ok(request) = parse_request(&prefix) {
        if let Some(status_route) = routes.status.as_ref() {
            match route_status_request(&request, status_route) {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    status_route.record_fallback();
                    eprintln!("Rust Status route falling back to Node: {error:#}");
                }
            }
        }
        if let Some(doctor_route) = routes.doctor.as_ref() {
            match route_doctor_request(&request, doctor_route) {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    doctor_route.record_fallback();
                    eprintln!("Rust Doctor route falling back to Node: {error:#}");
                }
            }
        }
        if let Some(device_route) = routes.device.as_ref() {
            match route_device_request(&request, device_route) {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    device_route.record_fallback();
                    eprintln!("Rust Device route falling back to Node: {error:#}");
                }
            }
        }
        if let Some(device_mutation_route) = routes.device_mutation.as_ref() {
            match route_device_mutation_request(&request, &peer_ip, device_mutation_route) {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    device_mutation_route.record_fallback();
                    eprintln!(
                        "Rust Device mutation route falling back before ownership: {error:#}"
                    );
                }
            }
        }
        if let Some(audit_route) = routes.audit.as_ref() {
            match route_audit_request(&request, &peer_ip, audit_route) {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    audit_route.record_fallback();
                    eprintln!("Rust Audit route falling back to Node: {error:#}");
                }
            }
        }
        if let Some(settings_route) = routes.settings.as_ref() {
            let body = if settings_request_requires_body(&request) {
                match read_request_body(&mut client, &mut prefix, &request)? {
                    Some(body) => Some(body),
                    None => return proxy_connection_with_prefix(client, upstream, prefix),
                }
            } else {
                None
            };
            let result = if let Some(body) = body.as_deref() {
                route_settings_request_with_body(&request, &peer_ip, Some(body), settings_route)
            } else {
                route_settings_request(&request, &peer_ip, settings_route)
            };
            match result {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    settings_route.record_fallback();
                    eprintln!("Rust Settings route falling back before ownership: {error:#}");
                }
            }
        }
        if let Some(pairing_route) = routes.pairing.as_ref() {
            let body = if pairing_request_requires_body(&request) {
                match read_request_body(&mut client, &mut prefix, &request)? {
                    Some(body) => Some(body),
                    None => return proxy_connection_with_prefix(client, upstream, prefix),
                }
            } else {
                None
            };
            let result = if let Some(body) = body.as_deref() {
                route_pairing_request_with_body(&request, &peer_ip, Some(body), pairing_route)
            } else {
                route_pairing_request(&request, &peer_ip, pairing_route)
            };
            match result {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    pairing_route.record_fallback();
                    eprintln!("Rust Pairing route falling back before ownership: {error:#}");
                }
            }
        }
    }
    proxy_connection_with_prefix(client, upstream, prefix)
}

fn read_request_body(
    client: &mut TcpStream,
    prefix: &mut Vec<u8>,
    request: &crate::status_http::ParsedRequest,
) -> io::Result<Option<Vec<u8>>> {
    if request.header("transfer-encoding").is_some() {
        return Ok(None);
    }
    let content_length = match request.header("content-length") {
        Some(value) => match value.parse::<usize>() {
            Ok(length) if length <= MAX_DIRECT_JSON_BODY_BYTES => length,
            _ => return Ok(None),
        },
        None => 0,
    };
    let header_length = request.header_length();
    if prefix.len() < header_length {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "parsed header length exceeds request prefix",
        ));
    }
    let available = prefix.len() - header_length;
    if available < content_length {
        let mut remaining = content_length - available;
        let mut chunk = [0_u8; 8192];
        while remaining > 0 {
            let read_length = remaining.min(chunk.len());
            let size = client.read(&mut chunk[..read_length])?;
            if size == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "request body ended before Content-Length",
                ));
            }
            prefix.extend_from_slice(&chunk[..size]);
            remaining -= size;
        }
    }
    Ok(Some(
        prefix[header_length..header_length + content_length].to_vec(),
    ))
}

fn read_request_head(client: &mut TcpStream) -> io::Result<Vec<u8>> {
    client.set_nonblocking(false)?;
    client.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut bytes = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 2048];
    while bytes.len() <= MAX_HEADER_BYTES {
        match client.read(&mut chunk) {
            Ok(0) => break,
            Ok(size) => {
                bytes.extend_from_slice(&chunk[..size]);
                if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::TimedOut =>
            {
                break;
            }
            Err(error) => return Err(error),
        }
    }
    client.set_read_timeout(None)?;
    Ok(bytes)
}

pub fn proxy_connection(client: TcpStream, upstream_addr: SocketAddr) -> io::Result<()> {
    proxy_connection_with_prefix(client, upstream_addr, Vec::new())
}

fn proxy_connection_with_prefix(
    mut client: TcpStream,
    upstream_addr: SocketAddr,
    prefix: Vec<u8>,
) -> io::Result<()> {
    client.set_nonblocking(false)?;
    let mut upstream = match TcpStream::connect_timeout(&upstream_addr, UPSTREAM_CONNECT_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => return write_service_unavailable(&mut client),
    };
    client.set_nodelay(true)?;
    upstream.set_nodelay(true)?;

    if !prefix.is_empty() {
        upstream.write_all(&prefix)?;
    }

    let mut client_reader = client.try_clone()?;
    let mut upstream_writer = upstream.try_clone()?;
    let request = thread::spawn(move || {
        let result = io::copy(&mut client_reader, &mut upstream_writer);
        let _ = upstream_writer.shutdown(Shutdown::Write);
        result
    });

    let response = io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Write);
    let request = request
        .join()
        .map_err(|_| io::Error::other("front-door request copy thread panicked"))?;
    request?;
    response?;
    Ok(())
}

fn write_service_unavailable(client: &mut TcpStream) -> io::Result<()> {
    const BODY: &str = "{\"error\":\"Bridge backend unavailable.\"}";
    write!(
        client,
        "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n{}",
        BODY.len(),
        BODY
    )?;
    client.flush()
}

#[cfg(test)]
mod tests {
    use super::{handle_connection, proxy_connection, read_request_body, FrontdoorRoutes};
    use crate::audit_http::AuditRouteConfig;
    use crate::device_http::{DeviceMutationRouteConfig, DeviceRouteConfig};
    use crate::doctor_http::DoctorRouteConfig;
    use crate::pairing_http::PairingRouteConfig;
    use crate::status_http::StatusRouteConfig;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn proxy_preserves_bidirectional_bytes() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert_eq!(
                request,
                b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\n\r\n"
            );
            stream
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 20\r\n\r\n{\"error\":\"missing\"}")
                .unwrap();
        });

        let frontend = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let frontend_addr = frontend.local_addr().unwrap();
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            client.set_nonblocking(true).unwrap();
            proxy_connection(client, upstream_addr).unwrap();
        });

        let mut client = TcpStream::connect(frontend_addr).unwrap();
        client
            .write_all(b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\n\r\n")
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();

        assert_eq!(
            response,
            b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 20\r\n\r\n{\"error\":\"missing\"}"
        );
        proxy_thread.join().unwrap();
        upstream_thread.join().unwrap();
    }

    #[test]
    fn proxy_returns_keep_alive_response_before_client_disconnects() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = [0_u8; 1024];
            let size = stream.read(&mut request).unwrap();
            assert!(request[..size].ends_with(b"\r\n\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
                .unwrap();
            thread::sleep(std::time::Duration::from_millis(100));
        });

        let frontend = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let frontend_addr = frontend.local_addr().unwrap();
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            client.set_nonblocking(true).unwrap();
            proxy_connection(client, upstream_addr).unwrap();
        });

        let mut client = TcpStream::connect(frontend_addr).unwrap();
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: bridge.test\r\n\r\n")
            .unwrap();
        let mut response = [0_u8; 40];
        client.read_exact(&mut response).unwrap();

        assert_eq!(&response, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        client.shutdown(Shutdown::Both).unwrap();
        proxy_thread.join().unwrap();
        upstream_thread.join().unwrap();
    }

    #[test]
    fn reads_fragmented_content_length_body_and_preserves_request_bytes() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .write_all(b"POST /api/pairing-sessions HTTP/1.1\r\nHost: bridge.test\r\nContent-Length: 19\r\n\r\n{\"device")
                .unwrap();
            thread::sleep(std::time::Duration::from_millis(50));
            stream.write_all(b"Label\":\"A\"}").unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        let mut prefix = super::read_request_head(&mut stream).unwrap();
        let request = crate::status_http::parse_request(&prefix).unwrap();
        let body = read_request_body(&mut stream, &mut prefix, &request)
            .unwrap()
            .unwrap();
        assert_eq!(body, br#"{"deviceLabel":"A"}"#);
        assert!(prefix.ends_with(&body));
        client.join().unwrap();
    }

    #[test]
    fn status_route_failure_replays_the_original_request_to_node() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert_eq!(
                request,
                b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\n\r\n"
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"node\":true}")
                .unwrap();
        });

        let frontend = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let frontend_addr = frontend.local_addr().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let invalid_data_dir = std::env::temp_dir().join(format!(
            "vibelink-status-http-fallback-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&invalid_data_dir).unwrap();
        fs::write(invalid_data_dir.join("settings.json"), "{invalid-json").unwrap();
        let status_route = StatusRouteConfig::new(
            invalid_data_dir.clone(),
            upstream_addr,
            "secret".to_string(),
        );
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            let routes = FrontdoorRoutes::default().with_status(Some(status_route));
            handle_connection(client, upstream_addr, &routes).unwrap();
        });

        let mut client = TcpStream::connect(frontend_addr).unwrap();
        client
            .write_all(b"GET /api/status HTTP/1.1\r\nHost: bridge.test\r\n\r\n")
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();

        assert_eq!(
            response,
            b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"node\":true}"
        );
        proxy_thread.join().unwrap();
        upstream_thread.join().unwrap();
        fs::remove_dir_all(invalid_data_dir).unwrap();
    }

    #[test]
    fn doctor_route_pending_replays_the_original_request_to_node() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert_eq!(
                request,
                b"GET /api/doctor HTTP/1.1\r\nHost: bridge.test\r\n\r\n"
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"node\":true}")
                .unwrap();
        });

        let frontend = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let frontend_addr = frontend.local_addr().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let missing_data_dir = std::env::temp_dir().join(format!(
            "vibelink-doctor-http-missing-{}-{nonce}",
            std::process::id()
        ));
        assert!(!missing_data_dir.exists());
        let doctor_route =
            DoctorRouteConfig::new(missing_data_dir, upstream_addr, "secret".to_string());
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            let routes = FrontdoorRoutes::default().with_doctor(Some(doctor_route));
            handle_connection(client, upstream_addr, &routes).unwrap();
        });

        let mut client = TcpStream::connect(frontend_addr).unwrap();
        client
            .write_all(b"GET /api/doctor HTTP/1.1\r\nHost: bridge.test\r\n\r\n")
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();

        assert_eq!(
            response,
            b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"node\":true}"
        );
        proxy_thread.join().unwrap();
        upstream_thread.join().unwrap();
    }

    #[test]
    fn device_route_failure_replays_the_original_request_to_node() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert_eq!(
                request,
                b"GET /api/devices HTTP/1.1\r\nHost: bridge.test\r\n\r\n"
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"node\":true}")
                .unwrap();
        });

        let frontend = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let frontend_addr = frontend.local_addr().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let invalid_data_dir = std::env::temp_dir().join(format!(
            "vibelink-devices-http-fallback-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&invalid_data_dir).unwrap();
        fs::write(invalid_data_dir.join("settings.json"), "{invalid-json").unwrap();
        let device_route = DeviceRouteConfig::new(invalid_data_dir.clone());
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            let routes = FrontdoorRoutes::default().with_device(Some(device_route));
            handle_connection(client, upstream_addr, &routes).unwrap();
        });

        let mut client = TcpStream::connect(frontend_addr).unwrap();
        client
            .write_all(b"GET /api/devices HTTP/1.1\r\nHost: bridge.test\r\n\r\n")
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();

        assert_eq!(
            response,
            b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"node\":true}"
        );
        proxy_thread.join().unwrap();
        upstream_thread.join().unwrap();
        fs::remove_dir_all(invalid_data_dir).unwrap();
    }

    #[test]
    fn audit_route_failure_replays_the_original_request_to_node() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert_eq!(
                request,
                b"GET /api/audit-log?limit=5 HTTP/1.1\r\nHost: bridge.test\r\n\r\n"
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"node\":true}")
                .unwrap();
        });

        let frontend = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let frontend_addr = frontend.local_addr().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let invalid_data_dir = std::env::temp_dir().join(format!(
            "vibelink-audit-http-fallback-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&invalid_data_dir).unwrap();
        fs::write(invalid_data_dir.join("settings.json"), "{invalid-json").unwrap();
        let audit_route = AuditRouteConfig::new(invalid_data_dir.clone());
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            let routes = FrontdoorRoutes::default().with_audit(Some(audit_route));
            handle_connection(client, upstream_addr, &routes).unwrap();
        });

        let mut client = TcpStream::connect(frontend_addr).unwrap();
        client
            .write_all(b"GET /api/audit-log?limit=5 HTTP/1.1\r\nHost: bridge.test\r\n\r\n")
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();

        assert_eq!(
            response,
            b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"node\":true}"
        );
        proxy_thread.join().unwrap();
        upstream_thread.join().unwrap();
        fs::remove_dir_all(invalid_data_dir).unwrap();
    }

    #[test]
    fn device_mutation_failure_rolls_back_without_replaying_to_node() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        upstream.set_nonblocking(true).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let frontend = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let frontend_addr = frontend.local_addr().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!(
            "vibelink-device-mutation-no-replay-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"]}"#,
        )
        .unwrap();
        let database = rusqlite::Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        database
            .execute_batch(
                "CREATE TABLE devices (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT,
                    revoked_at TEXT,
                    expires_at TEXT,
                    rotated_at TEXT,
                    meta_json TEXT
                );
                CREATE TABLE audit_log (cursor INTEGER PRIMARY KEY AUTOINCREMENT);",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (
                    id, label, token_hash, created_at, last_seen_at, expires_at, meta_json
                 ) VALUES ('device-current', 'Phone', ?1, '2026-01-01T00:00:00.000Z',
                           '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '{}')",
                [crate::status_http::hash_token("active-token")],
            )
            .unwrap();
        drop(database);
        let mutation_route = DeviceMutationRouteConfig::new(data_dir.clone());
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            let routes = FrontdoorRoutes::default().with_device_mutation(Some(mutation_route));
            handle_connection(client, upstream_addr, &routes).unwrap();
        });

        let mut client = TcpStream::connect(frontend_addr).unwrap();
        client
            .write_all(b"POST /api/devices/device-current/revoke HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer active-token\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 500 Internal Server Error"));
        assert!(response.contains("X-VibeLink-Control-Plane: rust"));
        proxy_thread.join().unwrap();
        assert_eq!(
            upstream.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );

        let database = rusqlite::Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let revoked_at = database
            .query_row(
                "SELECT revoked_at FROM devices WHERE id = 'device-current'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap();
        assert!(revoked_at.is_none());
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }

    #[test]
    fn pairing_decision_failure_rolls_back_without_replaying_to_node() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        upstream.set_nonblocking(true).unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let frontend = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let frontend_addr = frontend.local_addr().unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!(
            "vibelink-pairing-no-replay-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"]}"#,
        )
        .unwrap();
        let database = rusqlite::Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        database
            .execute_batch(
                "CREATE TABLE devices (
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
                    expires_at TEXT, rotated_at TEXT, meta_json TEXT
                );
                CREATE TABLE pairing_sessions (
                    id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, label TEXT, ip TEXT,
                    user_agent TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL, approved_at TEXT, approved_by_device_id TEXT,
                    claimed_at TEXT, device_id TEXT, meta_json TEXT
                );
                CREATE TABLE audit_log (cursor INTEGER PRIMARY KEY AUTOINCREMENT);",
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO devices (
                    id, label, token_hash, created_at, last_seen_at, expires_at, meta_json
                 ) VALUES ('device-admin', 'Admin', ?1, '2026-01-01T00:00:00.000Z',
                           '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '{}')",
                [crate::status_http::hash_token("admin-token")],
            )
            .unwrap();
        database
            .execute(
                "INSERT INTO pairing_sessions (
                    id, code_hash, label, status, created_at, expires_at, meta_json
                 ) VALUES ('pairing-pending', 'hash', 'Phone', 'pending',
                           '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '{}')",
                [],
            )
            .unwrap();
        drop(database);
        let pairing_route = PairingRouteConfig::new(data_dir.clone());
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            let routes = FrontdoorRoutes::default().with_pairing(Some(pairing_route));
            handle_connection(client, upstream_addr, &routes).unwrap();
        });

        let mut client = TcpStream::connect(frontend_addr).unwrap();
        client
            .write_all(b"POST /api/pairing-sessions/pairing-pending/approve HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer admin-token\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 500 Internal Server Error"));
        assert!(response.contains("X-VibeLink-Control-Plane: rust"));
        proxy_thread.join().unwrap();
        assert_eq!(
            upstream.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );

        let database = rusqlite::Connection::open(data_dir.join("mobile-agent.sqlite")).unwrap();
        let status = database
            .query_row(
                "SELECT status FROM pairing_sessions WHERE id = 'pairing-pending'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
        drop(database);
        fs::remove_dir_all(data_dir).unwrap();
    }
}
