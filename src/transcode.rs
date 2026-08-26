use std::io;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use anyhow::{Context as _, bail};
use bytes::Bytes;
use futures::Stream;
use tokio::io as tokio_io;
use tokio::process::{Child, Command};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;
use tokio_util::io::{ReaderStream, StreamReader};

use crate::config::TranscodeConfig;
use crate::error::AppError;
use crate::storage::{ByteStream, GetOptions, StorageBackend};

const FFMPEG_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const AUDIO_BITRATE: &str = "128k";
const ENCODER_THREADS: &str = "1";

/// Shared process budget and immutable FFmpeg settings. A state exists only
/// when transcoding is enabled and startup has verified the required encoders.
pub struct TranscodeState {
  config: TranscodeConfig,
  slots: Arc<Semaphore>,
}

impl TranscodeState {
  pub async fn build(config: &TranscodeConfig) -> Option<Arc<Self>> {
    if !config.enabled {
      return None;
    }

    if let Err(error) = probe_ffmpeg(config).await {
      tracing::warn!(
        ffmpeg = %config.ffmpeg_path,
        %error,
        "FFmpeg unavailable; continuing without video compatibility playback \
         (install FFmpeg with libx264 and AAC encoders)",
      );
      return None;
    }
    tracing::info!(
      ffmpeg = %config.ffmpeg_path,
      max_concurrent = config.max_concurrent,
      timeout_secs = config.timeout_secs,
      "video compatibility transcoding enabled",
    );

    Some(Arc::new(Self {
      config: config.clone(),
      slots: Arc::new(Semaphore::new(config.max_concurrent)),
    }))
  }

  /// Read the original through the storage trait and connect it directly to
  /// FFmpeg stdin. FFmpeg stdout is returned as an async stream; neither side
  /// is collected in memory and no transcoded output file is created.
  pub async fn stream(
    &self,
    backend: Arc<dyn StorageBackend>,
    key: &str,
  ) -> Result<ByteStream, AppError> {
    let source = backend.get_file(key, GetOptions::default()).await?;
    check_source_size(source.content_length, self.config.max_source_bytes)?;

    let permit = Arc::clone(&self.slots)
      .try_acquire_owned()
      .map_err(|_| AppError::Busy("video transcoder is at capacity; try again later".into()))?;

    let mut command = ffmpeg_command(&self.config);
    let mut child = command.spawn().map_err(|error| {
      AppError::Backend(format!(
        "failed to start video transcoder '{}': {error}",
        self.config.ffmpeg_path
      ))
    })?;

    let child_stdin = child
      .stdin
      .take()
      .ok_or_else(|| AppError::Backend("video transcoder stdin is unavailable".into()))?;
    let child_stdout = child
      .stdout
      .take()
      .ok_or_else(|| AppError::Backend("video transcoder stdout is unavailable".into()))?;

    let (cancel_tx, cancel_rx) = mpsc::unbounded_channel();
    let input_cancel_tx = cancel_tx.clone();
    let input_key = key.to_string();
    let input_task = tokio::spawn(async move {
      let mut reader = StreamReader::new(source.body);
      let mut writer = child_stdin;
      if let Err(error) = tokio_io::copy(&mut reader, &mut writer).await {
        if is_expected_disconnect(&error) {
          tracing::debug!(key = %input_key, %error, "video transcoder input closed");
        } else {
          tracing::warn!(key = %input_key, %error, "video transcoder input stream failed");
          let _ = input_cancel_tx.send(());
        }
      }
    });

    let timeout = Duration::from_secs(self.config.timeout_secs);
    tokio::spawn(supervise_process(
      child,
      cancel_rx,
      timeout,
      key.to_string(),
      permit,
    ));

    Ok(Box::pin(ManagedTranscodeStream {
      output: ReaderStream::with_capacity(child_stdout, 64 * 1024),
      cancel_tx: Some(cancel_tx),
      input_task,
    }))
  }
}

fn is_expected_disconnect(error: &io::Error) -> bool {
  matches!(
    error.kind(),
    io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
  )
}

fn check_source_size(content_length: Option<u64>, max_source_bytes: u64) -> Result<(), AppError> {
  match content_length {
    Some(length) if length <= max_source_bytes => Ok(()),
    Some(length) => Err(AppError::Unsupported(format!(
      "video source is {length} bytes; transcoding.max_source_bytes is {max_source_bytes} bytes"
    ))),
    None => Err(AppError::Unsupported(
      "video source size is unknown; refusing unbounded FFmpeg temporary caching".into(),
    )),
  }
}

async fn probe_ffmpeg(config: &TranscodeConfig) -> anyhow::Result<()> {
  let output = tokio::time::timeout(
    FFMPEG_PROBE_TIMEOUT,
    Command::new(&config.ffmpeg_path)
      .args(["-hide_banner", "-encoders"])
      .kill_on_drop(true)
      .output(),
  )
  .await
  .context("FFmpeg capability probe timed out")?
  .with_context(|| format!("run FFmpeg capability probe: {}", config.ffmpeg_path))?;

  if !output.status.success() {
    bail!(
      "FFmpeg capability probe failed with status {}: {}",
      output.status,
      String::from_utf8_lossy(&output.stderr).trim(),
    );
  }

  let encoders = String::from_utf8_lossy(&output.stdout);
  if !encoders.contains("libx264") {
    bail!("FFmpeg is missing the required libx264 video encoder");
  }
  if !encoders.lines().any(|line| {
    line
      .split_whitespace()
      .nth(1)
      .is_some_and(|name| name == "aac")
  }) {
    bail!("FFmpeg is missing the required AAC audio encoder");
  }
  Ok(())
}

fn ffmpeg_command(config: &TranscodeConfig) -> Command {
  let mut command = Command::new(&config.ffmpeg_path);
  command
    .args(ffmpeg_args(config))
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    // Keeping stderr attached avoids buffering an unbounded diagnostic pipe
    // while still surfacing encoder failures in the server logs.
    .stderr(Stdio::inherit())
    .kill_on_drop(true);
  command
}

fn ffmpeg_args(config: &TranscodeConfig) -> Vec<String> {
  let bitrate = format!("{}k", config.max_video_bitrate_kbps);
  let buffer_size = format!("{}k", config.max_video_bitrate_kbps.saturating_mul(2));
  let scale = format!(
    "scale=w='min({},iw)':h='min({},ih)':\
     force_original_aspect_ratio=decrease:force_divisible_by=2",
    config.max_width, config.max_height
  );

  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-threads",
    ENCODER_THREADS,
    "-read_ahead_limit",
    "-1",
    "-i",
    "cache:pipe:0",
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    &scale,
    "-filter_threads",
    ENCODER_THREADS,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    ENCODER_THREADS,
    "-b:v",
    &bitrate,
    "-maxrate",
    &bitrate,
    "-bufsize",
    &buffer_size,
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration",
    "1000000",
    "-f",
    "mp4",
    "pipe:1",
  ]
  .into_iter()
  .map(str::to_string)
  .collect()
}

async fn supervise_process(
  mut child: Child,
  mut cancel_rx: mpsc::UnboundedReceiver<()>,
  timeout: Duration,
  key: String,
  _permit: tokio::sync::OwnedSemaphorePermit,
) {
  tokio::select! {
    result = child.wait() => match result {
      Ok(status) if status.success() => {
        tracing::debug!(%key, %status, "video transcoder finished");
      }
      Ok(status) => {
        tracing::warn!(%key, %status, "video transcoder exited unsuccessfully");
      }
      Err(error) => {
        tracing::warn!(%key, %error, "failed to wait for video transcoder");
      }
    },
    _ = tokio::time::sleep(timeout) => {
      tracing::warn!(%key, timeout_secs = timeout.as_secs(), "video transcoder timed out");
      stop_process(&mut child, &key).await;
    },
    _ = cancel_rx.recv() => {
      stop_process(&mut child, &key).await;
    },
  }
}

async fn stop_process(child: &mut Child, key: &str) {
  match child.try_wait() {
    Ok(Some(_)) => return,
    Ok(None) => {}
    Err(error) => tracing::warn!(%key, %error, "failed to check video transcoder status"),
  }
  if let Err(error) = child.start_kill()
    && !matches!(
      error.kind(),
      io::ErrorKind::InvalidInput | io::ErrorKind::NotFound
    )
  {
    tracing::warn!(%key, %error, "failed to stop video transcoder");
  }
  if let Err(error) = child.wait().await {
    tracing::warn!(%key, %error, "failed to reap video transcoder");
  }
}

/// Couples the HTTP response body's lifetime to both FFmpeg and the source
/// copy task. Dropping the body (normally a disconnected browser) cancels
/// input immediately and asks the supervisor to kill and reap FFmpeg.
struct ManagedTranscodeStream {
  output: ReaderStream<tokio::process::ChildStdout>,
  cancel_tx: Option<mpsc::UnboundedSender<()>>,
  input_task: JoinHandle<()>,
}

impl ManagedTranscodeStream {
  fn cancel(&mut self) {
    self.input_task.abort();
    if let Some(cancel_tx) = self.cancel_tx.take() {
      let _ = cancel_tx.send(());
    }
  }
}

impl Stream for ManagedTranscodeStream {
  type Item = Result<Bytes, io::Error>;

  fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
    let result = Pin::new(&mut self.output).poll_next(cx);
    if matches!(result, Poll::Ready(None)) {
      self.cancel();
    }
    result
  }
}

impl Drop for ManagedTranscodeStream {
  fn drop(&mut self) {
    self.cancel();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ffmpeg_args_stream_fragmented_browser_compatible_mp4() {
    let config = TranscodeConfig::default();
    let args = ffmpeg_args(&config);

    assert!(args.windows(2).any(|pair| pair == ["-i", "cache:pipe:0"]));
    assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
    assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "yuv420p"]));
    assert!(args.windows(2).any(|pair| pair == ["-c:a", "aac"]));
    assert!(
      args
        .windows(2)
        .any(|pair| pair == ["-movflags", "frag_keyframe+empty_moov+default_base_moof"])
    );
    assert!(args.ends_with(&["-f".into(), "mp4".into(), "pipe:1".into()]));
  }

  #[test]
  fn process_budget_rejects_excess_work_without_queueing() {
    let state = TranscodeState {
      config: TranscodeConfig::default(),
      slots: Arc::new(Semaphore::new(1)),
    };
    let first = Arc::clone(&state.slots).try_acquire_owned();
    assert!(first.is_ok());
    assert!(Arc::clone(&state.slots).try_acquire_owned().is_err());
  }

  #[test]
  fn source_size_must_be_known_and_within_limit() {
    assert!(check_source_size(Some(1024), 1024).is_ok());
    assert!(matches!(
      check_source_size(Some(1025), 1024),
      Err(AppError::Unsupported(_))
    ));
    assert!(matches!(
      check_source_size(None, 1024),
      Err(AppError::Unsupported(_))
    ));
  }

  #[test]
  fn expected_disconnect_errors_do_not_warn_or_cancel() {
    assert!(is_expected_disconnect(&io::Error::from(
      io::ErrorKind::BrokenPipe
    )));
    assert!(is_expected_disconnect(&io::Error::from(
      io::ErrorKind::ConnectionReset
    )));
    assert!(!is_expected_disconnect(&io::Error::from(
      io::ErrorKind::UnexpectedEof
    )));
  }

  #[tokio::test]
  async fn missing_ffmpeg_disables_transcoding_without_failing() {
    let config = TranscodeConfig {
      ffmpeg_path: "omni-stream-test-ffmpeg-does-not-exist".into(),
      ..TranscodeConfig::default()
    };

    assert!(TranscodeState::build(&config).await.is_none());
  }
}
