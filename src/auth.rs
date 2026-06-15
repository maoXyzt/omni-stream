use std::sync::Arc;

use anyhow::anyhow;
use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::config::AuthConfig;

/// Per-route-group bearer-token gate. The same shared `token` is applied with
/// a different `required` flag to each group: the read group requires it only
/// when `auth.public_read = false`, the write group requires it whenever the
/// gate is on. `required = false` makes the middleware a pure pass-through.
/// Cloned once per request by axum, so the `Arc` keeps that cheap.
#[derive(Clone)]
pub struct AuthLayer {
  required: bool,
  token: Arc<String>,
}

impl AuthLayer {
  /// Build the shared token once, then derive the read/write layers from it
  /// with [`AuthLayer::read`] / [`AuthLayer::write`]. Errors when the gate is
  /// on but no usable token is configured — `config.validate()` already
  /// guards this, so reaching the error here means a programming mistake.
  pub fn token_from_config(cfg: &AuthConfig) -> anyhow::Result<Arc<String>> {
    if !cfg.enabled {
      return Ok(Arc::new(String::new()));
    }
    let token = cfg
      .token
      .as_deref()
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .ok_or_else(|| anyhow!("auth.enabled=true but auth.token is missing or empty"))?
      .to_string();
    Ok(Arc::new(token))
  }

  /// Gate for read/browse routes: enforced only on a full lockdown
  /// (`enabled && !public_read`).
  pub fn read(cfg: &AuthConfig, token: Arc<String>) -> Self {
    Self {
      required: cfg.enabled && !cfg.public_read,
      token,
    }
  }

  /// Gate for write/privileged routes: enforced whenever the gate is on.
  /// Used by the file write group (`PUT/DELETE /api/files`, `POST /api/move`)
  /// in every build, and by the duckdb-gated `/api/convert` group.
  pub fn write(cfg: &AuthConfig, token: Arc<String>) -> Self {
    Self {
      required: cfg.enabled,
      token,
    }
  }
}

/// Whether `headers` carry an `Authorization: Bearer <token>` matching
/// `token` in constant time. Used by the route middleware.
pub fn bearer_matches(headers: &HeaderMap, token: &str) -> bool {
  let presented = headers
    .get(header::AUTHORIZATION)
    .and_then(|v| v.to_str().ok())
    .and_then(|v| v.strip_prefix("Bearer "))
    .map(str::trim)
    .unwrap_or("");
  !presented.is_empty() && constant_time_eq(presented.as_bytes(), token.as_bytes())
}

pub async fn auth_middleware(State(auth): State<AuthLayer>, req: Request, next: Next) -> Response {
  if !auth.required {
    return next.run(req).await;
  }

  if bearer_matches(req.headers(), &auth.token) {
    return next.run(req).await;
  }

  let mut resp = (
    StatusCode::UNAUTHORIZED,
    Json(json!({
        "error": "Unauthorized",
        "message": "missing or invalid bearer token",
    })),
  )
    .into_response();
  resp.headers_mut().insert(
    header::WWW_AUTHENTICATE,
    "Bearer realm=\"omni-stream\"".parse().unwrap(),
  );
  resp
}

/// Length-aware, branch-free byte comparison. Returns false fast on length
/// mismatch (token length isn't sensitive); on equal length, accumulates
/// XOR diff across every byte so the runtime doesn't depend on which byte
/// differs first.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
  if a.len() != b.len() {
    return false;
  }
  let mut diff: u8 = 0;
  for (x, y) in a.iter().zip(b.iter()) {
    diff |= x ^ y;
  }
  diff == 0
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn disabled_makes_both_layers_pass_through() {
    let cfg = AuthConfig {
      enabled: false,
      token: None,
      public_read: true,
    };
    let token = AuthLayer::token_from_config(&cfg).unwrap();
    assert!(!AuthLayer::read(&cfg, token.clone()).required);
    assert!(!AuthLayer::write(&cfg, token).required);
  }

  #[test]
  fn enabled_public_read_gates_writes_only() {
    let cfg = AuthConfig {
      enabled: true,
      token: Some("secret".into()),
      public_read: true,
    };
    let token = AuthLayer::token_from_config(&cfg).unwrap();
    // Reads stay open, writes are gated.
    assert!(!AuthLayer::read(&cfg, token.clone()).required);
    assert!(AuthLayer::write(&cfg, token).required);
  }

  #[test]
  fn enabled_private_gates_reads_and_writes() {
    let cfg = AuthConfig {
      enabled: true,
      token: Some("secret".into()),
      public_read: false,
    };
    let token = AuthLayer::token_from_config(&cfg).unwrap();
    assert!(AuthLayer::read(&cfg, token.clone()).required);
    assert!(AuthLayer::write(&cfg, token).required);
  }

  #[test]
  fn token_from_config_requires_non_empty_when_enabled() {
    for bad in [None, Some("   ".to_string())] {
      let cfg = AuthConfig {
        enabled: true,
        token: bad,
        public_read: true,
      };
      assert!(AuthLayer::token_from_config(&cfg).is_err());
    }
  }

  #[test]
  fn token_from_config_trims() {
    let cfg = AuthConfig {
      enabled: true,
      token: Some("  secret  ".into()),
      public_read: true,
    };
    let token = AuthLayer::token_from_config(&cfg).unwrap();
    assert_eq!(token.as_str(), "secret");
  }

  #[test]
  fn constant_time_eq_basic() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"abcd"));
    assert!(constant_time_eq(b"", b""));
  }
}
