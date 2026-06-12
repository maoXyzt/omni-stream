//! DuckDB error classification for user-facing diagnostics.
//!
//! The single public entry point [`diagnose`] maps a raw DuckDB error string
//! to an accurate [`Diagnosis`] (summary + actionable hint) without leaking
//! storage credentials.  When the error does not match any known pattern
//! (e.g. plain SQL syntax errors) it returns `None` so the caller can fall
//! back to the verbatim message.

use crate::sql::SqlTarget;

/// A classified, user-facing description of a DuckDB failure.
pub struct Diagnosis {
  /// One-line accurate cause (English). Replaces misleading hardcoded prefixes.
  pub summary: String,
  /// Actionable troubleshooting guidance, tailored to the target type.
  pub hint: String,
}

/// Classify a raw DuckDB error into an accurate summary + hint.
///
/// `context` is the URI or short description of what was being read/written
/// (no secrets, e.g. `s3://bucket/key` or a local path).  When `Some`, it
/// is woven into the hint text so the user can see which file triggered the
/// error.  Pass `None` when there is no single meaningful path to report
/// (e.g. for an ad-hoc SQL query that may reference many files).
///
/// Returns `Some` when a known infrastructure pattern is detected; `None`
/// for pure SQL syntax / binder errors where the verbatim DuckDB message is
/// already actionable.
pub fn diagnose(target: &SqlTarget, context: Option<&str>, raw: &str) -> Option<Diagnosis> {
  let lower = raw.to_lowercase();
  let is_s3 = matches!(target, SqlTarget::S3(_));
  // Human-readable path description used inside hint strings.  Falls back to
  // "the path" when no specific URI is available (e.g. ad-hoc SQL queries).
  let path_desc = context
    .map(|c| format!("'{c}'"))
    .unwrap_or_else(|| "the path".to_string());

  // Rule 1 — S3 write fell back to the sandboxed local filesystem.
  // This is the most common root cause when httpfs or credentials are
  // misconfigured: DuckDB cannot route the s3:// URI through httpfs and
  // attempts the local filesystem, which is explicitly disabled in S3 mode.
  if lower.contains("localfilesystem") && lower.contains("disabled") {
    let hint = if is_s3 {
      format!(
        "DuckDB tried to access {path_desc} through the local filesystem instead of S3/httpfs. \
         Verify that: (1) the storage's S3 endpoint, region, and credentials are configured \
         correctly; (2) the httpfs extension loaded successfully — it requires outbound network \
         access to the DuckDB extension repository on first install; \
         (3) the path resolves to an s3:// URI (not a local path).",
      )
    } else {
      format!(
        "Unexpected: a local target hit the S3 filesystem sandbox path for {path_desc}. \
         This may be a configuration bug — please report it.",
      )
    };
    return Some(Diagnosis {
      summary: "S3 write fell back to the sandboxed local filesystem.".into(),
      hint,
    });
  }

  // Rule 2 — S3 authentication / permission failures.
  if lower.contains("signaturedoesnotmatch")
    || lower.contains("invalidaccesskeyid")
    || lower.contains("access denied")
    || lower.contains("accessdenied")
    || lower.contains(" 403")
    || lower.contains("403 forbidden")
  {
    let (summary, hint) = if is_s3 {
      (
        "S3 rejected the request: authentication or permission failure.".to_string(),
        format!(
          "Check the storage's access_key, secret_key, and region. \
           Confirm the bucket policy grants s3:PutObject (for writes) and s3:GetObject \
           (for reads) for {path_desc}. \
           Also verify the endpoint URL matches your S3-compatible service.",
        ),
      )
    } else {
      (
        "The destination rejected the write: permission denied.".to_string(),
        format!(
          "Check filesystem write permissions and ownership of the directory containing {path_desc}. \
           Ensure the server process has write access to the storage root.",
        ),
      )
    };
    return Some(Diagnosis { summary, hint });
  }

  // Rule 3 — Generic permission error (not matched by Rule 2).
  if lower.contains("permission") {
    let (summary, hint) = if is_s3 {
      (
        "The S3 destination rejected the write (permission error).".to_string(),
        format!(
          "Confirm the S3 credentials can write to {path_desc} (s3:PutObject) \
           and the bucket is not configured as read-only.",
        ),
      )
    } else {
      (
        "The local filesystem rejected the write (permission error).".to_string(),
        format!(
          "The OS denied writing {path_desc}. \
           Check directory permissions, ownership, and that the storage root \
           is writable by the server process.",
        ),
      )
    };
    return Some(Diagnosis { summary, hint });
  }

  // Rule 4 — httpfs / aws extension could not be loaded (S3 targets only).
  // Local targets do not load httpfs, so this pattern would be a false positive
  // for them; skip with is_s3 guard.
  let is_extension_failure = is_s3
    && (lower.contains("failed to download extension")
      || (lower.contains("install") && lower.contains("httpfs"))
      || (lower.contains("extension") && (lower.contains("network") || lower.contains("http")))
      || lower.contains("unable to connect"));
  if is_extension_failure {
    return Some(Diagnosis {
      summary: "Could not load the httpfs/aws extension needed for S3 access.".into(),
      hint: "The server needs outbound network access to the DuckDB extension repository \
             to download httpfs/aws on first use. \
             Alternatively, pre-install the extensions on the host with \
             `duckdb -c \"INSTALL httpfs; INSTALL aws;\"`."
        .into(),
    });
  }

  // Rule 5 — Source file could not be read.
  let is_not_found = lower.contains("no files found")
    || (lower.contains("io error") && lower.contains("read"))
    || lower.contains("no such file")
    || lower.contains("cannot open file");
  if is_not_found {
    let hint = if is_s3 {
      format!(
        "Verify the source object exists at {path_desc} and the S3 credentials \
         include s3:GetObject permission for that path.",
      )
    } else {
      format!("Verify the source file exists at {path_desc} and is readable by the server process.",)
    };
    return Some(Diagnosis {
      summary: "The source file could not be read.".into(),
      hint,
    });
  }

  // Rule 6 — JSON / CSV parse error (most relevant for the convert endpoint).
  // Deliberately excludes the broad "Conversion Error" DuckDB class, which
  // covers many unrelated type-coercion failures (e.g. invalid casts in SQL).
  let is_parse_error = lower.contains("read_json")
    || lower.contains("read_csv")
    || lower.contains("invalid input syntax")
    || lower.contains("malformed")
    || lower.contains("json parse error");
  if is_parse_error {
    return Some(Diagnosis {
      summary: "The source file could not be parsed as JSON/CSV.".into(),
      hint: "DuckDB's auto-parser rejected the file. \
             Check that it is valid newline-delimited JSON (.jsonl/.ndjson) \
             or a consistent CSV/TSV; mixed schemas, ragged rows, or a BOM \
             can trip auto-detection."
        .into(),
    });
  }

  // No recognised infrastructure pattern — return None so the caller can
  // surface the verbatim DuckDB message (useful for SQL syntax errors).
  None
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use super::*;
  use crate::config::S3Config;
  use crate::sql::SqlTarget;

  fn s3_target() -> SqlTarget {
    SqlTarget::S3(S3Config {
      endpoint: Some("http://localhost:9000".into()),
      bucket: Some("mybucket".into()),
      access_key: Some("key".into()),
      secret_key: Some("secret".into()),
      region: Some("us-east-1".into()),
      force_path_style: true,
    })
  }

  fn local_target() -> SqlTarget {
    SqlTarget::Local {
      root_path: PathBuf::from("/data/storage"),
    }
  }

  // ── Rule 1: LocalFileSystem disabled ─────────────────────────────────────

  #[test]
  fn rule1_s3_localfilesystem_disabled() {
    let raw = "Permission Error: File system LocalFileSystem has been disabled by configuration";
    let diag = diagnose(&s3_target(), Some("s3://mybucket/data.parquet"), raw).unwrap();
    assert!(
      diag.summary.contains("local filesystem"),
      "summary: {}",
      diag.summary
    );
    assert!(diag.hint.contains("httpfs"), "hint: {}", diag.hint);
    assert!(diag.hint.contains("endpoint"), "hint: {}", diag.hint);
    // Must NOT carry the old misleading "read-only" text.
    assert!(
      !diag.hint.to_lowercase().contains("read-only"),
      "hint must not say read-only: {}",
      diag.hint
    );
  }

  #[test]
  fn rule1_local_target_localfilesystem_disabled_is_config_bug() {
    let raw = "LocalFileSystem has been disabled by configuration";
    let diag = diagnose(&local_target(), Some("s3://??/file"), raw).unwrap();
    assert!(
      diag.hint.to_lowercase().contains("bug"),
      "hint: {}",
      diag.hint
    );
  }

  // ── Rule 2: auth / permission ─────────────────────────────────────────────

  #[test]
  fn rule2_signature_mismatch_s3() {
    let raw = "HTTP Error: The request signature we calculated does not match the signature you provided: SignatureDoesNotMatch";
    let diag = diagnose(&s3_target(), Some("s3://mybucket/out.parquet"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("authentication"),
      "summary: {}",
      diag.summary
    );
    assert!(diag.hint.contains("access_key"), "hint: {}", diag.hint);
  }

  #[test]
  fn rule2_access_denied_s3() {
    let raw = "HTTP 403 Forbidden: Access Denied";
    let diag = diagnose(&s3_target(), Some("s3://mybucket/out.parquet"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("permission")
        || diag.summary.to_lowercase().contains("authentication"),
      "{}",
      diag.summary
    );
  }

  #[test]
  fn rule2_access_denied_local() {
    let raw = "Access Denied: cannot write /data/storage/out.parquet";
    let diag = diagnose(&local_target(), Some("/data/storage/out.parquet"), raw).unwrap();
    assert!(
      diag.hint.to_lowercase().contains("filesystem")
        || diag.hint.to_lowercase().contains("permission"),
      "hint: {}",
      diag.hint
    );
  }

  // ── Rule 3: generic permission ────────────────────────────────────────────

  #[test]
  fn rule3_permission_local() {
    let raw = "IO Error: Permission denied writing /data/out.parquet";
    let diag = diagnose(&local_target(), Some("/data/out.parquet"), raw).unwrap();
    assert!(
      diag.hint.to_lowercase().contains("permission") || diag.hint.to_lowercase().contains("owner"),
      "hint: {}",
      diag.hint
    );
    assert!(!diag.hint.contains("s3:PutObject"), "{}", diag.hint);
  }

  #[test]
  fn rule3_permission_s3() {
    let raw = "IO Error: Permission denied for s3://mybucket/out.parquet";
    let diag = diagnose(&s3_target(), Some("s3://mybucket/out.parquet"), raw).unwrap();
    assert!(diag.hint.contains("s3:PutObject"), "hint: {}", diag.hint);
  }

  // ── Rule 4: extension load failure (S3 only) ──────────────────────────────

  #[test]
  fn rule4_extension_download_failed_s3() {
    let raw = "Failed to download extension 'httpfs': network unreachable";
    let diag = diagnose(&s3_target(), Some("s3://bucket/file"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("extension"),
      "summary: {}",
      diag.summary
    );
    assert!(
      diag.hint.to_lowercase().contains("network") || diag.hint.to_lowercase().contains("install"),
      "hint: {}",
      diag.hint
    );
  }

  #[test]
  fn rule4_extension_failure_local_target_returns_none() {
    // Local targets don't use httpfs — extension-load patterns should not
    // trigger a false-positive S3 hint.
    let raw = "Failed to download extension 'httpfs': network unreachable";
    assert!(
      diagnose(&local_target(), Some("/data/file"), raw).is_none(),
      "extension failure on local target should return None, not an httpfs hint"
    );
  }

  // ── Rule 5: source file not found ────────────────────────────────────────

  #[test]
  fn rule5_no_files_found() {
    let raw = "IO Error: No files found that match the pattern 's3://bucket/missing.jsonl'";
    let diag = diagnose(&s3_target(), Some("s3://bucket/missing.jsonl"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("source file"),
      "summary: {}",
      diag.summary
    );
    assert!(diag.hint.contains("s3:GetObject"), "hint: {}", diag.hint);
  }

  #[test]
  fn rule5_no_such_file_local() {
    let raw = "IO Error: No such file or directory: /data/storage/missing.jsonl";
    let diag = diagnose(&local_target(), Some("/data/storage/missing.jsonl"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("source file"),
      "summary: {}",
      diag.summary
    );
  }

  // ── Rule 6: parse error ───────────────────────────────────────────────────

  #[test]
  fn rule6_json_parse_error() {
    let raw = "Invalid Input Error: Could not parse as JSON (read_json_auto): unexpected token";
    let diag = diagnose(&s3_target(), Some("s3://bucket/data.jsonl"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("parsed"),
      "{}",
      diag.summary
    );
    assert!(
      diag.hint.contains("jsonl") || diag.hint.contains("JSON"),
      "{}",
      diag.hint
    );
  }

  #[test]
  fn rule6_csv_parse_error() {
    let raw = "Could not read_csv_auto: malformed CSV at row 42";
    let diag = diagnose(&local_target(), Some("/data/data.csv"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("parsed"),
      "{}",
      diag.summary
    );
  }

  #[test]
  fn rule6_conversion_error_sql_type_cast_not_matched() {
    // "Conversion Error" is too broad — it covers type-coercion SQL errors
    // and must NOT be classified as a file-parse problem.
    let raw = "Conversion Error: Could not convert string '2024-13-01' to DATE";
    assert!(
      diagnose(&s3_target(), None, raw).is_none(),
      "generic type-cast Conversion Error should return None"
    );
  }

  // ── Rule 7 (fallback): unknown error returns None ────────────────────────

  #[test]
  fn fallback_unknown_returns_none() {
    let raw = "Binder Error: Referenced column 'foo' not found in FROM clause";
    assert!(
      diagnose(&s3_target(), None, raw).is_none(),
      "SQL binder errors should return None"
    );
  }

  #[test]
  fn fallback_syntax_error_returns_none() {
    let raw = "Parser Error: syntax error at or near \"SELEKT\"";
    assert!(diagnose(&local_target(), None, raw).is_none());
  }

  // ── Ordering: Rule 1 wins over Rule 3 when both could match ──────────────

  #[test]
  fn rule1_takes_priority_over_rule3() {
    let raw = "Permission Error: File system LocalFileSystem has been disabled by configuration";
    let diag = diagnose(&s3_target(), Some("s3://b/f"), raw).unwrap();
    assert!(
      diag.summary.contains("local filesystem"),
      "rule 1 should win: {}",
      diag.summary
    );
  }

  // ── Context threading ────────────────────────────────────────────────────

  #[test]
  fn context_some_appears_in_hint() {
    let raw = "IO Error: No files found that match the pattern 's3://bucket/path/to/file.jsonl'";
    let ctx = "s3://bucket/path/to/file.jsonl";
    let diag = diagnose(&s3_target(), Some(ctx), raw).unwrap();
    assert!(
      diag.hint.contains(ctx),
      "context '{}' should appear in hint: {}",
      ctx,
      diag.hint
    );
  }

  #[test]
  fn context_none_shows_generic_path_desc() {
    // When there is no specific path (e.g. ad-hoc SQL query), the hint must
    // not contain a `<query>` placeholder — it should say "the path" instead.
    let raw = "IO Error: No files found that match the pattern 's3://bucket/missing.jsonl'";
    let diag = diagnose(&s3_target(), None, raw).unwrap();
    assert!(
      !diag.hint.contains("<query>"),
      "hint must not contain <query>: {}",
      diag.hint
    );
    assert!(
      diag.hint.contains("the path"),
      "hint should say 'the path' when context is None: {}",
      diag.hint
    );
  }
}
