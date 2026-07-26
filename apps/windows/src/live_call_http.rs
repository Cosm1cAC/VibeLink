use crate::live_call_asr::{
    normalize_pcm16le, transcribe, VadSegmenter, WhisperConfig, TARGET_SAMPLE_RATE,
};
use crate::live_call_runtime::{
    enforce_pcm_retention, AudioAcceptance, LiveCallRuntime, PcmRecording,
};
use crate::status_http::{
    authenticate_route_request, HttpRouteResponse, ParsedRequest, RouteAuthentication,
};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tungstenite::Message;

#[allow(dead_code, reason = "consumed by the runtime route registry extractor")]
pub const LIVE_CALL_RUNTIME_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/live-calls"),
    ("POST", "/api/live-calls"),
    ("GET", "/api/live-calls/asr-providers"),
    ("GET", "/api/live-calls/:id"),
    ("POST", "/api/live-calls/:id/stop"),
    ("POST", "/api/live-calls/:id/pause"),
    ("POST", "/api/live-calls/:id/resume"),
    ("POST", "/api/live-calls/:id/level"),
    ("POST", "/api/live-calls/:id/transcript"),
    ("POST", "/api/live-calls/:id/answer"),
    ("GET", "/api/live-calls/:id/asr-checkpoints"),
    ("POST", "/api/live-calls/:id/asr-recover"),
    ("GET", "/api/live-calls/:id/events"),
    ("GET", "/api/live-calls/:id/events/catch-up"),
];

const MAX_PENDING_QUESTIONS: usize = 128;
const MAX_AUDIO_FRAME_BYTES: usize = 1024 * 1024;
const MAX_RETAINED_PCM_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ASR_CHECKPOINT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct LiveCallRouteConfig {
    data_dir: PathBuf,
    runtime: Arc<Mutex<LiveCallRuntime>>,
    checkpoint: PathBuf,
    active_recordings: Arc<Mutex<BTreeSet<PathBuf>>>,
    _projection_worker: Option<Arc<ProjectionWorker>>,
}

impl LiveCallRouteConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        let checkpoint = data_dir.join("live-call").join("runtime.json");
        let runtime = if checkpoint.exists() || checkpoint.with_extension("json.bak").exists() {
            LiveCallRuntime::load(&checkpoint, MAX_PENDING_QUESTIONS)
                .unwrap_or_else(|_| LiveCallRuntime::new(MAX_PENDING_QUESTIONS))
        } else {
            LiveCallRuntime::new(MAX_PENDING_QUESTIONS)
        };
        let runtime = Arc::new(Mutex::new(runtime));
        #[cfg(not(test))]
        let projection_worker = Some(ProjectionWorker::start(
            data_dir.clone(),
            Arc::clone(&runtime),
            checkpoint.clone(),
        ));
        #[cfg(test)]
        let projection_worker = None;
        Self {
            data_dir,
            runtime,
            checkpoint,
            active_recordings: Arc::new(Mutex::new(BTreeSet::new())),
            _projection_worker: projection_worker,
        }
    }

    fn persist_runtime(&self) -> Result<()> {
        self.runtime
            .lock()
            .map_err(|_| anyhow::anyhow!("live call runtime lock poisoned"))?
            .save(&self.checkpoint)
    }

    fn queue_question(&self, session_id: &str, question_id: &str, text: &str) -> Result<()> {
        self.runtime
            .lock()
            .map_err(|_| anyhow::anyhow!("live call runtime lock poisoned"))?
            .queue_question(session_id, question_id, text)?;
        self.persist_runtime()
    }

    #[cfg(test)]
    fn pending_question_count(&self, session_id: &str) -> usize {
        self.runtime
            .lock()
            .map(|runtime| runtime.pending_questions(session_id).len())
            .unwrap_or(0)
    }

    fn acknowledge_questions(&self, session_id: &str) -> Result<usize> {
        let acknowledged = self
            .runtime
            .lock()
            .map_err(|_| anyhow::anyhow!("live call runtime lock poisoned"))?
            .acknowledge_all_questions(session_id);
        self.persist_runtime()?;
        Ok(acknowledged)
    }

    fn acknowledge_question(&self, session_id: &str, question_id: &str) -> Result<bool> {
        let acknowledged = self
            .runtime
            .lock()
            .map_err(|_| anyhow::anyhow!("live call runtime lock poisoned"))?
            .acknowledge_question(session_id, question_id)?;
        self.persist_runtime()?;
        Ok(acknowledged)
    }

    #[cfg(test)]
    fn list_events(&self, session_id: &str, after: i64, limit: usize) -> Result<Vec<Value>> {
        let connection = open_database(&self.data_dir)?;
        list_events(&connection, session_id, after, limit)
    }

    fn accept_audio(&self, session_id: &str, bytes: u64, checkpoint: bool) -> Result<u64> {
        let (sequence, acceptance) = self
            .runtime
            .lock()
            .map_err(|_| anyhow::anyhow!("live call runtime lock poisoned"))?
            .accept_next_audio(session_id, bytes)?;
        if !matches!(acceptance, AudioAcceptance::Accepted) {
            bail!("generated audio sequence was not accepted");
        }
        if checkpoint {
            self.persist_runtime()?;
        }
        Ok(sequence)
    }

    fn begin_recording(&self, path: PathBuf) -> Result<(ActiveRecordingGuard, File)> {
        self.active_recordings
            .lock()
            .map_err(|_| anyhow::anyhow!("active recording lock poisoned"))?
            .insert(path.clone());
        let guard = ActiveRecordingGuard {
            path: path.clone(),
            active_recordings: Arc::clone(&self.active_recordings),
        };
        self.enforce_retention()?;
        let file = OpenOptions::new().create_new(true).write(true).open(path)?;
        Ok((guard, file))
    }

    fn enforce_retention(&self) -> Result<()> {
        let directory = self.data_dir.join("live-call").join("pcm");
        if !directory.exists() {
            return Ok(());
        }
        let active_recordings = self
            .active_recordings
            .lock()
            .map_err(|_| anyhow::anyhow!("active recording lock poisoned"))?
            .clone();
        let mut recordings = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("pcm") {
                continue;
            }
            let metadata = entry.metadata()?;
            let created_at = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
                .unwrap_or(0);
            recordings.push(if active_recordings.contains(&path) {
                PcmRecording::active(path, created_at)
            } else {
                PcmRecording::completed(path, created_at)
            });
        }
        let report = enforce_pcm_retention(recordings, MAX_RETAINED_PCM_BYTES)?;
        let _ = (report.deleted.len(), report.retained_completed_bytes);
        Ok(())
    }
}

struct ProjectionWorker {
    stop: Arc<AtomicBool>,
    join: Mutex<Option<thread::JoinHandle<()>>>,
}

impl ProjectionWorker {
    #[cfg_attr(test, allow(dead_code))]
    fn start(
        data_dir: PathBuf,
        runtime: Arc<Mutex<LiveCallRuntime>>,
        checkpoint: PathBuf,
    ) -> Arc<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let join = thread::Builder::new()
            .name("live-call-task-projection".to_string())
            .spawn(move || {
                let mut connection = None;
                while !thread_stop.load(Ordering::Acquire) {
                    if connection.is_none() {
                        connection = open_database(&data_dir).ok();
                    }
                    if let Some(database) = connection.as_mut() {
                        let _ = project_live_call_tasks_once(database, &runtime, &checkpoint);
                    }
                    thread::sleep(Duration::from_millis(150));
                }
            })
            .expect("failed to start Live Call task projection worker");
        Arc::new(Self {
            stop,
            join: Mutex::new(Some(join)),
        })
    }
}

impl Drop for ProjectionWorker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut join) = self.join.lock() {
            if let Some(handle) = join.take() {
                let _ = handle.join();
            }
        }
    }
}

struct ActiveRecordingGuard {
    path: PathBuf,
    active_recordings: Arc<Mutex<BTreeSet<PathBuf>>>,
}

impl Drop for ActiveRecordingGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_recordings.lock() {
            active.remove(&self.path);
        }
    }
}

pub fn live_call_request_requires_body(request: &ParsedRequest) -> bool {
    request.method == "POST" && is_live_call_core_path(request.path())
}

pub fn route_live_call_request(
    request: &ParsedRequest,
    body: Option<&[u8]>,
    config: &LiveCallRouteConfig,
) -> Result<Option<HttpRouteResponse>> {
    if !is_live_call_core_path(request.path()) || request.path().ends_with("/events") {
        return Ok(None);
    }
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => {
            return Ok(Some(HttpRouteResponse::error(403, "Host is not allowed.")))
        }
        RouteAuthentication::Unauthorized => {
            return Ok(Some(HttpRouteResponse::error(401, "Unauthorized")))
        }
        RouteAuthentication::Device(_) => {}
    }
    let connection = open_database(&config.data_dir)?;
    let path = request.path();
    if path == "/api/live-calls/asr-providers" && request.method == "GET" {
        let whisper = WhisperConfig::from_environment(&config.data_dir);
        return Ok(Some(HttpRouteResponse::json(
            200,
            json!({
                "items": [{
                    "id": "whisper-cpp", "label": "Whisper.cpp (local ASR)",
                    "production": true, "available": whisper.available(),
                    "active": true, "binaryPath": whisper.binary, "modelPath": whisper.model,
                    "language": whisper.language, "owner": "rust"
                }]
            }),
        )));
    }
    if path == "/api/live-calls" {
        return match request.method.as_str() {
            "GET" => Ok(Some(HttpRouteResponse::json(
                200,
                json!({ "items": list_sessions(&connection)? }),
            ))),
            "POST" => {
                let input = parse_body(body)?;
                let session = create_session(&connection, &input)?;
                Ok(Some(HttpRouteResponse::json(
                    201,
                    json!({ "ok": true, "session": session }),
                )))
            }
            _ => Ok(None),
        };
    }
    let Some(parts) = live_call_parts(path) else {
        return Ok(None);
    };
    let session_id = parts[0];
    if parts.len() == 1 && request.method == "GET" {
        return Ok(Some(match session_by_id(&connection, session_id)? {
            Some(session) => HttpRouteResponse::json(200, json!({ "session": session })),
            None => HttpRouteResponse::error(404, "Live call session not found."),
        }));
    }
    if session_by_id(&connection, session_id)?.is_none() {
        return Ok(Some(HttpRouteResponse::error(
            404,
            "Live call session not found.",
        )));
    }
    let action = parts.get(1).copied().unwrap_or("");
    let response = match (request.method.as_str(), action, parts.get(2).copied()) {
        ("POST", "pause", None) => mutate_status(&connection, session_id, "paused", body)?,
        ("POST", "resume", None) => mutate_status(&connection, session_id, "ready", body)?,
        ("POST", "stop", None) => mutate_status(&connection, session_id, "stopped", body)?,
        ("POST", "level", None) => record_level(&connection, session_id, parse_body(body)?)?,
        ("POST", "transcript", None) => {
            record_transcript(&connection, config, session_id, parse_body(body)?)?
        }
        ("POST", "answer", None) => {
            record_answer(&connection, config, session_id, parse_body(body)?)?
        }
        ("GET", "events", Some("catch-up")) => {
            let after = request
                .query_parameter("after")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            let limit = request
                .query_parameter("limit")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(200)
                .clamp(1, 5000);
            HttpRouteResponse::json(
                200,
                json!({ "items": list_events(&connection, session_id, after, limit)? }),
            )
        }
        ("GET", "asr-checkpoints", None) => HttpRouteResponse::json(
            200,
            json!({ "items": list_asr_checkpoints(config, session_id)? }),
        ),
        ("POST", "asr-recover", None) => {
            let recovered = recover_asr_checkpoints(&connection, config, session_id)?;
            HttpRouteResponse::json(
                200,
                json!({ "ok": true, "recovered": recovered.len(), "items": recovered }),
            )
        }
        _ => return Ok(None),
    };
    Ok(Some(response))
}

pub fn stream_live_call_events_request(
    request: &ParsedRequest,
    config: &LiveCallRouteConfig,
    client: &mut TcpStream,
) -> Result<Option<()>> {
    let Some(parts) = live_call_parts(request.path()) else {
        return Ok(None);
    };
    if request.method != "GET" || parts.as_slice().get(1) != Some(&"events") || parts.len() != 2 {
        return Ok(None);
    }
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending => return Ok(None),
        RouteAuthentication::HostDenied => {
            HttpRouteResponse::error(403, "Host is not allowed.").write_to(client)?;
            return Ok(Some(()));
        }
        RouteAuthentication::Unauthorized => {
            HttpRouteResponse::error(401, "Unauthorized").write_to(client)?;
            return Ok(Some(()));
        }
        RouteAuthentication::Device(_) => {}
    }
    let session_id = parts[0].to_string();
    let connection = open_database(&config.data_dir)?;
    if session_by_id(&connection, &session_id)?.is_none() {
        HttpRouteResponse::error(404, "Live call session not found.").write_to(client)?;
        return Ok(Some(()));
    }
    let mut after = request
        .query_parameter("after")
        .or_else(|| request.header("last-event-id").map(str::to_string))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    if let Err(error) = client.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store, no-transform\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\nX-VibeLink-Control-Plane: rust\r\n\r\nretry: 1500\r\n\r\n") {
        return if is_client_disconnect(&error) {
            Ok(Some(()))
        } else {
            Err(error.into())
        };
    }
    if let Err(error) = client.flush() {
        return if is_client_disconnect(&error) {
            Ok(Some(()))
        } else {
            Err(error.into())
        };
    }
    let started = Instant::now();
    let mut heartbeat = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        for event in list_events(&connection, &session_id, after, 500)? {
            let cursor = event["cursor"].as_i64().unwrap_or(after);
            let event_type = event["type"].as_str().unwrap_or("live_call.event");
            let data = serde_json::to_string(&event)?;
            if let Err(error) = write!(
                client,
                "id: {cursor}\nevent: {event_type}\ndata: {data}\n\n"
            ) {
                return if is_client_disconnect(&error) {
                    Ok(Some(()))
                } else {
                    Err(error.into())
                };
            }
            after = cursor;
            heartbeat = Instant::now();
        }
        if heartbeat.elapsed() >= Duration::from_secs(25) {
            if let Err(error) = client.write_all(b"event: ping\ndata: {}\n\n") {
                return if is_client_disconnect(&error) {
                    Ok(Some(()))
                } else {
                    Err(error.into())
                };
            }
            heartbeat = Instant::now();
        }
        if let Err(error) = client.flush() {
            if is_client_disconnect(&error) {
                return Ok(Some(()));
            }
            return Err(error.into());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(Some(()))
}

fn is_client_disconnect(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
    )
}

pub fn is_live_call_audio_request(request: &ParsedRequest) -> bool {
    let Some(parts) = live_call_parts(request.path()) else {
        return false;
    };
    request.method == "GET"
        && parts.len() == 2
        && parts[1] == "audio"
        && request
            .header("upgrade")
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

pub fn stream_live_call_audio_request(
    request: &ParsedRequest,
    config: &LiveCallRouteConfig,
    client: TcpStream,
    prefix: Vec<u8>,
) -> Result<()> {
    let parts = live_call_parts(request.path()).context("invalid Live Call audio path")?;
    let session_id = parts[0].to_string();
    let mut client = Some(client);
    match authenticate_route_request(request, &config.data_dir)? {
        RouteAuthentication::Pending | RouteAuthentication::Unauthorized => {
            HttpRouteResponse::error(401, "Unauthorized")
                .write_to(client.as_mut().context("audio socket missing")?)?;
            return Ok(());
        }
        RouteAuthentication::HostDenied => {
            HttpRouteResponse::error(403, "Host is not allowed.")
                .write_to(client.as_mut().context("audio socket missing")?)?;
            return Ok(());
        }
        RouteAuthentication::Device(_) => {}
    }
    let connection = open_database(&config.data_dir)?;
    if session_by_id(&connection, &session_id)?.is_none() {
        HttpRouteResponse::error(404, "Live call session not found.")
            .write_to(client.as_mut().context("audio socket missing")?)?;
        return Ok(());
    }
    let stream = PrefixedTcpStream::new(prefix, client.take().context("audio socket missing")?);
    let mut websocket =
        tungstenite::accept(stream).context("Live Call WebSocket handshake failed")?;
    let mut header: Option<AudioHeader> = None;
    let mut frames = 0_u64;
    let mut bytes = 0_u64;
    let mut recording: Option<(ActiveRecordingGuard, File)> = None;
    let mut asr_checkpoint: Option<(PathBuf, File)> = None;
    let mut checkpoint_full = false;
    let mut vad: Option<VadSegmenter> = None;
    let whisper = WhisperConfig::from_environment(&config.data_dir);
    insert_event(
        &connection,
        &session_id,
        "live_call.audio_stream.connected",
        json!({ "source": "device" }),
    )?;
    insert_event(
        &connection,
        &session_id,
        "live_call.asr.provider",
        json!({ "id": "whisper-cpp", "available": whisper.available(), "language": whisper.language }),
    )?;

    loop {
        let message = match websocket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => break,
            Err(error) => return Err(error).context("Live Call WebSocket read failed"),
        };
        match message {
            Message::Text(text) => {
                let input: Value = match serde_json::from_str(text.as_ref()) {
                    Ok(value) => value,
                    Err(_) => {
                        send_ws_json(
                            &mut websocket,
                            json!({ "type": "error", "error": "invalid_json" }),
                        )?;
                        continue;
                    }
                };
                if header.is_none() {
                    let next = AudioHeader::parse(&input)?;
                    let pcm_dir = config.data_dir.join("live-call").join("pcm");
                    fs::create_dir_all(&pcm_dir)?;
                    let path = pcm_dir.join(format!(
                        "{}-{}-{}.pcm",
                        session_id,
                        next.device,
                        uuid::Uuid::new_v4()
                    ));
                    let (guard, file) = config.begin_recording(path)?;
                    let checkpoint_path = asr_checkpoint_path(config, &session_id, &next.device);
                    if let Some(parent) = checkpoint_path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let checkpoint_file = open_asr_checkpoint(&checkpoint_path)?;
                    send_ws_json(
                        &mut websocket,
                        json!({
                            "type": "ready", "sessionId": session_id, "sampleRate": next.sample_rate,
                            "channels": next.channels, "encoding": next.encoding, "device": next.device
                        }),
                    )?;
                    recording = Some((guard, file));
                    asr_checkpoint = Some((checkpoint_path, checkpoint_file));
                    vad = Some(VadSegmenter::new(TARGET_SAMPLE_RATE));
                    header = Some(next);
                    continue;
                }
                match input["type"].as_str().unwrap_or("") {
                    "level" => {
                        record_level(
                            &connection,
                            &session_id,
                            json!({
                                "channel": header.as_ref().map(|item| item.device.as_str()).unwrap_or("remote"),
                                "rms": input["rms"], "peak": input["peak"], "bytes": bytes
                            }),
                        )?;
                    }
                    "flush" => {
                        if let Some((_, file)) = asr_checkpoint.as_mut() {
                            file.flush()?;
                        }
                        if let Some(segment) = vad.as_mut().and_then(VadSegmenter::flush) {
                            if record_asr_segment(
                                &connection,
                                config,
                                &session_id,
                                header
                                    .as_ref()
                                    .map(|item| item.device.as_str())
                                    .unwrap_or("remote"),
                                &whisper,
                                &segment,
                                &format!("{session_id}-flush"),
                            )? {
                                if let Some((_, file)) = asr_checkpoint.as_mut() {
                                    reset_asr_checkpoint(file)?;
                                }
                            }
                        }
                        if let Some((_, file)) = recording.as_mut() {
                            file.flush()?;
                        }
                        config.persist_runtime()?;
                        send_ws_json(&mut websocket, json!({ "type": "flushed" }))?;
                    }
                    "stop" => {
                        if let Some(segment) = vad.as_mut().and_then(VadSegmenter::flush) {
                            if record_asr_segment(
                                &connection,
                                config,
                                &session_id,
                                header
                                    .as_ref()
                                    .map(|item| item.device.as_str())
                                    .unwrap_or("remote"),
                                &whisper,
                                &segment,
                                &format!("{session_id}-stop"),
                            )? {
                                if let Some((_, file)) = asr_checkpoint.as_mut() {
                                    reset_asr_checkpoint(file)?;
                                }
                            }
                        }
                        if let Some((_, file)) = asr_checkpoint.as_mut() {
                            reset_asr_checkpoint(file)?;
                        }
                        if let Some((_, file)) = recording.as_mut() {
                            file.flush()?;
                        }
                        config.persist_runtime()?;
                        send_ws_json(&mut websocket, json!({ "type": "stopped" }))?;
                        websocket.close(None)?;
                        break;
                    }
                    _ => {}
                }
            }
            Message::Binary(frame) => {
                if header.is_none() {
                    send_ws_json(
                        &mut websocket,
                        json!({ "type": "error", "error": "header_required" }),
                    )?;
                    continue;
                }
                if frame.is_empty() {
                    continue;
                }
                if frame.len() > MAX_AUDIO_FRAME_BYTES {
                    send_ws_json(
                        &mut websocket,
                        json!({
                            "type": "error", "error": "frame_too_large", "bytes": frame.len()
                        }),
                    )?;
                    continue;
                }
                recording
                    .as_mut()
                    .context("PCM recording missing")?
                    .1
                    .write_all(&frame)?;
                let normalized = normalize_pcm16le(
                    &frame,
                    header.as_ref().context("audio header missing")?.sample_rate as u32,
                    header.as_ref().context("audio header missing")?.channels as u16,
                )?;
                if let Some((_, file)) = asr_checkpoint.as_mut() {
                    if file
                        .metadata()?
                        .len()
                        .saturating_add(normalized.len() as u64)
                        <= MAX_ASR_CHECKPOINT_BYTES
                    {
                        file.write_all(&normalized)?;
                    } else if !checkpoint_full {
                        checkpoint_full = true;
                        insert_event(
                            &connection,
                            &session_id,
                            "live_call.asr.error",
                            json!({
                                "channel": header.as_ref().map(|item| item.device.as_str()).unwrap_or("remote"),
                                "error": "ASR checkpoint reached 64 MiB limit", "recoverable": false
                            }),
                        )?;
                    }
                }
                if let Some(vad) = vad.as_mut() {
                    for (index, segment) in vad.push(&normalized).into_iter().enumerate() {
                        if record_asr_segment(
                            &connection,
                            config,
                            &session_id,
                            header
                                .as_ref()
                                .map(|item| item.device.as_str())
                                .unwrap_or("remote"),
                            &whisper,
                            &segment,
                            &format!("{session_id}-{frames}-{index}"),
                        )? {
                            if let Some((_, file)) = asr_checkpoint.as_mut() {
                                reset_asr_checkpoint(file)?;
                            }
                        }
                    }
                }
                frames = frames.saturating_add(1);
                bytes = bytes.saturating_add(frame.len() as u64);
                let sequence = config.accept_audio(
                    &session_id,
                    frame.len() as u64,
                    frames.is_multiple_of(20),
                )?;
                if frames.is_multiple_of(20) {
                    send_ws_json(
                        &mut websocket,
                        json!({ "type": "ack", "seq": sequence, "bytes": bytes }),
                    )?;
                }
            }
            Message::Ping(payload) => websocket.send(Message::Pong(payload))?,
            Message::Close(_) => break,
            _ => {}
        }
    }
    if let Some(segment) = vad.as_mut().and_then(VadSegmenter::flush) {
        if record_asr_segment(
            &connection,
            config,
            &session_id,
            header
                .as_ref()
                .map(|item| item.device.as_str())
                .unwrap_or("remote"),
            &whisper,
            &segment,
            &format!("{session_id}-disconnect"),
        )? {
            if let Some((_, file)) = asr_checkpoint.as_mut() {
                reset_asr_checkpoint(file)?;
            }
        }
    }
    if let Some((guard, mut file)) = recording.take() {
        file.flush()?;
        drop(guard);
    }
    if let Some((_, mut file)) = asr_checkpoint.take() {
        file.flush()?;
    }
    config.persist_runtime()?;
    config.enforce_retention()?;
    insert_event(
        &connection,
        &session_id,
        "live_call.audio_stream.disconnected",
        json!({ "bytes": bytes, "frames": frames }),
    )?;
    Ok(())
}

fn record_asr_segment(
    connection: &Connection,
    config: &LiveCallRouteConfig,
    session_id: &str,
    channel: &str,
    whisper: &WhisperConfig,
    segment: &[u8],
    segment_id: &str,
) -> Result<bool> {
    insert_event(
        connection,
        session_id,
        "live_call.audio_segment",
        json!({
            "channel": channel, "bytes": segment.len(), "sampleRate": TARGET_SAMPLE_RATE
        }),
    )?;
    match transcribe(whisper, segment, segment_id) {
        Ok(text) => {
            if !text.is_empty() {
                record_transcript(
                    connection,
                    config,
                    session_id,
                    json!({
                        "text": text, "final": true, "speaker": channel, "channel": channel
                    }),
                )?;
            }
            Ok(true)
        }
        Err(error) => {
            insert_event(
                connection,
                session_id,
                "live_call.asr.error",
                json!({
                    "channel": channel, "error": format!("{error:#}"), "recoverable": true
                }),
            )?;
            Ok(false)
        }
    }
}

fn asr_checkpoint_path(config: &LiveCallRouteConfig, session_id: &str, channel: &str) -> PathBuf {
    config
        .data_dir
        .join("live-call")
        .join("asr-checkpoints")
        .join(format!("{session_id}-{channel}.pcm"))
}

fn open_asr_checkpoint(path: &Path) -> Result<File> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    file.seek(SeekFrom::End(0))?;
    Ok(file)
}

fn reset_asr_checkpoint(file: &mut File) -> Result<()> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(())
}

fn list_asr_checkpoints(config: &LiveCallRouteConfig, session_id: &str) -> Result<Vec<Value>> {
    let directory = config.data_dir.join("live-call").join("asr-checkpoints");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let prefix = format!("{session_id}-");
    let mut items = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(&prefix) || !name.ends_with(".pcm") {
            continue;
        }
        let bytes = entry.metadata()?.len();
        if bytes == 0 {
            continue;
        }
        items.push(json!({ "channel": name.trim_start_matches(&prefix).trim_end_matches(".pcm"), "bytes": bytes, "sampleRate": TARGET_SAMPLE_RATE, "encoding": "pcm16le" }));
    }
    Ok(items)
}

fn recover_asr_checkpoints(
    connection: &Connection,
    config: &LiveCallRouteConfig,
    session_id: &str,
) -> Result<Vec<Value>> {
    let whisper = WhisperConfig::from_environment(&config.data_dir);
    let mut recovered = Vec::new();
    for item in list_asr_checkpoints(config, session_id)? {
        let channel = item["channel"].as_str().unwrap_or("remote");
        let path = asr_checkpoint_path(config, session_id, channel);
        let pcm = fs::read(&path)?;
        let text = transcribe(&whisper, &pcm, &format!("{session_id}-recovery-{channel}"))?;
        if text.is_empty() {
            continue;
        }
        record_transcript(
            connection,
            config,
            session_id,
            json!({ "text": text, "final": true, "speaker": channel, "channel": channel, "recovered": true }),
        )?;
        fs::remove_file(&path)?;
        recovered.push(json!({ "channel": channel, "bytes": pcm.len(), "text": text }));
    }
    Ok(recovered)
}

fn send_ws_json<S: Read + Write>(
    websocket: &mut tungstenite::WebSocket<S>,
    value: Value,
) -> Result<()> {
    websocket.send(Message::Text(value.to_string()))?;
    Ok(())
}

struct PrefixedTcpStream {
    prefix: Cursor<Vec<u8>>,
    stream: TcpStream,
}

impl PrefixedTcpStream {
    fn new(prefix: Vec<u8>, stream: TcpStream) -> Self {
        Self {
            prefix: Cursor::new(prefix),
            stream,
        }
    }
}

impl Read for PrefixedTcpStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.prefix.read(buffer)?;
        if read > 0 {
            Ok(read)
        } else {
            self.stream.read(buffer)
        }
    }
}

impl Write for PrefixedTcpStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream.write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

struct AudioHeader {
    sample_rate: u64,
    channels: u64,
    encoding: String,
    device: String,
}

impl AudioHeader {
    fn parse(input: &Value) -> Result<Self> {
        let sample_rate = input["sampleRate"].as_u64().context("bad_sample_rate")?;
        if !(8_000..=48_000).contains(&sample_rate) {
            bail!("bad_sample_rate");
        }
        let channels = input["channels"].as_u64().context("bad_channels")?;
        if !matches!(channels, 1 | 2) {
            bail!("bad_channels");
        }
        let encoding = clean(input["encoding"].as_str(), "pcm16le", 20);
        if encoding != "pcm16le" {
            bail!("bad_encoding");
        }
        let raw_device = clean(input["device"].as_str(), "remote", 40);
        let device = if raw_device == "local" {
            "local"
        } else {
            "remote"
        }
        .to_string();
        Ok(Self {
            sample_rate,
            channels,
            encoding,
            device,
        })
    }
}

fn is_live_call_core_path(path: &str) -> bool {
    if matches!(path, "/api/live-calls" | "/api/live-calls/asr-providers") {
        return true;
    }
    let Some(parts) = live_call_parts(path) else {
        return false;
    };
    parts.len() == 1
        || matches!(
            parts.get(1).copied(),
            Some(
                "stop"
                    | "pause"
                    | "resume"
                    | "level"
                    | "transcript"
                    | "answer"
                    | "asr-checkpoints"
                    | "asr-recover"
                    | "events"
            )
        )
}

fn live_call_parts(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix("/api/live-calls/")?;
    if rest.is_empty() || rest.starts_with("audio-") || rest == "asr-providers" {
        return None;
    }
    Some(rest.split('/').collect())
}

fn parse_body(body: Option<&[u8]>) -> Result<Value> {
    let body = body.context("Live Call request body is required")?;
    let value: Value = serde_json::from_slice(body).context("Invalid Live Call JSON body")?;
    if !value.is_object() {
        bail!("Live Call body must be a JSON object");
    }
    Ok(value)
}

fn open_database(data_dir: &Path) -> Result<Connection> {
    fs::create_dir_all(data_dir)?;
    let connection = Connection::open(data_dir.join("mobile-agent.sqlite"))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS live_calls (
           id TEXT PRIMARY KEY, status TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL,
           workspace_id TEXT, agent_task_id TEXT, asr_provider TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, stopped_at TEXT,
           last_transcript TEXT, last_question TEXT, last_answer TEXT, meta_json TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_live_calls_updated ON live_calls(updated_at);
         CREATE TABLE IF NOT EXISTS live_call_events (
           cursor INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
           event_id TEXT NOT NULL, event_type TEXT NOT NULL, event_at TEXT NOT NULL, text TEXT,
           payload_json TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL,
           UNIQUE(session_id, event_id)
         );
         CREATE INDEX IF NOT EXISTS idx_live_call_events_session_cursor
           ON live_call_events(session_id, cursor);
         CREATE TABLE IF NOT EXISTS live_call_task_projections (
           task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, question_id TEXT NOT NULL DEFAULT '',
           last_task_cursor INTEGER NOT NULL DEFAULT 0,
           accumulated_text TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_live_call_task_projections_session
           ON live_call_task_projections(session_id,done);",
    )?;
    Ok(connection)
}

fn now_iso() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn clean(value: Option<&str>, fallback: &str, max: usize) -> String {
    let value = value.unwrap_or(fallback).trim();
    value.chars().take(max).collect()
}

fn create_session(connection: &Connection, input: &Value) -> Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute(
        "INSERT INTO live_calls (id,status,title,source,workspace_id,agent_task_id,asr_provider,created_at,updated_at,started_at,stopped_at,last_transcript,last_question,last_answer,meta_json)
         VALUES (?1,'ready',?2,?3,?4,'',?5,?6,?6,?6,'','','','',?7)",
        params![
            id,
            clean(input["title"].as_str(), "Live Call MVP", 160),
            clean(input["source"].as_str(), "windows-audio-probe", 120),
            clean(input["workspaceId"].as_str(), "", 160),
            clean(input["asrProvider"].as_str(), "", 60),
            now,
            input.get("meta").cloned().unwrap_or(Value::Null).to_string()
        ],
    )?;
    let session = session_by_id(connection, &id)?.context("created live call disappeared")?;
    insert_event(
        connection,
        &id,
        "live_call.started",
        json!({ "session": session }),
    )?;
    session_by_id(connection, &id)?.context("created live call disappeared")
}

fn list_sessions(connection: &Connection) -> Result<Vec<Value>> {
    let mut statement =
        connection.prepare("SELECT id FROM live_calls ORDER BY updated_at DESC LIMIT 200")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.into_iter()
        .map(|id| session_by_id(connection, &id)?.context("live call disappeared"))
        .collect()
}

fn session_by_id(connection: &Connection, id: &str) -> Result<Option<Value>> {
    connection
        .query_row(
            "SELECT id,status,title,source,workspace_id,agent_task_id,asr_provider,created_at,updated_at,started_at,stopped_at,last_transcript,last_question,last_answer,meta_json,
                    (SELECT COALESCE(MAX(cursor),0) FROM live_call_events WHERE session_id=live_calls.id)
             FROM live_calls WHERE id=?1",
            params![id],
            |row| {
                let meta: String = row.get(14)?;
                Ok(json!({
                    "id": row.get::<_, String>(0)?, "status": row.get::<_, String>(1)?,
                    "title": row.get::<_, String>(2)?, "source": row.get::<_, String>(3)?,
                    "workspaceId": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    "agentTaskId": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    "asrProvider": row.get::<_, String>(6)?, "createdAt": row.get::<_, String>(7)?,
                    "updatedAt": row.get::<_, String>(8)?,
                    "startedAt": row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                    "stoppedAt": row.get::<_, Option<String>>(10)?.unwrap_or_default(),
                    "lastTranscript": row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                    "lastQuestion": row.get::<_, Option<String>>(12)?.unwrap_or_default(),
                    "lastAnswer": row.get::<_, Option<String>>(13)?.unwrap_or_default(),
                    "eventCursor": row.get::<_, i64>(15)?, "remote": Value::Null, "local": Value::Null,
                    "meta": serde_json::from_str::<Value>(&meta).unwrap_or(Value::Null), "owner": "rust"
                }))
            },
        )
        .optional()
        .map_err(Into::into)
}

fn insert_event(
    connection: &Connection,
    session_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<Value> {
    let event_id = uuid::Uuid::new_v4().to_string();
    insert_event_with_id(connection, session_id, &event_id, event_type, payload)
}

fn insert_event_with_id(
    connection: &Connection,
    session_id: &str,
    event_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<Value> {
    let at = now_iso();
    let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
    let inserted = connection.execute(
        "INSERT OR IGNORE INTO live_call_events (session_id,event_id,event_type,event_at,text,payload_json,event_json,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,'{}',?4)",
        params![session_id, event_id, event_type, at, text, payload.to_string()],
    )?;
    if inserted == 0 {
        let existing: String = connection.query_row(
            "SELECT event_json FROM live_call_events WHERE session_id=?1 AND event_id=?2",
            params![session_id, event_id],
            |row| row.get(0),
        )?;
        return serde_json::from_str(&existing).context("invalid persisted Live Call event");
    }
    let cursor = connection.last_insert_rowid();
    let mut event = json!({
        "id": event_id, "cursor": cursor, "type": event_type, "at": at,
        "sessionId": session_id
    });
    if let (Some(target), Some(source)) = (event.as_object_mut(), payload.as_object()) {
        target.extend(source.clone());
    }
    connection.execute(
        "UPDATE live_call_events SET event_json=?1 WHERE cursor=?2",
        params![event.to_string(), cursor],
    )?;
    connection.execute(
        "UPDATE live_calls SET updated_at=?1 WHERE id=?2",
        params![at, session_id],
    )?;
    Ok(event)
}

fn project_live_call_tasks_once(
    connection: &mut Connection,
    runtime: &Arc<Mutex<LiveCallRuntime>>,
    checkpoint: &Path,
) -> Result<usize> {
    let task_tables_ready: bool = connection.query_row(
        "SELECT COUNT(*) = 2 FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_events')",
        [],
        |row| row.get(0),
    )?;
    if !task_tables_ready {
        return Ok(0);
    }

    let transaction = connection.transaction()?;
    let discovered_tasks = {
        let mut statement = transaction.prepare(
            "SELECT tasks.id,tasks.session_id,COALESCE(tasks.meta_json,'{}')
             FROM tasks JOIN live_calls ON live_calls.id=tasks.session_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for (task_id, session_id, meta_json) in discovered_tasks {
        let question_id = serde_json::from_str::<Value>(&meta_json)
            .ok()
            .and_then(|meta| {
                meta.pointer("/launchPayload/questionId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        transaction.execute(
            "INSERT OR IGNORE INTO live_call_task_projections
             (task_id,session_id,question_id,last_task_cursor,accumulated_text,done,updated_at)
             VALUES (?1,?2,?3,0,'',0,?4)",
            params![task_id, session_id, question_id, now_iso()],
        )?;
    }
    let projections = {
        let mut statement = transaction.prepare(
            "SELECT projection.task_id,projection.session_id,projection.question_id,
                    projection.last_task_cursor,projection.accumulated_text,tasks.status
             FROM live_call_task_projections projection
             JOIN tasks ON tasks.id=projection.task_id
             WHERE projection.done=0 ORDER BY tasks.created_at ASC",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let mut projected = 0_usize;
    let mut terminal_questions = Vec::new();

    for (task_id, session_id, question_id, last_cursor, mut accumulated, task_status) in projections
    {
        let task_events = {
            let mut statement = transaction.prepare(
                "SELECT cursor,event_type,COALESCE(text,''),COALESCE(payload_json,'{}'),event_json
                 FROM task_events WHERE task_id=?1 AND cursor>?2 ORDER BY cursor ASC",
            )?;
            let rows = statement
                .query_map(params![task_id, last_cursor], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let mut projected_cursor = last_cursor;
        for (cursor, event_type, text, payload_json, event_json) in task_events {
            let payload = serde_json::from_str::<Value>(&payload_json).unwrap_or(Value::Null);
            let event = serde_json::from_str::<Value>(&event_json).unwrap_or(Value::Null);
            if let Some(delta) = extract_agent_text(&event_type, &text, &payload, &event) {
                accumulated.push_str(&delta);
                accumulated = clean(Some(&accumulated), "", 8000);
                insert_event_with_id(
                    &transaction,
                    &session_id,
                    &format!("task:{task_id}:{cursor}:delta"),
                    "live_call.agent.delta",
                    json!({ "taskId": task_id, "taskCursor": cursor, "text": delta }),
                )?;
                projected = projected.saturating_add(1);
            }
            projected_cursor = cursor;
        }
        transaction.execute(
            "UPDATE live_call_task_projections
             SET last_task_cursor=?1,accumulated_text=?2,updated_at=?3 WHERE task_id=?4",
            params![projected_cursor, accumulated, now_iso(), task_id],
        )?;

        let Some((terminal_type, succeeded)) = terminal_task_outcome(&task_status) else {
            continue;
        };
        let live_event_type = if succeeded {
            "live_call.agent.done"
        } else {
            "live_call.agent.error"
        };
        insert_event_with_id(
            &transaction,
            &session_id,
            &format!("task:{task_id}:{terminal_type}"),
            live_event_type,
            json!({
                "taskId": task_id,
                "status": terminal_type,
                "text": accumulated,
                "error": (!succeeded).then(|| format!("agent task ended with status {terminal_type}"))
            }),
        )?;
        if succeeded {
            transaction.execute(
                "UPDATE live_calls SET last_answer=?1 WHERE id=?2",
                params![accumulated, session_id],
            )?;
        }
        transaction.execute(
            "UPDATE live_call_task_projections SET done=1,updated_at=?1 WHERE task_id=?2",
            params![now_iso(), task_id],
        )?;
        terminal_questions.push((session_id, question_id));
        projected = projected.saturating_add(1);
    }

    if !terminal_questions.is_empty() {
        let mut runtime = runtime
            .lock()
            .map_err(|_| anyhow::anyhow!("live call runtime lock poisoned"))?;
        for (session_id, question_id) in terminal_questions {
            if question_id.is_empty() {
                let unfinished: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM live_call_task_projections
                     WHERE session_id=?1 AND done=0",
                    params![session_id],
                    |row| row.get(0),
                )?;
                if unfinished == 0 {
                    runtime.acknowledge_all_questions(&session_id);
                }
            } else {
                runtime.acknowledge_question(&session_id, &question_id)?;
            }
        }
        runtime.save(checkpoint)?;
    }
    transaction.commit()?;
    Ok(projected)
}

fn terminal_task_outcome(status: &str) -> Option<(&str, bool)> {
    match status {
        "done" | "completed" | "succeeded" => Some((status, true)),
        "failed" | "cancelled" | "error" | "stopped" => Some((status, false)),
        _ => None,
    }
}

fn extract_agent_text(
    event_type: &str,
    text: &str,
    payload: &Value,
    event: &Value,
) -> Option<String> {
    let event_type = event_type.to_ascii_lowercase();
    if ["stdout", "stderr", "stdin", "system", "error"]
        .iter()
        .any(|kind| event_type == *kind || event_type.starts_with(&format!("{kind}.")))
    {
        return None;
    }
    let mut fragments = Vec::new();
    for source in [payload, event] {
        collect_text(source.pointer("/delta/text"), &mut fragments);
        collect_content_text(source.pointer("/delta/content"), &mut fragments);
        if source.pointer("/item/type").and_then(Value::as_str) == Some("agent_message") {
            collect_text(source.pointer("/item/text"), &mut fragments);
            collect_content_text(source.pointer("/item/content"), &mut fragments);
        }
        let assistant_message = source
            .pointer("/message/role")
            .and_then(Value::as_str)
            .map(|role| role == "assistant")
            .unwrap_or(true);
        if assistant_message {
            collect_text(source.pointer("/message/text"), &mut fragments);
            collect_content_text(source.pointer("/message/content"), &mut fragments);
        }
        collect_text(source.pointer("/content_block/text"), &mut fragments);
        collect_text(source.pointer("/output_text"), &mut fragments);
    }
    if fragments.is_empty()
        && [
            "agent",
            "assistant",
            "message",
            "content",
            "delta",
            "response",
            "item",
        ]
        .iter()
        .any(|marker| event_type.contains(marker))
    {
        let fallback = payload
            .get("text")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(text);
        if !fallback.is_empty() {
            fragments.push(fallback.to_string());
        }
    }
    (!fragments.is_empty()).then(|| fragments.concat())
}

fn collect_text(value: Option<&Value>, fragments: &mut Vec<String>) {
    if let Some(text) = value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        fragments.push(text.to_string());
    }
}

fn collect_content_text(value: Option<&Value>, fragments: &mut Vec<String>) {
    let Some(items) = value.and_then(Value::as_array) else {
        return;
    };
    for item in items {
        collect_text(item.get("text"), fragments);
    }
}

fn list_events(
    connection: &Connection,
    session_id: &str,
    after: i64,
    limit: usize,
) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT cursor,event_json FROM live_call_events WHERE session_id=?1 AND cursor>?2 ORDER BY cursor ASC LIMIT ?3",
    )?;
    let rows = statement
        .query_map(
            params![session_id, after.max(0), limit.clamp(1, 5000)],
            |row| {
                let cursor: i64 = row.get(0)?;
                let encoded: String = row.get(1)?;
                let mut event =
                    serde_json::from_str::<Value>(&encoded).unwrap_or_else(|_| json!({}));
                event["cursor"] = json!(cursor);
                Ok(event)
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn mutate_status(
    connection: &Connection,
    session_id: &str,
    status: &str,
    body: Option<&[u8]>,
) -> Result<HttpRouteResponse> {
    let input = parse_body(body)?;
    let current = session_by_id(connection, session_id)?.context("live call missing")?;
    if current["status"] != status {
        let now = now_iso();
        let stopped = if status == "stopped" {
            now.as_str()
        } else {
            current["stoppedAt"].as_str().unwrap_or("")
        };
        connection.execute(
            "UPDATE live_calls SET status=?1,updated_at=?2,stopped_at=?3 WHERE id=?4",
            params![status, now, stopped, session_id],
        )?;
        let event_type = match status {
            "paused" => "live_call.paused",
            "ready" => "live_call.resumed",
            _ => "live_call.stopped",
        };
        insert_event(
            connection,
            session_id,
            event_type,
            json!({ "reason": clean(input["reason"].as_str(), "manual", 160) }),
        )?;
    }
    Ok(HttpRouteResponse::json(
        200,
        json!({ "ok": true, "session": session_by_id(connection, session_id)? }),
    ))
}

fn record_level(
    connection: &Connection,
    session_id: &str,
    input: Value,
) -> Result<HttpRouteResponse> {
    let channel = if input["channel"] == "local" {
        "local"
    } else {
        "remote"
    };
    insert_event(
        connection,
        session_id,
        "live_call.audio_level",
        json!({
            "channel": channel,
            "level": {
                "connected": true, "bytes": input["bytes"].as_u64().unwrap_or(0),
                "peak": input["peak"].as_f64().unwrap_or(0.0), "rms": input["rms"].as_f64().unwrap_or(0.0),
                "deviceName": clean(input["deviceName"].as_str(), "", 240)
            }
        }),
    )?;
    Ok(HttpRouteResponse::json(
        200,
        json!({ "ok": true, "session": session_by_id(connection, session_id)? }),
    ))
}

fn record_transcript(
    connection: &Connection,
    config: &LiveCallRouteConfig,
    session_id: &str,
    input: Value,
) -> Result<HttpRouteResponse> {
    let text = clean(input["text"].as_str(), "", 4000);
    if text.is_empty() {
        bail!("transcript text is required");
    }
    let final_segment = input
        .get("final")
        .or_else(|| input.get("isFinal"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let current = session_by_id(connection, session_id)?.context("live call missing")?;
    if final_segment && current["lastTranscript"].as_str() == Some(text.as_str()) {
        return Ok(HttpRouteResponse::json(
            200,
            json!({ "ok": true, "duplicate": true, "session": current }),
        ));
    }
    connection.execute(
        "UPDATE live_calls SET last_transcript=?1 WHERE id=?2",
        params![text, session_id],
    )?;
    insert_event(
        connection,
        session_id,
        if final_segment {
            "live_call.transcript.final"
        } else {
            "live_call.transcript.partial"
        },
        json!({
            "text": text, "final": final_segment, "speaker": clean(input["speaker"].as_str(), "remote", 40)
        }),
    )?;
    if final_segment && looks_like_question(&text) {
        connection.execute(
            "UPDATE live_calls SET last_question=?1 WHERE id=?2",
            params![text, session_id],
        )?;
        let event = insert_event(
            connection,
            session_id,
            "live_call.question.detected",
            json!({ "text": text }),
        )?;
        let question_id = event["id"].as_str().context("question event id missing")?;
        config.queue_question(session_id, question_id, &text)?;
        let current = session_by_id(connection, session_id)?.context("live call missing")?;
        match crate::task_http::create_live_call_task(
            &config.data_dir,
            session_id,
            question_id,
            &text,
            current["workspaceId"].as_str().unwrap_or(""),
            input["agent"].as_str().unwrap_or("codex"),
            input["model"].as_str().unwrap_or(""),
        ) {
            Ok(task) => {
                let task_id = task["id"].as_str().context("Live Call task id missing")?;
                connection.execute(
                    "INSERT OR IGNORE INTO live_call_task_projections
                     (task_id,session_id,question_id,last_task_cursor,accumulated_text,done,updated_at)
                     VALUES (?1,?2,?3,0,'',0,?4)",
                    params![task_id, session_id, question_id, now_iso()],
                )?;
                connection.execute(
                    "UPDATE live_calls SET agent_task_id=?1 WHERE id=?2",
                    params![task_id, session_id],
                )?;
                insert_event(
                    connection,
                    session_id,
                    "live_call.agent.thinking",
                    json!({
                        "question": text, "questionId": question_id,
                        "questionCursor": event["cursor"], "taskId": task_id
                    }),
                )?;
            }
            Err(error) => {
                insert_event(
                    connection,
                    session_id,
                    "live_call.agent.error",
                    json!({
                        "question": text, "questionId": question_id,
                        "questionCursor": event["cursor"], "error": format!("{error:#}")
                    }),
                )?;
                config.acknowledge_question(session_id, question_id)?;
            }
        }
    }
    Ok(HttpRouteResponse::json(
        200,
        json!({ "ok": true, "session": session_by_id(connection, session_id)? }),
    ))
}

fn record_answer(
    connection: &Connection,
    config: &LiveCallRouteConfig,
    session_id: &str,
    input: Value,
) -> Result<HttpRouteResponse> {
    let text = clean(input["text"].as_str(), "", 8000);
    if text.is_empty() {
        bail!("answer text is required");
    }
    connection.execute(
        "UPDATE live_calls SET last_answer=?1 WHERE id=?2",
        params![text, session_id],
    )?;
    insert_event(
        connection,
        session_id,
        "live_call.agent.done",
        json!({ "text": text }),
    )?;
    config.acknowledge_questions(session_id)?;
    Ok(HttpRouteResponse::json(
        200,
        json!({ "ok": true, "session": session_by_id(connection, session_id)? }),
    ))
}

fn looks_like_question(text: &str) -> bool {
    text.contains('?')
        || text.contains('？')
        || [
            "什么",
            "如何",
            "怎么",
            "为什么",
            "请问",
            "能否",
            "是否",
            "怎样",
            "多少",
            "哪里",
        ]
        .iter()
        .any(|marker| text.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_http::{hash_token, parse_request, ParsedRequest};
    use rusqlite::{params, Connection};
    use std::fs;
    use std::path::PathBuf;

    fn fixture() -> (PathBuf, LiveCallRouteConfig) {
        let directory =
            std::env::temp_dir().join(format!("vibelink-live-http-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("settings.json"),
            r#"{"pairingToken":"PAIR","hostAllowlist":["bridge.test"]}"#,
        )
        .unwrap();
        let database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        database.execute_batch("CREATE TABLE devices (id TEXT, label TEXT, token_hash TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT, expires_at TEXT, rotated_at TEXT, meta_json TEXT);").unwrap();
        database.execute("INSERT INTO devices VALUES ('device', 'Device', ?1, '', '', NULL, '2099-01-01T00:00:00.000Z', NULL, '{}')", params![hash_token("token")]).unwrap();
        drop(database);
        let config = LiveCallRouteConfig::new(directory.clone());
        (directory, config)
    }

    fn request(method: &str, path: &str) -> ParsedRequest {
        parse_request(
            format!(
                "{method} {path} HTTP/1.1\r\nHost: bridge.test\r\nAuthorization: Bearer token\r\nContent-Type: application/json\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn persists_session_question_and_replay_across_route_restart() {
        let (directory, config) = fixture();
        let created = route_live_call_request(
            &request("POST", "/api/live-calls"),
            Some(br#"{"title":"Interview","source":"android","asrProvider":"mock"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(created.status, 201);
        let id = created.body["session"]["id"].as_str().unwrap().to_string();

        let transcript = route_live_call_request(
            &request("POST", &format!("/api/live-calls/{id}/transcript")),
            Some(br#"{"text":"What changed?","final":true,"speaker":"remote"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(transcript.status, 200);
        route_live_call_request(
            &request("POST", &format!("/api/live-calls/{id}/transcript")),
            Some(br#"{"text":"What changed?","final":true,"speaker":"remote"}"#),
            &config,
        )
        .unwrap()
        .unwrap();

        let database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        let task_count: i64 = database
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_count, 1);
        let task_id: String = database
            .query_row("SELECT id FROM tasks LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert!(!task_id.is_empty());
        drop(database);

        route_live_call_request(
            &request("POST", &format!("/api/live-calls/{id}/answer")),
            Some(br#"{"text":"The runtime moved to Rust."}"#),
            &config,
        )
        .unwrap()
        .unwrap();

        let restarted = LiveCallRouteConfig::new(directory.clone());
        let session = route_live_call_request(
            &request("GET", &format!("/api/live-calls/{id}")),
            None,
            &restarted,
        )
        .unwrap()
        .unwrap();
        assert_eq!(session.body["session"]["lastQuestion"], "What changed?");
        let replay = route_live_call_request(
            &request(
                "GET",
                &format!("/api/live-calls/{id}/events/catch-up?after=0&limit=20"),
            ),
            None,
            &restarted,
        )
        .unwrap()
        .unwrap();
        let types = replay.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|event| event["type"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            types,
            vec![
                "live_call.started",
                "live_call.transcript.final",
                "live_call.question.detected",
                "live_call.agent.thinking",
                "live_call.agent.done"
            ]
        );
        assert_eq!(session.body["session"]["agentTaskId"], task_id);
        assert_eq!(restarted.pending_question_count(&id), 0);
        assert_eq!(
            types
                .iter()
                .filter(|kind| **kind == "live_call.question.detected")
                .count(),
            1
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn projects_task_output_once_and_drains_pending_questions() {
        let (directory, config) = fixture();
        let created = route_live_call_request(
            &request("POST", "/api/live-calls"),
            Some(br#"{"title":"Projection"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        let session_id = created.body["session"]["id"].as_str().unwrap().to_string();
        route_live_call_request(
            &request("POST", &format!("/api/live-calls/{session_id}/transcript")),
            Some(br#"{"text":"What is the result?","final":true}"#),
            &config,
        )
        .unwrap()
        .unwrap();

        let mut database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        let task_id: String = database
            .query_row(
                "SELECT agent_task_id FROM live_calls WHERE id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap();
        let at = now_iso();
        database
            .execute(
                "INSERT INTO task_events
                 (task_id,event_id,event_type,event_at,text,payload_json,event_json,created_at)
                 VALUES (?1,'provider-1','response.output_text.delta',?2,'',?3,'{}',?2)",
                params![
                    task_id,
                    at,
                    json!({ "delta": { "text": "Rust owns it." } }).to_string()
                ],
            )
            .unwrap();
        database
            .execute(
                "UPDATE tasks SET status='done',updated_at=?1 WHERE id=?2",
                params![now_iso(), task_id],
            )
            .unwrap();

        assert_eq!(
            project_live_call_tasks_once(&mut database, &config.runtime, &config.checkpoint)
                .unwrap(),
            2
        );
        assert_eq!(
            project_live_call_tasks_once(&mut database, &config.runtime, &config.checkpoint)
                .unwrap(),
            0
        );
        let projected = list_events(&database, &session_id, 0, 20).unwrap();
        assert_eq!(
            projected
                .iter()
                .filter(|event| event["type"] == "live_call.agent.delta")
                .count(),
            1
        );
        assert_eq!(
            projected
                .iter()
                .filter(|event| event["type"] == "live_call.agent.done")
                .count(),
            1
        );
        let session = session_by_id(&database, &session_id).unwrap().unwrap();
        assert_eq!(session["lastAnswer"], "Rust owns it.");
        assert_eq!(config.pending_question_count(&session_id), 0);
        drop(database);

        let restarted = LiveCallRouteConfig::new(directory.clone());
        assert_eq!(restarted.pending_question_count(&session_id), 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_task_projects_error_and_drains_pending_questions() {
        let (directory, config) = fixture();
        let created = route_live_call_request(
            &request("POST", "/api/live-calls"),
            Some(br#"{"title":"Failure projection"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        let session_id = created.body["session"]["id"].as_str().unwrap().to_string();
        route_live_call_request(
            &request("POST", &format!("/api/live-calls/{session_id}/transcript")),
            Some(br#"{"text":"Can this fail?","final":true}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        let mut database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        let task_id: String = database
            .query_row(
                "SELECT agent_task_id FROM live_calls WHERE id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap();
        database
            .execute(
                "UPDATE tasks SET status='failed',updated_at=?1 WHERE id=?2",
                params![now_iso(), task_id],
            )
            .unwrap();

        assert_eq!(
            project_live_call_tasks_once(&mut database, &config.runtime, &config.checkpoint)
                .unwrap(),
            1
        );
        let errors = list_events(&database, &session_id, 0, 20)
            .unwrap()
            .into_iter()
            .filter(|event| event["type"] == "live_call.agent.error")
            .collect::<Vec<_>>();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0]["status"], "failed");
        assert_eq!(config.pending_question_count(&session_id), 0);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_questions_are_acknowledged_by_task_identity() {
        let (directory, config) = fixture();
        let created = route_live_call_request(
            &request("POST", "/api/live-calls"),
            Some(br#"{"title":"Concurrent questions"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        let session_id = created.body["session"]["id"].as_str().unwrap().to_string();
        for question in ["What changed?", "Why now?"] {
            route_live_call_request(
                &request("POST", &format!("/api/live-calls/{session_id}/transcript")),
                Some(
                    json!({ "text": question, "final": true })
                        .to_string()
                        .as_bytes(),
                ),
                &config,
            )
            .unwrap()
            .unwrap();
        }
        assert_eq!(config.pending_question_count(&session_id), 2);
        let mut database = Connection::open(directory.join("mobile-agent.sqlite")).unwrap();
        let task_ids = {
            let mut statement = database
                .prepare("SELECT id FROM tasks WHERE session_id=?1 ORDER BY created_at,id")
                .unwrap();
            let ids = statement
                .query_map(params![session_id], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap();
            ids
        };
        assert_eq!(task_ids.len(), 2);

        database
            .execute(
                "UPDATE tasks SET status='done',updated_at=?1 WHERE id=?2",
                params![now_iso(), task_ids[0]],
            )
            .unwrap();
        project_live_call_tasks_once(&mut database, &config.runtime, &config.checkpoint).unwrap();
        assert_eq!(config.pending_question_count(&session_id), 1);

        database
            .execute(
                "UPDATE tasks SET status='done',updated_at=?1 WHERE id=?2",
                params![now_iso(), task_ids[1]],
            )
            .unwrap();
        project_live_call_tasks_once(&mut database, &config.runtime, &config.checkpoint).unwrap();
        assert_eq!(config.pending_question_count(&session_id), 0);
        let done_count = list_events(&database, &session_id, 0, 30)
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "live_call.agent.done")
            .count();
        assert_eq!(done_count, 2);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pause_resume_and_stop_are_idempotent_and_cursor_monotonic() {
        let (directory, config) = fixture();
        let created = route_live_call_request(
            &request("POST", "/api/live-calls"),
            Some(br#"{"title":"Call"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        let id = created.body["session"]["id"].as_str().unwrap();
        for action in ["pause", "pause", "resume", "resume", "stop", "stop"] {
            let response = route_live_call_request(
                &request("POST", &format!("/api/live-calls/{id}/{action}")),
                Some(br#"{"reason":"test"}"#),
                &config,
            )
            .unwrap()
            .unwrap();
            assert_eq!(response.status, 200);
        }
        let events = config.list_events(id, 0, 20).unwrap();
        assert_eq!(events.len(), 4);
        assert!(events
            .windows(2)
            .all(|pair| pair[0]["cursor"].as_i64() < pair[1]["cursor"].as_i64()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn exposes_provider_readiness_and_restart_safe_asr_checkpoints() {
        let (directory, config) = fixture();
        let providers = route_live_call_request(
            &request("GET", "/api/live-calls/asr-providers"),
            None,
            &config,
        )
        .unwrap()
        .unwrap();
        assert_eq!(providers.body["items"][0]["id"], "whisper-cpp");
        assert!(providers.body["items"][0]["available"].is_boolean());

        let created = route_live_call_request(
            &request("POST", "/api/live-calls"),
            Some(br#"{"title":"Recovery"}"#),
            &config,
        )
        .unwrap()
        .unwrap();
        let id = created.body["session"]["id"].as_str().unwrap();
        let path = asr_checkpoint_path(&config, id, "remote");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, [1_u8, 2, 3, 4]).unwrap();

        let restarted = LiveCallRouteConfig::new(directory.clone());
        let checkpoints = route_live_call_request(
            &request("GET", &format!("/api/live-calls/{id}/asr-checkpoints")),
            None,
            &restarted,
        )
        .unwrap()
        .unwrap();
        assert_eq!(checkpoints.body["items"][0]["channel"], "remote");
        assert_eq!(checkpoints.body["items"][0]["bytes"], 4);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn asr_checkpoint_can_be_truncated_after_append_on_windows() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-asr-checkpoint-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("checkpoint.pcm");
        let mut file = open_asr_checkpoint(&path).unwrap();
        file.write_all(&[1, 2, 3, 4]).unwrap();
        file.flush().unwrap();
        reset_asr_checkpoint(&mut file).unwrap();
        file.write_all(&[5, 6]).unwrap();
        file.flush().unwrap();
        drop(file);
        assert_eq!(fs::read(&path).unwrap(), [5, 6]);
        fs::remove_dir_all(directory).unwrap();
    }
}
