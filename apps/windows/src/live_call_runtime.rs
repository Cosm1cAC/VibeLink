use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioAcceptance {
    Accepted,
    Duplicate,
    Gap { missing: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct PendingQuestion {
    id: String,
    text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct LiveCallSnapshot {
    last_audio_sequence: Option<u64>,
    accepted_audio_bytes: u64,
    audio_gaps: u64,
    pending_questions: Vec<PendingQuestion>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct LiveCallRuntime {
    sessions: BTreeMap<String, LiveCallSnapshot>,
    #[serde(skip)]
    max_pending_questions: usize,
}

impl LiveCallRuntime {
    pub(crate) fn new(max_pending_questions: usize) -> Self {
        Self {
            sessions: BTreeMap::new(),
            max_pending_questions: max_pending_questions.max(1),
        }
    }

    fn accept_audio(
        &mut self,
        session_id: &str,
        sequence: u64,
        bytes: u64,
    ) -> Result<AudioAcceptance> {
        if session_id.trim().is_empty() {
            bail!("session id is required");
        }
        if bytes == 0 {
            bail!("audio payload must not be empty");
        }
        let snapshot = self.sessions.entry(session_id.to_string()).or_default();
        let acceptance = match snapshot.last_audio_sequence {
            Some(last) if sequence <= last => AudioAcceptance::Duplicate,
            Some(last) if sequence.saturating_sub(last) > 1 => {
                let missing = sequence - last - 1;
                snapshot.last_audio_sequence = Some(sequence);
                snapshot.accepted_audio_bytes = snapshot.accepted_audio_bytes.saturating_add(bytes);
                snapshot.audio_gaps = snapshot.audio_gaps.saturating_add(missing);
                AudioAcceptance::Gap { missing }
            }
            _ => {
                snapshot.last_audio_sequence = Some(sequence);
                snapshot.accepted_audio_bytes = snapshot.accepted_audio_bytes.saturating_add(bytes);
                AudioAcceptance::Accepted
            }
        };
        Ok(acceptance)
    }

    pub(crate) fn accept_next_audio(
        &mut self,
        session_id: &str,
        bytes: u64,
    ) -> Result<(u64, AudioAcceptance)> {
        let next = self
            .sessions
            .get(session_id)
            .and_then(|snapshot| snapshot.last_audio_sequence)
            .and_then(|sequence| sequence.checked_add(1))
            .unwrap_or(1);
        let acceptance = self.accept_audio(session_id, next, bytes)?;
        Ok((next, acceptance))
    }

    pub(crate) fn queue_question(&mut self, session_id: &str, id: &str, text: &str) -> Result<()> {
        if session_id.trim().is_empty() || id.trim().is_empty() || text.trim().is_empty() {
            bail!("session id, question id, and text are required");
        }
        let snapshot = self.sessions.entry(session_id.to_string()).or_default();
        if snapshot
            .pending_questions
            .iter()
            .any(|question| question.id == id)
        {
            return Ok(());
        }
        if snapshot.pending_questions.len() >= self.max_pending_questions {
            bail!("live call pending question limit reached");
        }
        snapshot.pending_questions.push(PendingQuestion {
            id: id.to_string(),
            text: text.to_string(),
        });
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn pending_questions(&self, session_id: &str) -> &[PendingQuestion] {
        self.sessions
            .get(session_id)
            .map(|snapshot| snapshot.pending_questions.as_slice())
            .unwrap_or(&[])
    }

    #[cfg(test)]
    pub(crate) fn acknowledge_question(&mut self, session_id: &str, id: &str) -> Result<bool> {
        let Some(snapshot) = self.sessions.get_mut(session_id) else {
            return Ok(false);
        };
        let before = snapshot.pending_questions.len();
        snapshot
            .pending_questions
            .retain(|question| question.id != id);
        Ok(snapshot.pending_questions.len() != before)
    }

    pub(crate) fn acknowledge_all_questions(&mut self, session_id: &str) -> usize {
        let Some(snapshot) = self.sessions.get_mut(session_id) else {
            return 0;
        };
        let acknowledged = snapshot.pending_questions.len();
        snapshot.pending_questions.clear();
        acknowledged
    }

    #[cfg(test)]
    fn snapshot(&self, session_id: &str) -> Option<&LiveCallSnapshot> {
        self.sessions.get(session_id)
    }

    pub(crate) fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let payload = serde_json::to_vec_pretty(self)?;
        let temporary = sibling_with_suffix(path, ".tmp");
        let backup = sibling_with_suffix(path, ".bak");
        fs::write(&temporary, payload)
            .with_context(|| format!("failed to write {}", temporary.display()))?;
        if backup.exists() {
            fs::remove_file(&backup)
                .with_context(|| format!("failed to remove stale {}", backup.display()))?;
        }
        if path.exists() {
            fs::rename(path, &backup)
                .with_context(|| format!("failed to back up {}", path.display()))?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err(error).with_context(|| format!("failed to commit {}", path.display()));
        }
        if backup.exists() {
            fs::remove_file(&backup)
                .with_context(|| format!("failed to remove {}", backup.display()))?;
        }
        Ok(())
    }

    pub(crate) fn load(path: &Path, max_pending_questions: usize) -> Result<Self> {
        let backup = sibling_with_suffix(path, ".bak");
        let source = if path.exists() {
            path
        } else {
            backup.as_path()
        };
        let payload =
            fs::read(source).with_context(|| format!("failed to read {}", source.display()))?;
        let mut runtime: Self = serde_json::from_slice(&payload)
            .with_context(|| format!("failed to parse {}", source.display()))?;
        runtime.max_pending_questions = max_pending_questions.max(1);
        Ok(runtime)
    }
}

fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

#[derive(Debug, Clone)]
pub(crate) struct PcmRecording {
    path: PathBuf,
    created_at: u64,
    active: bool,
}

impl PcmRecording {
    pub(crate) fn active(path: PathBuf, created_at: u64) -> Self {
        Self {
            path,
            created_at,
            active: true,
        }
    }

    pub(crate) fn completed(path: PathBuf, created_at: u64) -> Self {
        Self {
            path,
            created_at,
            active: false,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PcmRetentionReport {
    pub(crate) deleted: Vec<PathBuf>,
    pub(crate) retained_completed_bytes: u64,
}

pub(crate) fn enforce_pcm_retention(
    recordings: Vec<PcmRecording>,
    max_completed_bytes: u64,
) -> Result<PcmRetentionReport> {
    let mut completed = Vec::new();
    let mut retained_completed_bytes = 0_u64;
    for recording in recordings {
        if recording.active {
            continue;
        }
        let bytes = fs::metadata(&recording.path)
            .with_context(|| format!("failed to inspect {}", recording.path.display()))?
            .len();
        retained_completed_bytes = retained_completed_bytes.saturating_add(bytes);
        completed.push((recording, bytes));
    }
    completed.sort_by_key(|(recording, _)| recording.created_at);

    let mut deleted = Vec::new();
    for (recording, bytes) in completed {
        if retained_completed_bytes <= max_completed_bytes {
            break;
        }
        fs::remove_file(&recording.path)
            .with_context(|| format!("failed to delete {}", recording.path.display()))?;
        retained_completed_bytes = retained_completed_bytes.saturating_sub(bytes);
        deleted.push(recording.path);
    }
    Ok(PcmRetentionReport {
        deleted,
        retained_completed_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn audio_sequence_replay_is_idempotent_and_reports_gaps() {
        let mut runtime = LiveCallRuntime::new(16);
        assert_eq!(
            runtime.accept_audio("call-1", 7, 320).unwrap(),
            AudioAcceptance::Accepted
        );
        assert_eq!(
            runtime.accept_audio("call-1", 7, 320).unwrap(),
            AudioAcceptance::Duplicate
        );
        assert_eq!(
            runtime.accept_audio("call-1", 10, 320).unwrap(),
            AudioAcceptance::Gap { missing: 2 }
        );

        let snapshot = runtime.snapshot("call-1").unwrap();
        assert_eq!(snapshot.last_audio_sequence, Some(10));
        assert_eq!(snapshot.accepted_audio_bytes, 640);
        assert_eq!(snapshot.audio_gaps, 2);
    }

    #[test]
    fn pending_questions_survive_checkpoint_until_acknowledged() {
        let root =
            std::env::temp_dir().join(format!("vibelink-live-call-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let checkpoint = root.join("runtime.json");

        let mut runtime = LiveCallRuntime::new(16);
        runtime
            .queue_question("call-1", "q-1", "What changed?")
            .unwrap();
        runtime.save(&checkpoint).unwrap();

        let mut restored = LiveCallRuntime::load(&checkpoint, 16).unwrap();
        assert_eq!(restored.pending_questions("call-1").len(), 1);
        assert!(restored.acknowledge_question("call-1", "q-1").unwrap());
        assert!(restored.pending_questions("call-1").is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checkpoint_load_recovers_from_backup_after_interrupted_replace() {
        let root =
            std::env::temp_dir().join(format!("vibelink-live-call-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let checkpoint = root.join("runtime.json");
        let backup = root.join("runtime.json.bak");
        let mut runtime = LiveCallRuntime::new(16);
        runtime
            .queue_question("call-1", "q-1", "Recover me")
            .unwrap();
        runtime.save(&checkpoint).unwrap();
        fs::rename(&checkpoint, &backup).unwrap();

        let restored = LiveCallRuntime::load(&checkpoint, 16).unwrap();
        assert_eq!(restored.pending_questions("call-1").len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn maximum_audio_sequence_does_not_overflow() {
        let mut runtime = LiveCallRuntime::new(16);
        assert_eq!(
            runtime.accept_audio("call-1", u64::MAX - 1, 1).unwrap(),
            AudioAcceptance::Accepted
        );
        assert_eq!(
            runtime.accept_audio("call-1", u64::MAX, 1).unwrap(),
            AudioAcceptance::Accepted
        );
    }

    #[test]
    fn pcm_retention_preserves_active_file_and_bounds_completed_bytes() {
        let root = std::env::temp_dir().join(format!("vibelink-pcm-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let active = root.join("active.pcm");
        let old = root.join("old.pcm");
        let recent = root.join("recent.pcm");
        fs::write(&active, vec![1; 8]).unwrap();
        fs::write(&old, vec![2; 8]).unwrap();
        fs::write(&recent, vec![3; 8]).unwrap();

        let report = enforce_pcm_retention(
            vec![
                PcmRecording::completed(old.clone(), 1),
                PcmRecording::active(active.clone(), 2),
                PcmRecording::completed(recent.clone(), 3),
            ],
            8,
        )
        .unwrap();

        assert_eq!(report.deleted, vec![old]);
        assert!(active.exists());
        assert!(recent.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
