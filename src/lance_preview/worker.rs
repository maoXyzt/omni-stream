//! Run an infallible SDK allocator in a disposable process so rejecting one
//! allocation can abort this request without bringing down the HTTP server.
use super::{DISPLAY_BYTES, PageQuery, budget, page_response};
use crate::{config::StorageConfig, error::AppError, storage::factory::build_one};
use axum::{
  http::{StatusCode, header},
  response::{IntoResponse, Response},
};
use std::{io::Write, process::Stdio};
use tokio::{
  io::{AsyncReadExt, AsyncWriteExt},
  process::Command,
};

fn protocol_error() -> AppError {
  AppError::Backend("invalid Lance preview worker response".into())
}

pub(super) async fn request(
  storage: &StorageConfig,
  key: &str,
  query: &PageQuery,
) -> Result<Response, AppError> {
  // A private pipe keeps storage credentials out of argv, logs and temporary files.
  let input = serde_json::to_vec(&(storage, key, query))
    .map_err(|_| AppError::Backend("cannot encode Lance preview request".into()))?;
  let mut child = Command::new(std::env::current_exe()?)
    .arg("lance-preview-worker")
    .env("TOKIO_WORKER_THREADS", "2")
    .env("LANCE_CPU_THREADS", "2")
    .env("LANCE_IO_THREADS", "2")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .kill_on_drop(true)
    .spawn()?;
  let mut stdin = child.stdin.take().ok_or_else(protocol_error)?;
  stdin.write_all(&input).await?;
  drop(stdin);
  let stdout = child.stdout.take().ok_or_else(protocol_error)?;
  let mut output = Vec::new();
  stdout
    .take(DISPLAY_BYTES as u64 + 3)
    .read_to_end(&mut output)
    .await?;
  if output.len() > DISPLAY_BYTES + 2 {
    return Err(protocol_error());
  }
  let status = child.wait().await?;
  if status.code() == Some(budget::EXCEEDED) {
    return Err(AppError::LancePageTooLarge(
      "Reading this preview exceeds the 4 MiB decode budget.",
    ));
  }
  if !status.success() {
    return Err(AppError::Backend(format!(
      "Lance preview worker exited with {status}"
    )));
  }
  let mut body = bytes::Bytes::from(output);
  if body.len() < 2 {
    return Err(protocol_error());
  }
  let status =
    StatusCode::from_u16(u16::from_be_bytes([body[0], body[1]])).map_err(|_| protocol_error())?;
  Ok(
    (
      status,
      [(header::CONTENT_TYPE, "application/json")],
      body.split_off(2),
    )
      .into_response(),
  )
}

pub(crate) async fn run_worker() -> anyhow::Result<()> {
  let (storage, key, query): (StorageConfig, String, PageQuery) =
    tokio::task::spawn_blocking(|| serde_json::from_reader(std::io::stdin().lock()))
      .await?
      .map_err(|_| anyhow::anyhow!("invalid Lance preview request"))?;
  let backend = build_one(&storage).await?;
  budget::enable();
  let response = page_response(backend, &key, query)
    .await
    .unwrap_or_else(IntoResponse::into_response);
  let status = response.status();
  let body = axum::body::to_bytes(response.into_body(), DISPLAY_BYTES).await?;
  tokio::task::spawn_blocking(move || {
    let mut writer = std::io::stdout().lock();
    writer.write_all(&status.as_u16().to_be_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
  })
  .await??;
  Ok(())
}
