use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

pub fn normalize_pcm16le(input: &[u8], sample_rate: u32, channels: u16) -> Result<Vec<u8>> {
    if !(8_000..=48_000).contains(&sample_rate) || !matches!(channels, 1 | 2) {
        anyhow::bail!("unsupported audio format");
    }
    let samples = input.len() / 2 / channels as usize;
    if samples == 0 {
        return Ok(Vec::new());
    }
    let mut mono = Vec::with_capacity(samples);
    for frame in 0..samples {
        let mut sum = 0i32;
        for channel in 0..channels as usize {
            let offset = (frame * channels as usize + channel) * 2;
            sum += i16::from_le_bytes([input[offset], input[offset + 1]]) as i32;
        }
        mono.push((sum / channels as i32) as i16);
    }
    if sample_rate == TARGET_SAMPLE_RATE {
        return Ok(to_bytes(&mono));
    }
    let output_len =
        ((mono.len() as u64 * TARGET_SAMPLE_RATE as u64) / sample_rate as u64) as usize;
    let mut output = Vec::with_capacity(output_len * 2);
    for index in 0..output_len {
        let source = index as f64 * sample_rate as f64 / TARGET_SAMPLE_RATE as f64;
        let left = source.floor() as usize;
        let right = (left + 1).min(mono.len() - 1);
        let fraction = source - left as f64;
        let value =
            (mono[left] as f64 * (1.0 - fraction) + mono[right] as f64 * fraction).round() as i16;
        output.extend_from_slice(&value.to_le_bytes());
    }
    Ok(output)
}

fn to_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

#[derive(Debug)]
pub struct VadSegmenter {
    buffer: Vec<u8>,
    speech: bool,
    silence_ms: u32,
    pre_roll: Vec<u8>,
    sample_rate: u32,
    threshold: f32,
}

impl VadSegmenter {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            buffer: Vec::new(),
            speech: false,
            silence_ms: 0,
            pre_roll: Vec::new(),
            sample_rate,
            threshold: 0.012,
        }
    }

    pub fn push(&mut self, pcm: &[u8]) -> Vec<Vec<u8>> {
        let mut segments = Vec::new();
        for chunk in pcm.chunks((self.sample_rate as usize / 50) * 2) {
            if chunk.len() < 4 {
                continue;
            }
            let rms = rms(chunk);
            let voiced = rms >= self.threshold;
            if !self.speech {
                self.pre_roll.extend_from_slice(chunk);
                let max = self.sample_rate as usize * 2 * 240 / 1000;
                if self.pre_roll.len() > max {
                    let excess = self.pre_roll.len() - max;
                    self.pre_roll.drain(..excess);
                }
                if voiced {
                    self.speech = true;
                    self.buffer.extend_from_slice(&self.pre_roll);
                    self.pre_roll.clear();
                }
            } else {
                self.buffer.extend_from_slice(chunk);
                if voiced {
                    self.silence_ms = 0;
                } else {
                    self.silence_ms += 20;
                }
                if self.silence_ms >= 700 || self.buffer.len() >= self.sample_rate as usize * 2 * 30
                {
                    if self.buffer.len() >= self.sample_rate as usize * 2 * 180 / 1000 {
                        segments.push(std::mem::take(&mut self.buffer));
                    }
                    self.speech = false;
                    self.silence_ms = 0;
                    self.pre_roll.clear();
                }
            }
        }
        segments
    }

    pub fn flush(&mut self) -> Option<Vec<u8>> {
        self.speech = false;
        self.silence_ms = 0;
        self.pre_roll.clear();
        if self.buffer.len() >= self.sample_rate as usize * 2 * 180 / 1000 {
            Some(std::mem::take(&mut self.buffer))
        } else {
            self.buffer.clear();
            None
        }
    }
}

fn rms(bytes: &[u8]) -> f32 {
    let mut energy = 0f64;
    let mut count = 0usize;
    for pair in bytes.chunks_exact(2) {
        let value = i16::from_le_bytes([pair[0], pair[1]]) as f64 / 32768.0;
        energy += value * value;
        count += 1;
    }
    if count == 0 {
        0.0
    } else {
        (energy / count as f64).sqrt() as f32
    }
}

pub fn wav_bytes(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let riff_len = 36 + data_len;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_len.to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

#[derive(Clone, Debug)]
pub struct WhisperConfig {
    pub binary: PathBuf,
    pub model: PathBuf,
    pub language: String,
    pub temp_dir: PathBuf,
}

impl WhisperConfig {
    pub fn from_environment(data_dir: &Path) -> Self {
        let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let bin_dir = std::env::var_os("VIBELINK_WHISPER_CPP_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("tools/whisper-cpp/bin"));
        let model_dir = std::env::var_os("VIBELINK_WHISPER_CPP_MODELS")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("tools/whisper-cpp/models"));
        let bin_dir = absolute_from(&root, &bin_dir);
        let model_dir = absolute_from(&root, &model_dir);
        let binary_name = std::env::var_os("VIBELINK_WHISPER_CPP_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("whisper-cli.exe"));
        let model_name = std::env::var_os("VIBELINK_WHISPER_CPP_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("ggml-base.bin"));
        let binary = if binary_name.is_absolute() {
            binary_name
        } else {
            bin_dir.join(binary_name)
        };
        let model = if model_name.is_absolute() {
            model_name
        } else {
            model_dir.join(model_name)
        };
        Self {
            binary,
            model,
            language: std::env::var("VIBELINK_WHISPER_CPP_LANGUAGE")
                .unwrap_or_else(|_| "zh".into()),
            temp_dir: absolute_from(&root, data_dir).join("live-call-asr-tmp"),
        }
    }
    pub fn available(&self) -> bool {
        self.binary.is_file() && self.model.is_file()
    }
}

pub fn transcribe(config: &WhisperConfig, pcm: &[u8], id: &str) -> Result<String> {
    if !config.available() {
        anyhow::bail!("whisper.cpp binary or model unavailable");
    }
    fs::create_dir_all(&config.temp_dir)?;
    let stem = config
        .temp_dir
        .join(format!("{id}-{}", uuid::Uuid::new_v4()));
    let wav = stem.with_extension("wav");
    let prefix = stem.to_string_lossy().to_string();
    fs::write(&wav, wav_bytes(pcm, TARGET_SAMPLE_RATE))?;
    let working_dir = common_path_ancestor(&config.model, &wav);
    let model_arg = config
        .model
        .strip_prefix(&working_dir)
        .unwrap_or(&config.model);
    let wav_arg = wav.strip_prefix(&working_dir).unwrap_or(&wav);
    let output_arg = stem.strip_prefix(&working_dir).unwrap_or(&stem);
    let mut child = Command::new(&config.binary)
        .current_dir(&working_dir)
        .args([
            "--model",
            model_arg.to_string_lossy().as_ref(),
            "--file",
            wav_arg.to_string_lossy().as_ref(),
            "--language",
            &config.language,
            "--output-json",
            "--output-file",
            output_arg.to_string_lossy().as_ref(),
            "--no-timestamps",
            "--no-prints",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| "launch whisper.cpp")?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() >= Duration::from_secs(60) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&wav);
            anyhow::bail!("whisper.cpp timed out after 60 seconds");
        }
        thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output()?;
    let json_path = prefix.clone() + ".json";
    let transcript = if Path::new(&json_path).is_file() {
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&json_path)?)?;
        value
            .get("transcription")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
                    .collect::<String>()
            })
            .unwrap_or_default()
    } else {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };
    let _ = fs::remove_file(wav);
    let _ = fs::remove_file(json_path);
    if !output.status.success() {
        anyhow::bail!(
            "whisper.cpp failed with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(transcript.trim().to_string())
}

fn absolute_from(root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    }
}

fn common_path_ancestor(left: &Path, right: &Path) -> PathBuf {
    let mut ancestor = left
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    while !right.starts_with(&ancestor) {
        if !ancestor.pop() {
            return PathBuf::from(".");
        }
    }
    ancestor
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_stereo_and_rate() {
        let input = [0, 0, 0, 0, 0x10, 0, 0x10, 0];
        let output = normalize_pcm16le(&input, 8000, 2).unwrap();
        assert_eq!(output.len(), 8);
    }
    #[test]
    fn vad_finalizes_after_silence() {
        let mut vad = VadSegmenter::new(16_000);
        let tone = vec![0x40u8; 16_000 * 2 / 5];
        let silence = vec![0u8; 16_000 * 2];
        assert_eq!(vad.push(&tone).len(), 0);
        assert_eq!(vad.push(&silence).len(), 1);
    }
    #[test]
    fn wav_has_pcm_header() {
        let wav = wav_bytes(&[1, 2], 16_000);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }

    #[cfg(windows)]
    #[test]
    fn manages_whisper_process_and_reads_json_output() {
        let directory =
            std::env::temp_dir().join(format!("vibelink-whisper-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let binary = directory.join("mock-whisper.cmd");
        fs::write(&binary, "@echo off\r\nset prefix=\r\n:loop\r\nif \"%~1\"==\"\" goto done\r\nif \"%~1\"==\"--output-file\" (set prefix=%~2& shift)\r\nshift\r\ngoto loop\r\n:done\r\necho {\"transcription\":[{\"text\":\"hello\"}]} > \"%prefix%.json\"\r\n").unwrap();
        let model = directory.join("model.bin");
        fs::write(&model, []).unwrap();
        let config = WhisperConfig {
            binary,
            model,
            language: "en".into(),
            temp_dir: directory.join("tmp"),
        };
        assert_eq!(transcribe(&config, &[0; 640], "segment").unwrap(), "hello");
        assert!(fs::read_dir(&config.temp_dir).unwrap().next().is_none());
        fs::remove_dir_all(directory).unwrap();
    }
}
