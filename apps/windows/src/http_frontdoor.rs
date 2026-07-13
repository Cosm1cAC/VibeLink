use crate::doctor_http::{route_doctor_request, DoctorRouteConfig};
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

pub fn serve(
    listener: TcpListener,
    upstream: SocketAddr,
    node: &mut Child,
    status_route: Option<StatusRouteConfig>,
    doctor_route: Option<DoctorRouteConfig>,
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
                let status_route = status_route.clone();
                let doctor_route = doctor_route.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(
                        client,
                        upstream,
                        status_route.as_ref(),
                        doctor_route.as_ref(),
                    ) {
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
    status_route: Option<&StatusRouteConfig>,
    doctor_route: Option<&DoctorRouteConfig>,
) -> io::Result<()> {
    if status_route.is_none() && doctor_route.is_none() {
        return proxy_connection(client, upstream);
    }

    let prefix = read_request_head(&mut client)?;
    if let Ok(request) = parse_request(&prefix) {
        if let Some(status_route) = status_route {
            match route_status_request(&request, status_route) {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    status_route.record_fallback();
                    eprintln!("Rust Status route falling back to Node: {error:#}");
                }
            }
        }
        if let Some(doctor_route) = doctor_route {
            match route_doctor_request(&request, doctor_route) {
                Ok(Some(response)) => return response.write_to(&mut client),
                Ok(None) => {}
                Err(error) => {
                    doctor_route.record_fallback();
                    eprintln!("Rust Doctor route falling back to Node: {error:#}");
                }
            }
        }
    }
    proxy_connection_with_prefix(client, upstream, prefix)
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
    use super::{handle_connection, proxy_connection};
    use crate::doctor_http::DoctorRouteConfig;
    use crate::status_http::StatusRouteConfig;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::thread;

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
        let missing_data_dir = PathBuf::from("Z:/vibelink-status-http-missing");
        let status_route =
            StatusRouteConfig::new(missing_data_dir, upstream_addr, "secret".to_string());
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            handle_connection(client, upstream_addr, Some(&status_route), None).unwrap();
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
        let missing_data_dir = PathBuf::from("Z:/vibelink-doctor-http-missing");
        let doctor_route =
            DoctorRouteConfig::new(missing_data_dir, upstream_addr, "secret".to_string());
        let proxy_thread = thread::spawn(move || {
            let (client, _) = frontend.accept().unwrap();
            handle_connection(client, upstream_addr, None, Some(&doctor_route)).unwrap();
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
}
