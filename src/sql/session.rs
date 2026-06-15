//! Per-connection DuckDB session setup: sandbox settings and S3 credentials.
//!
//! This — not the SQL validator — is the real security boundary. Every query
//! runs on a fresh in-memory connection that executes these statements before
//! the user SQL; `lock_configuration = true` at the end makes the sandbox
//! settings immutable for the rest of the connection's life.

use crate::config::{S3Config, SqlConfig};
use crate::error::AppError;
use crate::sql::SqlTarget;

/// Build the setup batch executed ahead of the user query. Statement order
/// matters: extension INSTALL/LOAD needs filesystem + network access, so all
/// restrictions come after; `lock_configuration` must be last.
pub fn setup_statements(cfg: &SqlConfig, target: &SqlTarget) -> Result<String, AppError> {
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
      // autoload/autoinstall. Once `disabled_filesystems` blocks LocalFileSystem
      // (next line), DuckDB's autoloader can no longer read its on-disk
      // extension cache; a lazy load triggered by first touching an s3:// URI
      // then fails with the misleading "File system LocalFileSystem has been
      // disabled by configuration". With autoload off, a genuinely missing
      // httpfs instead surfaces as a clear "requires the extension httpfs to be
      // loaded" error. Must come before `disabled_filesystems`.
      out.push_str("SET autoinstall_known_extensions = false;\n");
      out.push_str("SET autoload_known_extensions = false;\n");
      // Keep remote access (httpfs) but cut off the server's local disk.
      // `enable_external_access = false` would kill httpfs too, hence this
      // narrower setting.
      out.push_str("SET disabled_filesystems = 'LocalFileSystem';\n");
    }
    SqlTarget::Local { root_path } => {
      push_resource_limits(&mut out, cfg);
      // Reads AND writes (COPY ... TO) are confined to the storage root.
      out.push_str(&format!(
        "SET allowed_directories = ['{}'];\n",
        sql_escape(&root_path.to_string_lossy()),
      ));
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

  #[test]
  fn s3_setup_order() {
    let cfg = SqlConfig::default();
    let target = SqlTarget::S3(s3_base());
    let sql = setup_statements(&cfg, &target).unwrap();
    let pos = |needle: &str| {
      sql
        .find(needle)
        .unwrap_or_else(|| panic!("missing {needle}: {sql}"))
    };
    assert!(pos("INSTALL httpfs") < pos("LOAD httpfs"));
    assert!(pos("LOAD httpfs") < pos("CREATE SECRET"));
    assert!(pos("CREATE SECRET") < pos("disabled_filesystems"));
    assert!(pos("disabled_filesystems") < pos("lock_configuration"));
    assert!(sql.contains("SET memory_limit = '512MB'"));
    assert!(sql.contains("SET threads = 2"));
    assert!(!sql.contains("INSTALL aws"), "static creds need no aws ext");
    // Lazy extension autoload is disabled after the explicit loads and before
    // the filesystem lockdown, so an s3:// reference never triggers an autoload
    // that would hit the now-disabled LocalFileSystem.
    assert!(sql.contains("SET autoinstall_known_extensions = false"));
    assert!(sql.contains("SET autoload_known_extensions = false"));
    assert!(pos("LOAD httpfs") < pos("autoload_known_extensions"));
    assert!(pos("autoload_known_extensions") < pos("disabled_filesystems"));
  }

  #[test]
  fn s3_setup_installs_aws_for_credential_chain() {
    let cfg = SqlConfig::default();
    let target = SqlTarget::S3(S3Config {
      access_key: None,
      secret_key: None,
      ..s3_base()
    });
    let sql = setup_statements(&cfg, &target).unwrap();
    assert!(sql.contains("INSTALL aws"), "{sql}");
  }

  #[test]
  fn local_setup_sandbox() {
    let cfg = SqlConfig::default();
    let target = SqlTarget::Local {
      root_path: PathBuf::from("/var/data"),
    };
    let sql = setup_statements(&cfg, &target).unwrap();
    let pos = |needle: &str| {
      sql
        .find(needle)
        .unwrap_or_else(|| panic!("missing {needle}: {sql}"))
    };
    assert!(sql.contains("SET allowed_directories = ['/var/data']"));
    assert!(pos("allowed_directories") < pos("enable_external_access"));
    assert!(pos("enable_external_access") < pos("lock_configuration"));
    assert!(!sql.contains("httpfs"), "local target loads no extensions");
  }
}
