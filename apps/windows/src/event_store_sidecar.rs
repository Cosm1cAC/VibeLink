use crate::sidecar_protocol::{
    now_iso, sidecar_arg, sidecar_arg_or_default, write_sidecar_error, write_sidecar_result,
    SidecarRequest,
};
use crate::tool_events_store::{list_tool_events, ToolEventListOptions};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead},
    path::Path,
    time::Duration,
};

struct EventStoreSidecar {
    db: Connection,
    read_only: bool,
    started_at: String,
    requests: u64,
    responses: u64,
    failures: u64,
    last_request_at: String,
    last_response_at: String,
    last_failure_at: String,
    last_error: String,
}

#[derive(Default, Deserialize)]
struct EventStoreListTaskOptions {
    after: Option<i64>,
    limit: Option<i64>,
}

#[derive(Default, Deserialize)]
struct EventStoreListLiveOptions {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    after: Option<i64>,
    limit: Option<i64>,
}

#[derive(Default, Deserialize)]
struct EventStoreUnifiedOptions {
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    #[serde(rename = "liveCallSessionId")]
    live_call_session_id: Option<String>,
    #[serde(rename = "toolRunId")]
    tool_run_id: Option<String>,
    after: Option<i64>,
    limit: Option<i64>,
}

pub(crate) fn run(db_path: &Path, read_only: bool) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut sidecar = EventStoreSidecar::open(db_path, read_only)?;

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: SidecarRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_sidecar_error(&mut stdout, &Value::Null, &error.to_string())?;
                continue;
            }
        };

        sidecar.record_request();
        if request.method == "__close" {
            sidecar.record_response();
            write_sidecar_result(&mut stdout, &request.id, Value::Bool(true))?;
            break;
        }

        match sidecar.handle(&request.method, &request.args) {
            Ok(result) => {
                sidecar.record_response();
                write_sidecar_result(&mut stdout, &request.id, result)?;
            }
            Err(error) => {
                sidecar.record_failure(&format!("{error:#}"));
                write_sidecar_error(&mut stdout, &request.id, &format!("{error:#}"))?;
            }
        }
    }

    Ok(())
}

fn is_event_store_write_method(method: &str) -> bool {
    matches!(
        method,
        "insertTaskEvent"
            | "insertTaskEvents"
            | "insertToolEvent"
            | "insertToolEvents"
            | "pruneToolEvents"
            | "insertLiveCallEvent"
            | "insertLiveCallEvents"
            | "pruneLiveCallEvents"
            | "upsertEventAck"
            | "deleteDeviceEventAcks"
            | "recordCompactionMarker"
    )
}

impl EventStoreSidecar {
    fn open(db_path: &Path, read_only: bool) -> Result<Self> {
        let db = if read_only {
            Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        } else {
            Connection::open(db_path)
        }
        .with_context(|| format!("Failed to open event store database: {}", db_path.display()))?;
        db.busy_timeout(Duration::from_millis(5000))?;
        if read_only {
            db.execute_batch(
                "PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
            )?;
        } else {
            db.execute_batch(
                "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
            )?;
        }
        Ok(Self {
            db,
            read_only,
            started_at: now_iso(),
            requests: 0,
            responses: 0,
            failures: 0,
            last_request_at: String::new(),
            last_response_at: String::new(),
            last_failure_at: String::new(),
            last_error: String::new(),
        })
    }

    fn record_request(&mut self) {
        self.requests += 1;
        self.last_request_at = now_iso();
    }

    fn record_response(&mut self) {
        self.responses += 1;
        self.last_response_at = now_iso();
    }

    fn record_failure(&mut self, message: &str) {
        self.failures += 1;
        self.last_failure_at = now_iso();
        self.last_error = message.to_string();
    }

    fn handle(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        if self.read_only && is_event_store_write_method(method) {
            bail!("Event store sidecar is read-only; method {method} is not allowed.");
        }
        match method {
            "__health" => Ok(json!({
                "ok": true,
                "implementation": "rust",
                "protocolVersion": 1,
                "supportedMethods": [
                    "insertTaskEvent",
                    "insertTaskEvents",
                    "listTaskEvents",
                    "getTaskEventCount",
                    "insertToolEvent",
                    "insertToolEvents",
                    "listToolEvents",
                    "getToolEventStats",
                    "pruneToolEvents",
                    "insertLiveCallEvent",
                    "insertLiveCallEvents",
                    "listLiveCallEvents",
                    "pruneLiveCallEvents",
                    "listUnifiedEvents",
                    "replayWindow",
                    "upsertEventAck",
                    "getEventAck",
                    "listEventAcks",
                    "deleteDeviceEventAcks",
                    "planRetention",
                    "recordCompactionMarker",
                    "listCompactionMarkers"
                ],
                "controlMethods": ["__health", "stats", "__close"],
                "schemaReady": self.schema_ready()?,
                "readOnly": self.read_only,
                "startedAt": self.started_at
            })),
            "stats" => Ok(json!({
                "implementation": "rust",
                "protocolVersion": 1,
                "startedAt": self.started_at,
                "pending": 0,
                "readOnly": self.read_only,
                "requests": self.requests,
                "responses": self.responses,
                "failures": self.failures,
                "lastRequestAt": self.last_request_at,
                "lastResponseAt": self.last_response_at,
                "lastFailureAt": self.last_failure_at,
                "lastError": self.last_error
            })),
            "insertTaskEvent" => {
                let task_id: String = sidecar_arg(args, 0)?;
                let event: Value = sidecar_arg(args, 1)?;
                Ok(json!(self.insert_task_event(&task_id, &event)?))
            }
            "insertTaskEvents" => {
                let task_id: String = sidecar_arg(args, 0)?;
                let events: Vec<Value> = sidecar_arg_or_default(args, 1)?;
                Ok(json!(self.insert_task_events(&task_id, &events)?))
            }
            "listTaskEvents" => {
                let task_id: String = sidecar_arg(args, 0)?;
                let options: EventStoreListTaskOptions = sidecar_arg_or_default(args, 1)?;
                Ok(Value::Array(self.list_task_events(&task_id, &options)?))
            }
            "getTaskEventCount" => {
                let task_id: String = sidecar_arg(args, 0)?;
                Ok(json!(self.get_task_event_count(&task_id)?))
            }
            "insertToolEvent" => {
                let tool_run_id: String = sidecar_arg(args, 0)?;
                let event: Value = sidecar_arg(args, 1)?;
                Ok(json!(self.insert_tool_event(&tool_run_id, &event)?))
            }
            "insertToolEvents" => {
                let tool_run_id: String = sidecar_arg(args, 0)?;
                let events: Vec<Value> = sidecar_arg_or_default(args, 1)?;
                Ok(json!(self.insert_tool_events(&tool_run_id, &events)?))
            }
            "listToolEvents" => {
                let options: ToolEventListOptions = sidecar_arg_or_default(args, 0)?;
                Ok(Value::Array(list_tool_events(&self.db, &options)?))
            }
            "insertLiveCallEvent" => {
                let session_id: String = sidecar_arg(args, 0)?;
                let event: Value = sidecar_arg(args, 1)?;
                Ok(json!(self.insert_live_call_event(&session_id, &event)?))
            }
            "insertLiveCallEvents" => {
                let session_id: String = sidecar_arg(args, 0)?;
                let events: Vec<Value> = sidecar_arg_or_default(args, 1)?;
                Ok(json!(self.insert_live_call_events(&session_id, &events)?))
            }
            "listLiveCallEvents" => {
                let options: EventStoreListLiveOptions = sidecar_arg_or_default(args, 0)?;
                Ok(Value::Array(self.list_live_call_events(&options)?))
            }
            "listUnifiedEvents" => {
                let options: EventStoreUnifiedOptions = sidecar_arg_or_default(args, 0)?;
                Ok(Value::Array(self.list_unified_events(&options)?))
            }
            "replayWindow" => {
                let options: EventStoreUnifiedOptions = sidecar_arg_or_default(args, 0)?;
                Ok(self.replay_window(&options)?)
            }
            "getToolEventStats" => Ok(self.get_tool_event_stats()?),
            "pruneToolEvents" => Ok(json!({
                "cutoff": "",
                "keepLatest": 0,
                "maxPrunableCursor": 0,
                "prunable": 0,
                "deleted": 0,
                "dryRun": true,
                "stats": self.get_tool_event_stats()?
            })),
            "pruneLiveCallEvents" => Ok(Value::Null),
            "upsertEventAck" => {
                let device: String = sidecar_arg(args, 0)?;
                let stream: String = sidecar_arg(args, 1)?;
                let cursor: i64 = sidecar_arg_or_default(args, 2)?;
                let options: Value = sidecar_arg_or_default(args, 3)?;
                self.upsert_event_ack(&device, &stream, cursor, &options)
            }
            "getEventAck" => {
                let device: String = sidecar_arg(args, 0)?;
                let stream: String = sidecar_arg(args, 1)?;
                self.get_event_ack(&device, &stream)
            }
            "listEventAcks" => {
                let options: Value = sidecar_arg_or_default(args, 0)?;
                self.list_event_acks(&options)
            }
            "deleteDeviceEventAcks" => {
                let device: String = sidecar_arg(args, 0)?;
                Ok(json!(self.db.execute(
                    "DELETE FROM event_acks WHERE device_id = ?",
                    params![device]
                )?))
            }
            "planRetention" => {
                let options: Value = sidecar_arg_or_default(args, 0)?;
                self.plan_retention(&options)
            }
            "recordCompactionMarker" => {
                let options: Value = sidecar_arg_or_default(args, 0)?;
                self.record_compaction_marker(&options)
            }
            "listCompactionMarkers" => {
                let options: Value = sidecar_arg_or_default(args, 0)?;
                self.list_compaction_markers(&options)
            }
            _ => bail!("Unsupported event store sidecar method: {method}"),
        }
    }

    fn schema_ready(&self) -> Result<bool> {
        for table in [
            "task_events",
            "tool_runs",
            "tool_events",
            "live_calls",
            "live_call_events",
            "event_acks",
            "compaction_markers",
        ] {
            let exists: Option<i64> = self
                .db
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                    params![table],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn upsert_event_ack(
        &self,
        device: &str,
        stream: &str,
        cursor: i64,
        options: &Value,
    ) -> Result<Value> {
        if device.trim().is_empty() || stream.trim().is_empty() {
            bail!("deviceId and streamId are required.");
        }
        let now = now_iso();
        let event_id = event_string(options, "eventId");
        let metadata = options
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| json!({}));
        self.db.execute(
            "INSERT INTO event_acks (device_id, stream_id, cursor, event_id, acked_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(device_id, stream_id) DO UPDATE SET cursor = MAX(event_acks.cursor, excluded.cursor), event_id = excluded.event_id, acked_at = excluded.acked_at, metadata_json = excluded.metadata_json",
            params![device, stream, cursor.max(0), event_id, now, serde_json::to_string(&metadata)?],
        )?;
        self.get_event_ack(device, stream)
    }

    fn get_event_ack(&self, device: &str, stream: &str) -> Result<Value> {
        Ok(self.db.query_row(
            "SELECT device_id, stream_id, cursor, event_id, acked_at, metadata_json FROM event_acks WHERE device_id = ? AND stream_id = ?",
            params![device, stream],
            event_ack_row,
        ).optional()?.unwrap_or(Value::Null))
    }

    fn list_event_acks(&self, options: &Value) -> Result<Value> {
        let device = event_string(options, "deviceId");
        let stream = event_string(options, "streamId");
        let mut stmt = self.db.prepare(
            "SELECT device_id, stream_id, cursor, event_id, acked_at, metadata_json FROM event_acks WHERE (? = '' OR device_id = ?) AND (? = '' OR stream_id = ?) ORDER BY stream_id, device_id",
        )?;
        let rows = stmt.query_map(params![device, device, stream, stream], event_ack_row)?;
        Ok(Value::Array(
            rows.collect::<std::result::Result<Vec<_>, _>>()?,
        ))
    }

    fn plan_retention(&self, options: &Value) -> Result<Value> {
        let stream = event_string(options, "streamId");
        let days = options
            .get("retentionDays")
            .and_then(Value::as_i64)
            .unwrap_or(30)
            .max(0);
        let keep = options
            .get("keepLatest")
            .and_then(Value::as_i64)
            .unwrap_or(5000)
            .max(0);
        let current = options
            .get("now")
            .and_then(Value::as_i64)
            .and_then(chrono::DateTime::from_timestamp_millis)
            .unwrap_or_else(|| std::time::SystemTime::now().into());
        let ack_cursor: Option<i64> = if stream.is_empty() {
            None
        } else {
            self.db.query_row(
                "SELECT MIN(cursor) FROM event_acks WHERE stream_id = ?",
                params![stream],
                |row| row.get(0),
            )?
        };
        Ok(json!({
            "streamId": stream,
            "cutoff": (current - chrono::Duration::days(days))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "keepLatest": keep,
            "ackCursor": ack_cursor,
            "safeCursor": ack_cursor.map(|cursor| cursor.max(0))
        }))
    }

    fn record_compaction_marker(&self, options: &Value) -> Result<Value> {
        let id = event_string_or(options, "markerId", &uuid::Uuid::new_v4().to_string());
        let stream = event_string(options, "streamId");
        let from = options
            .get("fromCursor")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let to = options.get("toCursor").and_then(Value::as_i64).unwrap_or(0);
        let now = now_iso();
        let metadata = options
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| json!({}));
        self.db.execute(
            "INSERT OR REPLACE INTO compaction_markers (marker_id, stream_id, from_cursor, to_cursor, compacted_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
            params![id, stream, from, to, now, serde_json::to_string(&metadata)?],
        )?;
        Ok(
            json!({"markerId": id, "streamId": stream, "fromCursor": from, "toCursor": to, "compactedAt": now, "metadata": metadata}),
        )
    }

    fn list_compaction_markers(&self, options: &Value) -> Result<Value> {
        let stream = event_string(options, "streamId");
        let after = options
            .get("afterCursor")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let limit = options
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(100)
            .clamp(1, 1000);
        let mut stmt = self.db.prepare(
            "SELECT marker_id, stream_id, from_cursor, to_cursor, compacted_at, metadata_json FROM compaction_markers WHERE (? = '' OR stream_id = ?) AND to_cursor > ? ORDER BY to_cursor LIMIT ?",
        )?;
        let rows = stmt.query_map(params![stream, stream, after, limit], |row| {
            Ok(json!({
                "markerId": row.get::<_, String>(0)?,
                "streamId": row.get::<_, String>(1)?,
                "fromCursor": row.get::<_, i64>(2)?,
                "toCursor": row.get::<_, i64>(3)?,
                "compactedAt": row.get::<_, String>(4)?,
                "metadata": json_column(row.get::<_, Option<String>>(5)?)
            }))
        })?;
        Ok(Value::Array(
            rows.collect::<std::result::Result<Vec<_>, _>>()?,
        ))
    }

    fn insert_task_event(&self, task_id: &str, event: &Value) -> Result<Option<i64>> {
        let current = now_iso();
        let event_at = event_string_or(event, "at", &current);
        let event_id = event_string_or(event, "id", &format!("{task_id}:{event_at}:rust"));
        let event_kind = event_string_or(event, "kind", &classify_task_event_kind(event));
        let turn_id = event_string(event, "turnId");
        let block_id = event_string(event, "blockId");
        let mut event_json = event_object(event);
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "kind", event_kind.clone());
        set_json_string(&mut event_json, "turnId", turn_id.clone());
        set_json_string(&mut event_json, "blockId", block_id.clone());

        let inserted = self.db.execute(
            "INSERT OR IGNORE INTO task_events (
                    task_id, event_id, event_type, event_at, text, payload_json, event_json,
                    created_at, event_kind, turn_id, block_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                task_id,
                event_id,
                event_string(event, "type"),
                event_at,
                event_string(event, "text"),
                payload_json(event)?,
                serde_json::to_string(&event_json)?,
                current,
                event_kind,
                turn_id,
                block_id
            ],
        )?;
        if inserted > 0 {
            return Ok(Some(self.db.last_insert_rowid()));
        }
        self.cursor_for("task_events", "task_id", task_id, &event_id)
    }

    fn insert_task_events(&mut self, task_id: &str, events: &[Value]) -> Result<Vec<Option<i64>>> {
        let mut cursors = Vec::with_capacity(events.len());
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        for event in events {
            match self.insert_task_event(task_id, event) {
                Ok(cursor) => cursors.push(cursor),
                Err(error) => {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(error);
                }
            }
        }
        self.db.execute_batch("COMMIT")?;
        Ok(cursors)
    }

    fn list_task_events(
        &self,
        task_id: &str,
        options: &EventStoreListTaskOptions,
    ) -> Result<Vec<Value>> {
        let mut statement = self.db.prepare(
            "SELECT cursor, event_json FROM task_events WHERE task_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![
                task_id,
                options.after.unwrap_or(0),
                event_limit(options.limit, 500, 5000)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| event_json_with_cursor(row?)).collect()
    }

    fn get_task_event_count(&self, task_id: &str) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT COUNT(*) FROM task_events WHERE task_id = ?",
            params![task_id],
            |row| row.get::<_, i64>(0),
        )?)
    }

    fn tool_run_owner(&self, tool_run_id: &str) -> Result<Option<(String, String)>> {
        self.db
            .query_row(
                "SELECT task_id, workspace_id FROM tool_runs WHERE id = ?",
                params![tool_run_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    ))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    fn insert_tool_event(&self, tool_run_id: &str, event: &Value) -> Result<Option<i64>> {
        let Some((task_id, workspace_id)) = self.tool_run_owner(tool_run_id)? else {
            return Ok(None);
        };
        self.insert_tool_event_with_owner(tool_run_id, event, &task_id, &workspace_id)
    }

    fn insert_tool_event_with_owner(
        &self,
        tool_run_id: &str,
        event: &Value,
        default_task_id: &str,
        default_workspace_id: &str,
    ) -> Result<Option<i64>> {
        let current = now_iso();
        let event_at = event_string_or(event, "at", &current);
        let event_id = event_string_or(event, "id", &format!("{tool_run_id}:{event_at}:rust"));
        let task_id = event_string_or(event, "taskId", default_task_id);
        let workspace_id = event_string_or(event, "workspaceId", default_workspace_id);
        let mut event_json = event_object(event);
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "toolRunId", tool_run_id.to_string());
        set_json_string(&mut event_json, "taskId", task_id.clone());
        set_json_string(&mut event_json, "workspaceId", workspace_id.clone());

        let inserted = self.db.execute(
            "INSERT OR IGNORE INTO tool_events (
                    tool_run_id, task_id, workspace_id, event_id, event_type, event_at,
                    text, payload_json, event_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                tool_run_id,
                task_id,
                workspace_id,
                event_id,
                event_string_or(event, "type", "tool.event"),
                event_at,
                event_string(event, "text"),
                payload_json(event)?,
                serde_json::to_string(&event_json)?,
                current
            ],
        )?;
        if inserted > 0 {
            return Ok(Some(self.db.last_insert_rowid()));
        }
        self.cursor_for("tool_events", "tool_run_id", tool_run_id, &event_id)
    }

    fn insert_tool_events(
        &mut self,
        tool_run_id: &str,
        events: &[Value],
    ) -> Result<Vec<Option<i64>>> {
        let Some((task_id, workspace_id)) = self.tool_run_owner(tool_run_id)? else {
            return Ok(vec![None; events.len()]);
        };
        let mut cursors = Vec::with_capacity(events.len());
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        for event in events {
            match self.insert_tool_event_with_owner(tool_run_id, event, &task_id, &workspace_id) {
                Ok(cursor) => cursors.push(cursor),
                Err(error) => {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(error);
                }
            }
        }
        self.db.execute_batch("COMMIT")?;
        Ok(cursors)
    }

    fn live_call_exists(&self, session_id: &str) -> Result<bool> {
        let exists: Option<String> = self
            .db
            .query_row(
                "SELECT id FROM live_calls WHERE id = ?",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(exists.is_some())
    }

    fn insert_live_call_event(&self, session_id: &str, event: &Value) -> Result<Option<i64>> {
        if !self.live_call_exists(session_id)? {
            return Ok(None);
        }
        self.insert_live_call_event_existing(session_id, event)
    }

    fn insert_live_call_event_existing(
        &self,
        session_id: &str,
        event: &Value,
    ) -> Result<Option<i64>> {
        let current = now_iso();
        let event_at = event_string_or(event, "at", &current);
        let event_id = event_string_or(event, "id", &format!("{session_id}:{event_at}:rust"));
        let mut event_json = event_object(event);
        set_json_string(&mut event_json, "id", event_id.clone());
        set_json_string(&mut event_json, "at", event_at.clone());
        set_json_string(&mut event_json, "sessionId", session_id.to_string());

        let inserted = self.db.execute(
            "INSERT OR IGNORE INTO live_call_events (
                    session_id, event_id, event_type, event_at, text, payload_json, event_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                session_id,
                event_id,
                event_string_or(event, "type", "live_call.event"),
                event_at,
                event_string(event, "text"),
                payload_json(event)?,
                serde_json::to_string(&event_json)?,
                current
            ],
        )?;
        if inserted > 0 {
            return Ok(Some(self.db.last_insert_rowid()));
        }
        self.cursor_for("live_call_events", "session_id", session_id, &event_id)
    }

    fn insert_live_call_events(
        &mut self,
        session_id: &str,
        events: &[Value],
    ) -> Result<Vec<Option<i64>>> {
        if !self.live_call_exists(session_id)? {
            return Ok(vec![None; events.len()]);
        }
        let mut cursors = Vec::with_capacity(events.len());
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        for event in events {
            match self.insert_live_call_event_existing(session_id, event) {
                Ok(cursor) => cursors.push(cursor),
                Err(error) => {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(error);
                }
            }
        }
        self.db.execute_batch("COMMIT")?;
        Ok(cursors)
    }

    fn list_live_call_events(&self, options: &EventStoreListLiveOptions) -> Result<Vec<Value>> {
        let session_id = clean_option(&options.session_id);
        if session_id.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self.db.prepare(
            "SELECT cursor, event_json FROM live_call_events
             WHERE session_id = ? AND cursor > ?
             ORDER BY cursor ASC LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![
                session_id,
                options.after.unwrap_or(0),
                event_limit(options.limit, 500, 2000)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| event_json_with_cursor(row?)).collect()
    }

    fn list_unified_events(&self, options: &EventStoreUnifiedOptions) -> Result<Vec<Value>> {
        let limit = event_limit(options.limit, 200, 2000);
        let after = options.after.unwrap_or(0);
        let task_id = clean_option(&options.task_id);
        let session_id = clean_option(&options.live_call_session_id);
        let tool_run_id = clean_option(&options.tool_run_id);
        let mut items = Vec::new();

        if options.live_call_session_id.is_none() && options.tool_run_id.is_none() {
            let mut statement = self.db.prepare(
                "SELECT cursor, task_id, event_id, event_type, event_kind, turn_id, block_id, event_at, text
                 FROM task_events WHERE (? = '' OR task_id = ?) AND cursor > ? ORDER BY cursor ASC LIMIT ?",
            )?;
            let rows =
                statement.query_map(params![task_id, task_id, after, limit], unified_task_row)?;
            for row in rows {
                items.push(row?);
            }
        }

        if options.live_call_session_id.is_none() && items.len() < limit as usize {
            let remaining = limit - items.len() as i64;
            let mut statement = self.db.prepare(
                "SELECT cursor, task_id, tool_run_id, event_id, event_type, event_at, text
                 FROM tool_events
                 WHERE (? = '' OR task_id = ?) AND (? = '' OR tool_run_id = ?) AND cursor > ?
                 ORDER BY cursor ASC LIMIT ?",
            )?;
            let rows = statement.query_map(
                params![task_id, task_id, tool_run_id, tool_run_id, after, remaining],
                unified_tool_row,
            )?;
            for row in rows {
                items.push(row?);
            }
        }

        if options.task_id.is_none()
            && options.tool_run_id.is_none()
            && items.len() < limit as usize
        {
            let remaining = limit - items.len() as i64;
            let mut statement = self.db.prepare(
                "SELECT cursor, session_id, event_id, event_type, event_at, text
                 FROM live_call_events WHERE (? = '' OR session_id = ?) AND cursor > ? ORDER BY cursor ASC LIMIT ?",
            )?;
            let rows = statement.query_map(
                params![session_id, session_id, after, remaining],
                unified_live_row,
            )?;
            for row in rows {
                items.push(row?);
            }
        }

        items.sort_by_key(|item| item.get("cursor").and_then(Value::as_i64).unwrap_or(0));
        items.truncate(limit as usize);
        Ok(items)
    }

    fn replay_window(&self, options: &EventStoreUnifiedOptions) -> Result<Value> {
        let limit = event_limit(options.limit, 200, 2000);
        let options = EventStoreUnifiedOptions {
            task_id: options.task_id.clone(),
            live_call_session_id: options.live_call_session_id.clone(),
            tool_run_id: options.tool_run_id.clone(),
            after: options.after.map(|value| value / 10),
            limit: Some(limit + 1),
        };
        let mut items = self.list_unified_events(&options)?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        for item in &mut items {
            if let Some(object) = item.as_object_mut() {
                let raw_cursor = object.get("cursor").and_then(Value::as_i64).unwrap_or(0);
                let source_rank = match object.get("kind").and_then(Value::as_str).unwrap_or("") {
                    "tool" => 2,
                    "live_call" => 3,
                    _ => 1,
                };
                object.insert("rawCursor".to_string(), json!(raw_cursor));
                object.insert("cursor".to_string(), json!((raw_cursor * 10) + source_rank));
            }
        }
        let next_cursor = items
            .last()
            .and_then(|item| item.get("cursor").and_then(Value::as_i64))
            .unwrap_or(options.after.unwrap_or(0));
        Ok(
            json!({ "items": items, "nextCursor": next_cursor, "hasMore": has_more, "limit": limit }),
        )
    }

    fn get_tool_event_stats(&self) -> Result<Value> {
        let row = self.db.query_row(
            "SELECT COUNT(*), MIN(cursor), MAX(cursor), MIN(event_at), MAX(event_at) FROM tool_events",
            [],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            )),
        )?;
        Ok(json!({
            "count": row.0,
            "minCursor": row.1.unwrap_or(0),
            "maxCursor": row.2.unwrap_or(0),
            "oldestAt": row.3.unwrap_or_default(),
            "newestAt": row.4.unwrap_or_default()
        }))
    }

    fn cursor_for(
        &self,
        table: &str,
        owner_col: &str,
        owner_id: &str,
        event_id: &str,
    ) -> Result<Option<i64>> {
        let sql = format!("SELECT cursor FROM {table} WHERE {owner_col} = ? AND event_id = ?");
        Ok(self
            .db
            .query_row(&sql, params![owner_id, event_id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()?)
    }
}

fn event_limit(value: Option<i64>, default_limit: i64, max_limit: i64) -> i64 {
    match value {
        Some(value) if value > 0 => value.min(max_limit.max(1)),
        _ => default_limit.max(1).min(max_limit.max(1)),
    }
}

fn clean_option(value: &Option<String>) -> String {
    value
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(160)
        .collect()
}

fn event_string(event: &Value, key: &str) -> String {
    event
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn json_column(value: Option<String>) -> Value {
    value
        .and_then(|json| serde_json::from_str::<Value>(&json).ok())
        .unwrap_or_else(|| json!({}))
}

fn event_ack_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "deviceId": row.get::<_, String>(0)?,
        "streamId": row.get::<_, String>(1)?,
        "cursor": row.get::<_, i64>(2)?,
        "eventId": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "ackedAt": row.get::<_, String>(4)?,
        "metadata": json_column(row.get::<_, Option<String>>(5)?)
    }))
}

fn event_string_or(event: &Value, key: &str, fallback: &str) -> String {
    match event.get(key).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => fallback.to_string(),
    }
}

fn event_object(event: &Value) -> Value {
    if event.is_object() {
        event.clone()
    } else {
        json!({})
    }
}

fn set_json_string(value: &mut Value, key: &str, text: String) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.to_string(), Value::String(text));
    }
}

fn payload_json(event: &Value) -> Result<String> {
    Ok(serde_json::to_string(
        event.get("payload").unwrap_or(&Value::Null),
    )?)
}

fn classify_task_event_kind(event: &Value) -> String {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "user_message" | "user" | "attachment" => "user",
        "assistant_message" | "assistant" => "assistant",
        "system" => "system",
        "error" => "error",
        "summarization" => "summary",
        "stderr" | "stdout" => "output",
        _ if event_type.starts_with("live_call.") => "live_call",
        _ if event_type.starts_with("approval.") => "approval",
        _ if event_type.starts_with("tool.") => "tool",
        _ => "system",
    }
    .to_string()
}

fn event_json_with_cursor((cursor, event_json): (i64, String)) -> Result<Value> {
    let mut value = serde_json::from_str::<Value>(&event_json).unwrap_or_else(|_| json!({}));
    if !value.is_object() {
        value = json!({});
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("cursor".to_string(), json!(cursor));
    }
    Ok(value)
}

fn unified_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "cursor": row.get::<_, i64>(0)?,
        "taskId": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        "eventId": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        "type": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "kind": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        "turnId": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        "blockId": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        "at": row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        "text": row.get::<_, Option<String>>(8)?.unwrap_or_default(),
        "sessionId": "",
        "toolRunId": ""
    }))
}

fn unified_tool_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "cursor": row.get::<_, i64>(0)?,
        "taskId": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        "toolRunId": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        "eventId": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "type": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        "kind": "tool",
        "at": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        "text": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        "sessionId": "",
        "turnId": "",
        "blockId": ""
    }))
}

fn unified_live_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "cursor": row.get::<_, i64>(0)?,
        "sessionId": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        "eventId": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        "type": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "kind": "live_call",
        "at": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        "text": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        "taskId": "",
        "toolRunId": "",
        "turnId": "",
        "blockId": ""
    }))
}
