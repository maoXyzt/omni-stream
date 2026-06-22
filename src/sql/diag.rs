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

  // Rule 1 — Out of Memory.
  // Placed first because OOM errors from read_json_auto / read_csv_auto can
  // contain those function names and would otherwise be mis-classified as a
  // parse error (Rule 7) instead of a memory error.  The OOM keywords are
  // unambiguous and should always win.
  // "failed to allocate data" is the DuckDB-specific fragment from the OOM
  // message ("failed to allocate data of size X MiB (Y/Z used)").  The more
  // general "failed to allocate" is deliberately NOT matched to avoid
  // false-positives on unrelated allocation messages (e.g. extension loading).
  // "out of memory" covers the full message prefix and any variant that does
  // not contain the word "data".
  if lower.contains("out of memory") || lower.contains("failed to allocate data") {
    return Some(Diagnosis {
      summary: "DuckDB ran out of memory.".into(),
      hint: format!(
        "The operation on {path_desc} exceeded the server's DuckDB memory budget \
         (`[sql].memory_limit`, default 512MB). Try raising `[sql].memory_limit` \
         (e.g. '2GB') if the host has the RAM. For interactive queries, lowering \
         `[sql].threads` reduces peak scan memory by limiting concurrent DuckDB \
         workers. For large-file conversions, lowering `[sql].convert_threads` \
         also reduces peak memory by limiting the number of non-spillable Parquet \
         write buffers held concurrently."
      ),
    });
  }

  // Rule 2 — an S3 operation needed the local filesystem, which is disabled in
  // S3 mode. The s3:// path itself is fine; the local-FS access is incidental:
  // typically DuckDB's httpfs extension was not active for this connection, so
  // it could not route the s3:// URI and fell back to the (disabled) local
  // filesystem. Note: with extension autoload disabled during session setup
  // (see session::setup_statements), a missing httpfs now surfaces as a clearer
  // "requires the extension httpfs" error caught by Rule 5 — so this rule
  // mainly guards residual cases and keeps the message non-misleading.
  if lower.contains("localfilesystem") && lower.contains("disabled") {
    let hint = if is_s3 {
      format!(
        "The operation on {path_desc} required access to the server's local filesystem, which is \
         disabled in S3 mode. The path is already an s3:// URI, so this is not a wrong-path \
         problem — it usually means the httpfs extension was not active for this connection. \
         Check that: (1) httpfs is installed and loads successfully — on first use it is fetched \
         from the DuckDB extension repository, which needs outbound network access (pre-install \
         it on the host if the server is offline); (2) the S3 endpoint, region, and credentials \
         are configured so DuckDB can route the request through httpfs.",
      )
    } else {
      format!(
        "Unexpected: a local target hit the S3 filesystem sandbox path for {path_desc}. \
         This may be a configuration bug — please report it.",
      )
    };
    return Some(Diagnosis {
      summary: "An S3 operation needed the local filesystem, which is disabled.".into(),
      hint,
    });
  }

  // Rule 3 — S3 authentication / permission failures.
  // Use specific HTTP-error strings to avoid matching on SQL that merely
  // contains the number 403 (e.g. `WHERE id = 403`).
  if lower.contains("signaturedoesnotmatch")
    || lower.contains("invalidaccesskeyid")
    || lower.contains("access denied")
    || lower.contains("accessdenied")
    || lower.contains("http error: 403")
    || lower.contains("http 403")
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

  // Rule 4 — Generic permission error (not matched by Rule 3).
  // Match "permission denied" / "permission error" only — bare "permission"
  // would fire on SQL errors referencing a column or table called "permission".
  if lower.contains("permission denied") || lower.contains("permission error") {
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

  // Rule 5 — httpfs / aws extension could not be loaded (S3 targets only).
  // Local targets do not load httpfs, so this pattern would be a false positive
  // for them; skip with is_s3 guard.
  // "unable to connect" alone is too broad — it also fires on S3 endpoint
  // connection failures.  Require a co-occurring extension/httpfs token.
  let is_extension_failure = is_s3
    && (lower.contains("failed to download extension")
      || (lower.contains("install") && lower.contains("httpfs"))
      || (lower.contains("extension") && (lower.contains("network") || lower.contains("http")))
      || (lower.contains("unable to connect")
        && (lower.contains("extension")
          || lower.contains("httpfs")
          || lower.contains("duckdb.org"))));
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

  // Rule 6 — Source file could not be read.
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

  // Rule 7 — JSON / CSV parse error (most relevant for the convert endpoint).
  // Only fire when a file-reader function name appears in the error — bare
  // "invalid input syntax" and "malformed" are too broad: they also match
  // SQL type-cast errors ("invalid input syntax for type INTEGER") and S3
  // configuration errors ("Malformed URL", "malformed endpoint").
  let is_parse_error =
    lower.contains("read_json") || lower.contains("read_csv") || lower.contains("json parse error");
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

  // ── Rule 1: Out of Memory ────────────────────────────────────────────────

  #[test]
  fn rule1_oom_out_of_memory() {
    let raw =
      "Out of Memory Error: failed to allocate data of size 116.6 MiB (463.8 MiB/488.2 MiB used)";
    let diag = diagnose(&s3_target(), Some("s3://bucket/data.parquet"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("memory"),
      "summary should mention memory: {}",
      diag.summary
    );
    assert!(
      diag.hint.contains("memory_limit"),
      "hint should reference memory_limit: {}",
      diag.hint
    );
    assert!(
      diag.hint.contains("[sql].threads"),
      "query OOM hint should mention lowering query threads: {}",
      diag.hint
    );
  }

  #[test]
  fn rule1_oom_with_read_json_still_classified_as_oom() {
    // OOM from read_json_auto may contain the function name and would otherwise
    // be mis-classified by Rule 7 (parse error).  Rule 1 must win.
    let raw = "Out of Memory Error: failed to allocate (read_json_auto internal buffer)";
    let diag = diagnose(&local_target(), Some("/data/big.jsonl"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("memory"),
      "OOM with read_json text must classify as OOM, not parse error: {}",
      diag.summary
    );
  }

  #[test]
  fn rule1_oom_query_path_no_context() {
    // sql/mod.rs calls diagnose(target, None, &raw) — no URI context.
    // The OOM rule must still fire and the hint must use the generic path_desc.
    let raw =
      "Out of Memory Error: failed to allocate data of size 512.0 MiB (510.0 MiB/512.0 MiB used)";
    let diag = diagnose(&local_target(), None, raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("memory"),
      "query-path OOM (context=None) must classify as OOM: {}",
      diag.summary
    );
    assert!(
      diag.hint.contains("memory_limit"),
      "hint should reference memory_limit: {}",
      diag.hint
    );
    // Generic path_desc ("the path") must appear when context is None.
    assert!(
      diag.hint.contains("the path"),
      "hint must use generic path_desc when context is None: {}",
      diag.hint
    );
  }

  #[test]
  fn rule1_failed_to_allocate_without_data_not_matched() {
    // "failed to allocate" alone (without "out of memory" or the DuckDB-specific
    // "failed to allocate data" fragment) must NOT trigger Rule 1 to avoid
    // false-positives on unrelated allocation messages.
    // Note: the string must not contain words that trigger other rules
    // (e.g. "extension"+"http" triggers Rule 5 on s3 targets).
    let raw = "System error: failed to allocate buffer pool slot";
    assert!(
      diagnose(&local_target(), None, raw).is_none(),
      "bare 'failed to allocate' without OOM context must return None"
    );
  }

  // ── Rule 2: LocalFileSystem disabled ─────────────────────────────────────

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
    // Must NOT second-guess the path: the user already has an s3:// URI, so the
    // old "(not a local path)" phrasing was misleading.
    assert!(
      !diag.hint.to_lowercase().contains("not a local path"),
      "hint must not second-guess the s3:// path: {}",
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

  // ── Rule 3: auth / permission ─────────────────────────────────────────────

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

  // ── Rule 4: generic permission ────────────────────────────────────────────

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

  // ── Rule 5: extension load failure (S3 only) ──────────────────────────────

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

  #[test]
  fn rule4_missing_extension_after_autoload_disabled() {
    // With extension autoload disabled in session setup, a not-loaded httpfs
    // surfaces as this "Missing Extension" error instead of the misleading
    // "LocalFileSystem disabled" (Rule 2). It must classify as an extension
    // problem (Rule 5), not the local-filesystem fallback (Rule 2).
    let raw = "Missing Extension Error: File s3://infographics/x.parquet requires the \
               extension httpfs to be loaded\nPlease try installing and loading the httpfs \
               extension by running:\nINSTALL httpfs;\nLOAD httpfs;";
    let diag = diagnose(&s3_target(), Some("s3://infographics/x.parquet"), raw).unwrap();
    assert!(
      diag.summary.to_lowercase().contains("extension"),
      "summary should flag the extension problem: {}",
      diag.summary
    );
    assert!(
      !diag.summary.to_lowercase().contains("local filesystem"),
      "should be Rule 5, not Rule 2: {}",
      diag.summary
    );
  }

  // ── Rule 6: source file not found ────────────────────────────────────────

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

  // ── Rule 7: parse error ───────────────────────────────────────────────────

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

  // ── Rule 8 (fallback): unknown error returns None ────────────────────────

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

  // ── Ordering: Rule 2 wins over Rule 4 when both could match ──────────────

  #[test]
  fn rule1_takes_priority_over_rule3() {
    let raw = "Permission Error: File system LocalFileSystem has been disabled by configuration";
    let diag = diagnose(&s3_target(), Some("s3://b/f"), raw).unwrap();
    assert!(
      diag.summary.contains("local filesystem"),
      "rule 2 should win over rule 4: {}",
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

  // ── Rule narrowing: no false positives ───────────────────────────────────

  #[test]
  fn rule2_bare_number_403_in_sql_not_matched() {
    // A SQL binder/syntax error that happens to contain "403" should not be
    // classified as an S3 auth failure.
    let raw = "Binder Error: WHERE id = 403 — column 'id' not found";
    assert!(
      diagnose(&s3_target(), None, raw).is_none(),
      "bare '403' in SQL error should not trigger Rule 3"
    );
  }

  #[test]
  fn rule3_column_named_permission_not_matched() {
    // A SQL binder error referencing a column called "permission" must not be
    // misclassified as a filesystem permission error.
    let raw = "Binder Error: Referenced column 'permission' not found in FROM clause";
    assert!(
      diagnose(&s3_target(), None, raw).is_none(),
      "binder error with 'permission' column name should return None"
    );
  }

  #[test]
  fn rule4_s3_generic_endpoint_connection_failure_not_matched() {
    // "unable to connect" without extension/httpfs context should not fire
    // Rule 5 — it is a plain S3 endpoint connectivity issue, not an extension
    // loading failure.
    let raw = "IOException: unable to connect to 'https://my-s3.internal:9000'";
    assert!(
      diagnose(&s3_target(), Some("s3://bucket/file"), raw).is_none(),
      "generic S3 connection failure should not be classified as extension load failure (Rule 5)"
    );
  }

  #[test]
  fn rule6_malformed_s3_url_not_matched() {
    // "malformed" without a file-reader token (read_json/read_csv) must not
    // be classified as a JSON/CSV parse error — it is an S3 config issue.
    let raw = "Invalid Input Error: Malformed S3 URL: missing bucket name";
    assert!(
      diagnose(&s3_target(), None, raw).is_none(),
      "Malformed S3 URL without reader context should return None"
    );
  }
}
