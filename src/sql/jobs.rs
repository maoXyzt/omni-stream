//! In-memory job registry for background JSONL/CSV→Parquet conversions.
//!
//! `POST /api/convert` registers a job and returns its id immediately (202);
//! the background task updates the entry when it finishes.
//! `GET /api/convert/{id}` polls the registry to surface status to the
//! frontend without holding the HTTP connection for the full conversion duration.
//!
//! Entries are kept in memory only — they are lost on restart, which is fine
//! because in-flight conversions also abort on restart.  Finished entries are
//! lazily pruned after `JOB_TTL` to prevent unbounded growth.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long a completed / failed job stays in the registry before being pruned.
/// Must be long enough that the frontend's ~1.5s polling can read the terminal
/// state at least once before it disappears.
const JOB_TTL: Duration = Duration::from_secs(300); // 5 minutes

// --- internal state ----------------------------------------------------------

enum JobState {
  Running,
  Done {
    output_key: String,
    rows_written: u64,
  },
  Failed {
    summary: String,
    hint: String,
    raw: String,
  },
}

struct JobEntry {
  state: JobState,
  started: Instant,
  /// Set when the job transitions to Done or Failed.
  finished: Option<Instant>,
}

// --- public API --------------------------------------------------------------

/// Response shape for `GET /api/convert/{id}`.
#[derive(Debug, Serialize)]
pub struct JobStatusResponse {
  pub job_id: String,
  /// `"running"` | `"done"` | `"failed"`
  pub state: &'static str,
  pub elapsed_ms: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub output_key: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub rows_written: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub summary: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub hint: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub raw: Option<String>,
}

/// Thread-safe, in-memory registry of background conversion jobs.
/// Stored as a field of `SqlState` and shared via `Arc<SqlState>`.
pub struct JobRegistry {
  inner: Mutex<HashMap<String, JobEntry>>,
  next: AtomicU64,
}

impl Default for JobRegistry {
  fn default() -> Self {
    Self::new()
  }
}

impl JobRegistry {
  pub fn new() -> Self {
    Self {
      inner: Mutex::new(HashMap::new()),
      next: AtomicU64::new(1),
    }
  }

  /// Allocate a new job id, insert a `Running` entry, and return the id.
  /// Lazily prunes terminal entries that have exceeded `JOB_TTL`.
  pub fn register(&self) -> String {
    let id = self.next.fetch_add(1, Ordering::Relaxed).to_string();
    let mut map = self.inner.lock().unwrap();
    // Prune stale terminal entries so the map doesn't grow without bound.
    let now = Instant::now();
    map.retain(|_, e| match e.finished {
      Some(f) => now.duration_since(f) < JOB_TTL,
      None => true, // still running — keep
    });
    map.insert(
      id.clone(),
      JobEntry {
        state: JobState::Running,
        started: now,
        finished: None,
      },
    );
    id
  }

  /// Mark a job as successfully completed.
  pub fn complete(&self, id: &str, output_key: String, rows_written: u64) {
    let mut map = self.inner.lock().unwrap();
    if let Some(e) = map.get_mut(id) {
      e.state = JobState::Done {
        output_key,
        rows_written,
      };
      e.finished = Some(Instant::now());
    }
  }

  /// Mark a job as failed with a classified diagnosis.
  pub fn fail(&self, id: &str, summary: String, hint: String, raw: String) {
    let mut map = self.inner.lock().unwrap();
    if let Some(e) = map.get_mut(id) {
      e.state = JobState::Failed { summary, hint, raw };
      e.finished = Some(Instant::now());
    }
  }

  /// Query current status. Returns `None` if the id is unknown or has been
  /// pruned (front-end should treat this as a 404).
  pub fn status(&self, id: &str) -> Option<JobStatusResponse> {
    let map = self.inner.lock().unwrap();
    let e = map.get(id)?;
    let elapsed_ms = match e.finished {
      Some(f) => f.duration_since(e.started).as_millis() as u64,
      None => e.started.elapsed().as_millis() as u64,
    };
    let resp = match &e.state {
      JobState::Running => JobStatusResponse {
        job_id: id.to_owned(),
        state: "running",
        elapsed_ms,
        output_key: None,
        rows_written: None,
        summary: None,
        hint: None,
        raw: None,
      },
      JobState::Done {
        output_key,
        rows_written,
      } => JobStatusResponse {
        job_id: id.to_owned(),
        state: "done",
        elapsed_ms,
        output_key: Some(output_key.clone()),
        rows_written: Some(*rows_written),
        summary: None,
        hint: None,
        raw: None,
      },
      JobState::Failed { summary, hint, raw } => JobStatusResponse {
        job_id: id.to_owned(),
        state: "failed",
        elapsed_ms,
        output_key: None,
        rows_written: None,
        summary: Some(summary.clone()),
        hint: Some(hint.clone()),
        raw: Some(raw.clone()),
      },
    };
    Some(resp)
  }
}

// --- tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn register_returns_unique_ids() {
    let reg = JobRegistry::new();
    let a = reg.register();
    let b = reg.register();
    assert_ne!(a, b);
  }

  #[test]
  fn new_job_is_running() {
    let reg = JobRegistry::new();
    let id = reg.register();
    let s = reg.status(&id).unwrap();
    assert_eq!(s.state, "running");
    assert!(s.output_key.is_none());
    assert!(s.rows_written.is_none());
    assert!(s.summary.is_none());
  }

  #[test]
  fn complete_transitions_to_done() {
    let reg = JobRegistry::new();
    let id = reg.register();
    reg.complete(&id, "out.parquet".into(), 42);
    let s = reg.status(&id).unwrap();
    assert_eq!(s.state, "done");
    assert_eq!(s.output_key.as_deref(), Some("out.parquet"));
    assert_eq!(s.rows_written, Some(42));
  }

  #[test]
  fn fail_transitions_to_failed() {
    let reg = JobRegistry::new();
    let id = reg.register();
    reg.fail(&id, "oops".into(), "try X".into(), "raw err".into());
    let s = reg.status(&id).unwrap();
    assert_eq!(s.state, "failed");
    assert_eq!(s.summary.as_deref(), Some("oops"));
    assert_eq!(s.hint.as_deref(), Some("try X"));
    assert_eq!(s.raw.as_deref(), Some("raw err"));
  }

  #[test]
  fn unknown_id_returns_none() {
    let reg = JobRegistry::new();
    assert!(reg.status("999").is_none());
  }

  #[test]
  fn complete_on_unknown_id_is_noop() {
    let reg = JobRegistry::new();
    // Must not panic.
    reg.complete("999", "x.parquet".into(), 0);
  }
}
