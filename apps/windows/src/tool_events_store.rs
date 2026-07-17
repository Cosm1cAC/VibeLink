use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Default, Deserialize)]
pub(crate) struct ToolEventListOptions {
    #[serde(rename = "toolRunId")]
    pub(crate) tool_run_id: Option<String>,
    #[serde(rename = "workspaceId")]
    pub(crate) workspace_id: Option<String>,
    #[serde(rename = "taskId")]
    pub(crate) task_id: Option<String>,
    pub(crate) after: Option<f64>,
    pub(crate) limit: Option<i64>,
}

pub(crate) fn list_tool_events(
    connection: &Connection,
    options: &ToolEventListOptions,
) -> Result<Vec<Value>> {
    let tool_run_id = clean_filter(&options.tool_run_id);
    let workspace_id = clean_filter(&options.workspace_id);
    let task_id = clean_filter(&options.task_id);
    let mut statement = connection
        .prepare(
            "SELECT cursor, event_json FROM tool_events
             WHERE cursor > ?1
               AND (?2 = '' OR tool_run_id = ?2)
               AND (?3 = '' OR workspace_id = ?3)
               AND (?4 = '' OR task_id = ?4)
             ORDER BY cursor ASC LIMIT ?5",
        )
        .context("Cannot prepare tool-events query")?;
    let rows = statement
        .query_map(
            params![
                options.after.unwrap_or(0.0),
                tool_run_id,
                workspace_id,
                task_id,
                replay_limit(options.limit)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .context("Cannot query tool events")?;
    rows.map(|row| {
        let (cursor, event_json) = row.context("Cannot read tool-event row")?;
        let mut value = serde_json::from_str::<Value>(&event_json).unwrap_or_else(|_| json!({}));
        if !value.is_object() {
            value = json!({});
        }
        value
            .as_object_mut()
            .expect("tool event is normalized to an object")
            .insert("cursor".to_string(), json!(cursor));
        Ok(value)
    })
    .collect()
}

fn replay_limit(value: Option<i64>) -> i64 {
    match value {
        Some(value) if value > 0 => value.min(5_000),
        _ => 500,
    }
}

fn clean_filter(value: &Option<String>) -> String {
    value
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(160)
        .collect()
}
