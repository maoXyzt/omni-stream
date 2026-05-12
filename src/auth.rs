use std::sync::Arc;

use anyhow::anyhow;
use axum::Json;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::config::AuthConfig;

/// Resolved auth gate. `enabled = false` means the middleware is a no-op;
/// when enabled, `token` is the only accepted Bearer credential.
/// Wrapped in Arc so cloning the layer state is cheap.
#[derive(Clone)]
pub struct AuthState {
  pub enabled: bool,
  token: Arc<String>,
}

impl AuthState {
  pub fn from_config(cfg: &AuthConfig) -> anyhow::Result<Self> {
    if !cfg.enabled {
      return Ok(Self {
        enabled: false,
        token: Arc::new(String::new()),
      });
    }
    let token = cfg
      .token
      .as_deref()
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .ok_or_else(|| anyhow!("auth.enabled=true but auth.token is missing or empty"))?
      .to_string();
    Ok(Self {
      enabled: true,
      token: Arc::new(token),
    })
  }
}

pub async fn auth_middleware(State(auth): State<AuthState>, req: Request, next: Next) -> Response {
  if !auth.enabled {
    return next.run(req).await;
  }

  let presented = req
    .headers()
    .get(header::AUTHORIZATION)
    .and_then(|v| v.to_str().ok())
    .and_then(|v| v.strip_prefix("Bearer "))
    .map(str::trim)
    .unwrap_or("");

  if !presented.is_empty() && constant_time_eq(presented.as_bytes(), auth.token.as_bytes()) {
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
  fn from_config_disabled_ignores_token() {
    let cfg = AuthConfig {
      enabled: false,
      token: None,
    };
    let s = AuthState::from_config(&cfg).unwrap();
    assert!(!s.enabled);
  }

  #[test]
  fn from_config_enabled_requires_token() {
    let cfg = AuthConfig {
      enabled: true,
      token: None,
    };
    assert!(AuthState::from_config(&cfg).is_err());

    let cfg = AuthConfig {
      enabled: true,
      token: Some("   ".into()),
    };
    assert!(AuthState::from_config(&cfg).is_err());
  }

  #[test]
  fn from_config_enabled_trims_token() {
    let cfg = AuthConfig {
      enabled: true,
      token: Some("  secret  ".into()),
    };
    let s = AuthState::from_config(&cfg).unwrap();
    assert!(s.enabled);
    assert_eq!(s.token.as_str(), "secret");
  }

  #[test]
  fn constant_time_eq_basic() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"abcd"));
    assert!(constant_time_eq(b"", b""));
  }
}
