use super::protocol::HostEvent;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct SegmentMeta {
    index: u64,
    path: PathBuf,
    bytes: u64,
    max_seq: u64,
}

#[derive(Debug)]
pub struct EventSpool {
    directory: PathBuf,
    execution_id: String,
    quota_bytes: u64,
    segment_bytes: u64,
    segments: Vec<SegmentMeta>,
    active_index: u64,
    last_seq: u64,
    acked_seq: u64,
    retained_bytes: u64,
    truncation_marker_seq: Option<u64>,
}

impl EventSpool {
    pub fn open(
        execution_dir: &Path,
        execution_id: &str,
        quota_bytes: u64,
        segment_bytes: u64,
        acked_seq: u64,
        last_seq_floor: u64,
    ) -> Result<Self> {
        let directory = execution_dir.join("spool");
        fs::create_dir_all(&directory)
            .with_context(|| format!("failed to create execution spool {}", directory.display()))?;

        let mut paths = fs::read_dir(&directory)
            .with_context(|| format!("failed to enumerate spool {}", directory.display()))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                parse_segment_index(&name).map(|index| (index, entry.path()))
            })
            .collect::<Vec<_>>();
        paths.sort_by_key(|(index, _)| *index);

        let mut segments = Vec::new();
        let mut previous_seq = None;
        let mut last_seq = 0;
        let mut retained_bytes = 0;
        let mut truncation_marker_seq = None;
        for (index, path) in paths {
            let events = recover_segment(&path)?;
            if events.is_empty() {
                let _ = fs::remove_file(&path);
                continue;
            }
            for event in &events {
                if event.execution_id != execution_id {
                    bail!(
                        "spool segment {} belongs to another execution",
                        path.display()
                    );
                }
                if let Some(previous) = previous_seq {
                    if event.host_seq != previous + 1 {
                        bail!(
                            "spool sequence gap at {}: expected {}, found {}",
                            path.display(),
                            previous + 1,
                            event.host_seq
                        );
                    }
                }
                previous_seq = Some(event.host_seq);
                last_seq = event.host_seq;
                if event.event_type == "output.truncated" && event.host_seq > acked_seq {
                    truncation_marker_seq = Some(event.host_seq);
                }
            }
            let bytes = fs::metadata(&path)?.len();
            retained_bytes += bytes;
            segments.push(SegmentMeta {
                index,
                path,
                bytes,
                max_seq: events.last().map(|event| event.host_seq).unwrap_or(0),
            });
        }

        if last_seq_floor > last_seq && acked_seq < last_seq_floor {
            bail!(
                "manifest hostSeq {last_seq_floor} is ahead of the retained spool hostSeq {last_seq}"
            );
        }
        last_seq = last_seq.max(last_seq_floor);
        let active_index = segments.last().map(|segment| segment.index).unwrap_or(1);
        let mut spool = Self {
            directory,
            execution_id: execution_id.to_string(),
            quota_bytes,
            segment_bytes,
            segments,
            active_index,
            last_seq,
            acked_seq: acked_seq.min(last_seq),
            retained_bytes,
            truncation_marker_seq,
        };
        spool.prune_acked_segments()?;
        Ok(spool)
    }

    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    pub fn acked_seq(&self) -> u64 {
        self.acked_seq
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> u64 {
        self.retained_bytes
    }

    pub fn append(&mut self, event_type: &str, payload: Value) -> Result<Option<HostEvent>> {
        let is_output = matches!(event_type, "stream.stdout" | "stream.stderr" | "stream.pty");
        let candidate = self.build_event(event_type, payload);
        let candidate_bytes = serialized_line_len(&candidate)?;
        if is_output && self.retained_bytes.saturating_add(candidate_bytes) > self.quota_bytes {
            if self.truncation_marker_seq.is_some() {
                return Ok(None);
            }
            let marker = self.build_event(
                "output.truncated",
                json!({
                    "reason": "spool_quota",
                    "quotaBytes": self.quota_bytes,
                    "retainedBytes": self.retained_bytes
                }),
            );
            self.write_event(&marker)?;
            self.truncation_marker_seq = Some(marker.host_seq);
            return Ok(Some(marker));
        }

        self.write_event(&candidate)?;
        Ok(Some(candidate))
    }

    pub fn replay(&self, after_host_seq: u64, limit: usize) -> Result<Vec<HostEvent>> {
        if limit == 0 || limit > 5000 {
            bail!("event replay limit must be between 1 and 5000");
        }
        let mut events = Vec::new();
        for segment in &self.segments {
            if segment.max_seq <= after_host_seq {
                continue;
            }
            for event in read_segment(&segment.path)? {
                if event.host_seq > after_host_seq {
                    events.push(event);
                    if events.len() == limit {
                        return Ok(events);
                    }
                }
            }
        }
        Ok(events)
    }

    pub fn acknowledge(&mut self, host_seq: u64) -> Result<()> {
        if host_seq > self.last_seq {
            bail!(
                "cannot acknowledge hostSeq {host_seq}; last durable hostSeq is {}",
                self.last_seq
            );
        }
        if host_seq <= self.acked_seq {
            return Ok(());
        }
        self.acked_seq = host_seq;
        self.prune_acked_segments()?;
        if self
            .truncation_marker_seq
            .is_some_and(|marker| marker <= self.acked_seq)
            && self.retained_bytes < self.quota_bytes
        {
            self.truncation_marker_seq = None;
        }
        Ok(())
    }

    fn build_event(&self, event_type: &str, payload: Value) -> HostEvent {
        let host_seq = self.last_seq + 1;
        HostEvent {
            execution_id: self.execution_id.clone(),
            host_seq,
            event_id: format!("{}:{host_seq}", self.execution_id),
            event_type: event_type.to_string(),
            at: super::now_rfc3339(),
            payload,
        }
    }

    fn write_event(&mut self, event: &HostEvent) -> Result<()> {
        let mut line = serde_json::to_vec(event).context("failed to serialize host event")?;
        line.push(b'\n');
        let active_bytes = self
            .segments
            .last()
            .filter(|segment| segment.index == self.active_index)
            .map(|segment| segment.bytes)
            .unwrap_or(0);
        if active_bytes > 0 && active_bytes.saturating_add(line.len() as u64) > self.segment_bytes {
            self.active_index += 1;
        }
        let path = self.segment_path(self.active_index);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("failed to open spool segment {}", path.display()))?;
        file.write_all(&line)
            .with_context(|| format!("failed to append spool segment {}", path.display()))?;
        file.sync_data()
            .with_context(|| format!("failed to sync spool segment {}", path.display()))?;

        if let Some(segment) = self
            .segments
            .iter_mut()
            .find(|segment| segment.index == self.active_index)
        {
            segment.bytes += line.len() as u64;
            segment.max_seq = event.host_seq;
        } else {
            self.segments.push(SegmentMeta {
                index: self.active_index,
                path,
                bytes: line.len() as u64,
                max_seq: event.host_seq,
            });
        }
        self.retained_bytes += line.len() as u64;
        self.last_seq = event.host_seq;
        Ok(())
    }

    fn prune_acked_segments(&mut self) -> Result<()> {
        let mut retained = Vec::with_capacity(self.segments.len());
        let mut removed_active = false;
        for segment in self.segments.drain(..) {
            if segment.max_seq <= self.acked_seq {
                removed_active |= segment.index == self.active_index;
                fs::remove_file(&segment.path).with_context(|| {
                    format!("failed to prune spool segment {}", segment.path.display())
                })?;
                self.retained_bytes = self.retained_bytes.saturating_sub(segment.bytes);
            } else {
                retained.push(segment);
            }
        }
        self.segments = retained;
        if self.segments.is_empty() && removed_active {
            self.active_index += 1;
        } else if !self.segments.is_empty() {
            self.active_index = self
                .segments
                .last()
                .map(|segment| segment.index)
                .unwrap_or(self.active_index);
        }
        Ok(())
    }

    fn segment_path(&self, index: u64) -> PathBuf {
        self.directory.join(format!("events-{index:08}.jsonl"))
    }
}

fn parse_segment_index(name: &str) -> Option<u64> {
    name.strip_prefix("events-")?
        .strip_suffix(".jsonl")?
        .parse()
        .ok()
}

fn serialized_line_len(event: &HostEvent) -> Result<u64> {
    Ok(serde_json::to_vec(event)?.len() as u64 + 1)
}

fn recover_segment(path: &Path) -> Result<Vec<HostEvent>> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("failed to open spool segment {}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let valid_len = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    if valid_len != bytes.len() {
        file.set_len(valid_len as u64)?;
        file.seek(SeekFrom::Start(valid_len as u64))?;
        file.sync_data()?;
        bytes.truncate(valid_len);
    }
    parse_lines(path, &bytes)
}

fn read_segment(path: &Path) -> Result<Vec<HostEvent>> {
    let bytes = fs::read(path)
        .with_context(|| format!("failed to read spool segment {}", path.display()))?;
    parse_lines(path, &bytes)
}

fn parse_lines(path: &Path, bytes: &[u8]) -> Result<Vec<HostEvent>> {
    let mut events = Vec::new();
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        events.push(serde_json::from_slice(line).with_context(|| {
            format!("spool segment {} contains an invalid event", path.display())
        })?);
    }
    Ok(events)
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .with_context(|| format!("failed to create atomic temp file {}", temp.display()))?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    atomic_replace(&temp, path).with_context(|| {
        format!(
            "failed to replace {} with atomic temp file {}",
            path.display(),
            temp.display()
        )
    })
}

#[cfg(windows)]
fn atomic_replace(temp: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    for attempt in 0..40 {
        let result = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(5) | Some(32)) || attempt == 39 {
            let _ = fs::remove_file(temp);
            return Err(error.into());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    unreachable!()
}

#[cfg(not(windows))]
fn atomic_replace(temp: &Path, target: &Path) -> Result<()> {
    fs::rename(temp, target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("vibelink-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn spool_replays_in_order_and_prunes_acknowledged_segments() {
        let root = temp_dir("spool-replay");
        let mut spool = EventSpool::open(&root, "e1", 1024 * 1024, 180, 0, 0).unwrap();
        for index in 0..8 {
            spool
                .append(
                    "stream.stdout",
                    json!({ "index": index, "text": "x".repeat(48) }),
                )
                .unwrap();
        }
        let replay = spool.replay(3, 3).unwrap();
        assert_eq!(
            replay
                .iter()
                .map(|event| event.host_seq)
                .collect::<Vec<_>>(),
            vec![4, 5, 6]
        );
        let before = spool.retained_bytes();
        spool.acknowledge(5).unwrap();
        assert!(spool.retained_bytes() < before);
        assert_eq!(spool.replay(5, 100).unwrap().first().unwrap().host_seq, 6);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn spool_recovers_only_complete_jsonl_records() {
        let root = temp_dir("spool-tail");
        {
            let mut spool = EventSpool::open(&root, "e1", 1024 * 1024, 1024, 0, 0).unwrap();
            spool.append("execution.started", json!({})).unwrap();
        }
        let path = root.join("spool").join("events-00000001.jsonl");
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"partial\":")
            .unwrap();
        let spool = EventSpool::open(&root, "e1", 1024 * 1024, 1024, 0, 0).unwrap();
        assert_eq!(spool.last_seq(), 1);
        assert_eq!(spool.replay(0, 10).unwrap().len(), 1);
        assert!(fs::read(path).unwrap().ends_with(b"\n"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quota_emits_one_durable_truncation_marker() {
        let root = temp_dir("spool-quota");
        let mut spool = EventSpool::open(&root, "e1", 300, 1024, 0, 0).unwrap();
        let first = spool
            .append("stream.stdout", json!({ "data": "x".repeat(400) }))
            .unwrap()
            .unwrap();
        assert_eq!(first.event_type, "output.truncated");
        assert!(spool
            .append("stream.stdout", json!({ "data": "more" }))
            .unwrap()
            .is_none());
        spool
            .append("execution.exited", json!({ "exitCode": 0 }))
            .unwrap();
        let types = spool
            .replay(0, 10)
            .unwrap()
            .into_iter()
            .map(|event| event.event_type)
            .collect::<Vec<_>>();
        assert_eq!(types, vec!["output.truncated", "execution.exited"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_sequence_floor_survives_fully_pruned_spool() {
        let root = temp_dir("spool-floor");
        {
            let mut spool = EventSpool::open(&root, "e1", 1024 * 1024, 1024, 0, 0).unwrap();
            spool.append("execution.started", json!({})).unwrap();
            spool
                .append("execution.exited", json!({ "exitCode": 0 }))
                .unwrap();
            spool.acknowledge(2).unwrap();
            assert!(spool.replay(0, 10).unwrap().is_empty());
        }
        let mut recovered = EventSpool::open(&root, "e1", 1024 * 1024, 1024, 2, 2).unwrap();
        let event = recovered
            .append("execution.lost", json!({ "reason": "test" }))
            .unwrap()
            .unwrap();
        assert_eq!(event.host_seq, 3);
        assert_eq!(event.event_id, "e1:3");
        let _ = fs::remove_dir_all(root);
    }
}
