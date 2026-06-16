//! Per-connection DuckDB session setup: sandbox settings and S3 credentials.
//!
//! This — not the SQL validator — is the real security boundary. Every query
//! runs on a fresh in-memory connection that executes these statements before
//! the user SQL; `lock_configuration = true` at the end makes the sandbox
//! settings immutable for the rest of the connection's life.

use std::path::Path;

use crate::config::{S3Config, SqlConfig};
use crate::error::AppError;
use crate::sql::SqlTarget;

/// Resolve the DuckDB scratch/spill directory from the optional config value.
/// Falls back to `<system temp>/omni-stream-sql` when not configured.
pub fn resolve_scratch_dir(configured: Option<&str>) -> std::path::PathBuf {
  if let Some(s) = configured {
    return expand_tilde(s);
  }
  std::env::temp_dir().join("omni-stream-sql")
}

fn expand_tilde(s: &str) -> std::path::PathBuf {
  if let Some(rest) = s.strip_prefix('~')
    && (rest.is_empty() || rest.starts_with('/'))
    && let Some(home) = std::env::var_os("HOME")
  {
    let mut p = std::path::PathBuf::from(home);
    let trimmed = rest.strip_prefix('/').unwrap_or(rest);
    if !trimmed.is_empty() {
      p.push(trimmed);
    }
    return p;
  }
  std::path::PathBuf::from(s)
}

/// Build the setup batch executed ahead of the user query. Statement order
/// matters: extension INSTALL/LOAD needs filesystem + network access, so all
/// restrictions come after; `lock_configuration` must be last.
///
/// `scratch_dir` is the host-local directory DuckDB may use for spill-to-disk
/// (large intermediate results, Parquet row-group buffers). It must exist
/// before the connection is opened; `SqlState::from_config` creates it at
/// server startup.
pub fn setup_statements(
  cfg: &SqlConfig,
  target: &SqlTarget,
  scratch_dir: &Path,
) -> Result<String, AppError> {
  let scratch = sql_escape(&scratch_dir.to_string_lossy());
  let mut out = String::new();
  match target {
    SqlTarget::S3(s3) => {
      // httpfs is not statically bundled by duckdb-rs; INSTALL fetches it
      // from the official extension repo on first use (network required
      // once), then it's cached under ~/.duckdb and INSTALL is a no-op.
      out.push_str("INSTALL httpfs;\nLOAD httpfs;\n");
      if s3.access_key.is_none() && s3.secret_key.is_none() {
        // No static credentials → defer to the AWS credential chain (IAM
        // role / env / profile). The credential_chain provider lives in the
        // `aws` extension, fetched the same way as httpfs.
        out.push_str("INSTALL aws;\nLOAD aws;\n");
      }
      out.push_str(&secret_sql(s3)?);
      push_resource_limits(&mut out, cfg);
      // All required extensions are loaded explicitly above, so turn OFF lazy
      // autoload/autoinstall. A lazy load attempted after the sandbox is
      // locked would fail (autoloader reads extension cache from disk, which
      // is restricted). With autoload off, a genuinely missing httpfs surfaces
      // as a clear "requires the extension httpfs to be loaded" error.
      // Must come before the filesystem restrictions.
      out.push_str("SET autoinstall_known_extensions = false;\n");
      out.push_str("SET autoload_known_extensions = false;\n");
      // Give DuckDB a controlled scratch area for spill-to-disk. Large
      // read_json_auto buffers and Parquet writer row groups spill here when
      // they exceed memory_limit. `allowed_directories` limits local FS
      // access to that scratch dir only, so user SQL cannot read or write
      // local files outside it. `enable_external_access` stays on so httpfs
      // can reach S3; network access is still unrestricted on this path —
      // the S3 credentials are scoped to the configured storage's bucket.
      out.push_str(&format!("SET temp_directory = '{scratch}';\n"));
      out.push_str(&format!("SET allowed_directories = ['{scratch}'];\n"));
    }
    SqlTarget::Local { root_path } => {
      push_resource_limits(&mut out, cfg);
      // Scratch is listed alongside the storage root so DuckDB can spill
      // large intermediate results without polluting the storage root or cwd.
      let root = sql_escape(&root_path.to_string_lossy());
      out.push_str(&format!("SET temp_directory = '{scratch}';\n"));
      out.push_str(&format!(
        "SET allowed_directories = ['{root}', '{scratch}'];\n"
      ));
      // Block outbound network (SSRF / data-exfiltration via httpfs).
      out.push_str("SET enable_external_access = false;\n");
    }
  }
  out.push_str("SET lock_configuration = true;\n");
  Ok(out)
}

fn push_resource_limits(out: &mut String, cfg: &SqlConfig) {
  out.push_str(&format!(
    "SET memory_limit = '{}';\n",
    sql_escape(&cfg.memory_limit),
  ));
  out.push_str(&format!("SET threads = {};\n", cfg.threads));
}

/// `CREATE SECRET` for the storage's S3 credentials, mapped from the same
/// `S3Config` the aws-sdk backend uses. When the storage pins a bucket the
/// secret is SCOPEd to it, so queries against other buckets fail with "no
/// credentials" instead of silently using this storage's keys.
fn secret_sql(s3: &S3Config) -> Result<String, AppError> {
  let mut parts: Vec<String> = vec!["TYPE s3".into()];

  match (s3.access_key.as_deref(), s3.secret_key.as_deref()) {
    (Some(key), Some(secret)) => {
      parts.push(format!("KEY_ID '{}'", sql_escape(key)));
      parts.push(format!("SECRET '{}'", sql_escape(secret)));
    }
    (None, None) => parts.push("PROVIDER credential_chain".into()),
    _ => {
      return Err(AppError::Backend(
        "S3 storage has only one of access_key / secret_key set; SQL queries need both or neither"
          .into(),
      ));
    }
  }

  let region = s3.region.as_deref().unwrap_or("us-east-1");
  parts.push(format!("REGION '{}'", sql_escape(region)));

  if let Some(endpoint) = s3.endpoint.as_deref() {
    let use_ssl = !endpoint.starts_with("http://");
    let host = endpoint
      .strip_prefix("https://")
      .or_else(|| endpoint.strip_prefix("http://"))
      .unwrap_or(endpoint)
      .trim_end_matches('/');
    parts.push(format!("ENDPOINT '{}'", sql_escape(host)));
    parts.push(format!("USE_SSL {use_ssl}"));
  }

  parts.push(format!(
    "URL_STYLE '{}'",
    if s3.force_path_style { "path" } else { "vhost" },
  ));

  if let Some(bucket) = s3.fixed_bucket() {
    parts.push(format!("SCOPE 's3://{}'", sql_escape(bucket)));
  }

  Ok(format!(
    "CREATE SECRET omni_query ({});\n",
    parts.join(", ")
  ))
}

/// Escape a value for inclusion in a single-quoted SQL literal.
pub(crate) fn sql_escape(s: &str) -> String {
  s.replace('\'', "''")
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn s3_base() -> S3Config {
    S3Config {
      endpoint: Some("http://localhost:9000".into()),
      bucket: Some("my-bucket".into()),
      access_key: Some("AKID".into()),
      secret_key: Some("SK".into()),
      region: Some("eu-west-1".into()),
      force_path_style: true,
    }
  }

  #[test]
  fn secret_minio_style() {
    let sql = secret_sql(&s3_base()).unwrap();
    assert!(sql.contains("TYPE s3"));
    assert!(sql.contains("KEY_ID 'AKID'"));
    assert!(sql.contains("SECRET 'SK'"));
    assert!(sql.contains("REGION 'eu-west-1'"));
    assert!(sql.contains("ENDPOINT 'localhost:9000'"), "{sql}");
    assert!(sql.contains("USE_SSL false"));
    assert!(sql.contains("URL_STYLE 'path'"));
    assert!(sql.contains("SCOPE 's3://my-bucket'"));
  }

  #[test]
  fn secret_aws_defaults() {
    let cfg = S3Config {
      endpoint: None,
      bucket: None,
      region: None,
      force_path_style: false,
      ..s3_base()
    };
    let sql = secret_sql(&cfg).unwrap();
    assert!(sql.contains("REGION 'us-east-1'"));
    assert!(!sql.contains("ENDPOINT"), "no endpoint for real AWS: {sql}");
    assert!(!sql.contains("USE_SSL"));
    assert!(sql.contains("URL_STYLE 'vhost'"));
    assert!(!sql.contains("SCOPE"), "multi-bucket → unscoped: {sql}");
  }

  #[test]
  fn secret_https_endpoint_keeps_ssl() {
    let cfg = S3Config {
      endpoint: Some("https://s3.example.com/".into()),
      ..s3_base()
    };
    let sql = secret_sql(&cfg).unwrap();
    assert!(sql.contains("ENDPOINT 's3.example.com'"), "{sql}");
    assert!(sql.contains("USE_SSL true"));
  }

  #[test]
  fn secret_credential_chain_when_no_static_keys() {
    let cfg = S3Config {
      access_key: None,
      secret_key: None,
      ..s3_base()
    };
    let sql = secret_sql(&cfg).unwrap();
    assert!(sql.contains("PROVIDER credential_chain"), "{sql}");
    assert!(!sql.contains("KEY_ID"));
  }

  #[test]
  fn secret_partial_credentials_rejected() {
    let cfg = S3Config {
      secret_key: None,
      ..s3_base()
    };
    assert!(secret_sql(&cfg).is_err());
  }

  #[test]
  fn secret_escapes_single_quotes() {
    let cfg = S3Config {
      secret_key: Some("se'cret".into()),
      ..s3_base()
    };
    let sql = secret_sql(&cfg).unwrap();
    assert!(sql.contains("SECRET 'se''cret'"), "{sql}");
  }

  fn scratch() -> PathBuf {
    PathBuf::from("/tmp/omni-test-scratch")
  }

  #[test]
  fn s3_setup_order() {
    let cfg = SqlConfig::default();
    let target = SqlTarget::S3(s3_base());
    let sql = setup_statements(&cfg, &target, &scratch()).unwrap();
    let pos = |needle: &str| {
      sql
        .find(needle)
        .unwrap_or_else(|| panic!("missing {needle}: {sql}"))
    };
    assert!(pos("INSTALL httpfs") < pos("LOAD httpfs"));
    assert!(pos("LOAD httpfs") < pos("CREATE SECRET"));
    assert!(pos("CREATE SECRET") < pos("temp_directory"));
    assert!(pos("temp_directory") < pos("allowed_directories"));
    assert!(pos("allowed_directories") < pos("lock_configuration"));
    assert!(sql.contains("SET memory_limit = '512MB'"));
    assert!(sql.contains("SET threads = 2"));
    assert!(!sql.contains("INSTALL aws"), "static creds need no aws ext");
    assert!(
      !sql.contains("disabled_filesystems"),
      "replaced by allowed_directories: {sql}"
    );
    // Lazy extension autoload is disabled after the explicit loads and before
    // the sandbox restrictions, so an s3:// reference never triggers an
    // autoload that would fail inside the restricted environment.
    assert!(sql.contains("SET autoinstall_known_extensions = false"));
    assert!(sql.contains("SET autoload_known_extensions = false"));
    assert!(pos("LOAD httpfs") < pos("autoload_known_extensions"));
    assert!(pos("autoload_known_extensions") < pos("temp_directory"));
    // Scratch dir must appear in both temp_directory and allowed_directories.
    assert!(sql.contains("'/tmp/omni-test-scratch'"), "{sql}");
  }

  #[test]
  fn s3_setup_installs_aws_for_credential_chain() {
    let cfg = SqlConfig::default();
    let target = SqlTarget::S3(S3Config {
      access_key: None,
      secret_key: None,
      ..s3_base()
    });
    let sql = setup_statements(&cfg, &target, &scratch()).unwrap();
    assert!(sql.contains("INSTALL aws"), "{sql}");
  }

  #[test]
  fn local_setup_sandbox() {
    let cfg = SqlConfig::default();
    let target = SqlTarget::Local {
      root_path: PathBuf::from("/var/data"),
    };
    let sql = setup_statements(&cfg, &target, &scratch()).unwrap();
    let pos = |needle: &str| {
      sql
        .find(needle)
        .unwrap_or_else(|| panic!("missing {needle}: {sql}"))
    };
    // Both the storage root and the scratch dir must be in allowed_directories.
    assert!(
      sql.contains("SET allowed_directories = ['/var/data', '/tmp/omni-test-scratch']"),
      "{sql}"
    );
    assert!(pos("temp_directory") < pos("allowed_directories"));
    assert!(pos("allowed_directories") < pos("enable_external_access"));
    assert!(pos("enable_external_access") < pos("lock_configuration"));
    assert!(!sql.contains("httpfs"), "local target loads no extensions");
  }
}
