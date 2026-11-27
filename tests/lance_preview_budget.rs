#![cfg(feature = "lance")]

use arrow_array::{RecordBatch, RecordBatchIterator, StringArray};
use arrow_schema::{DataType, Field, Schema};
use lance::{Dataset, dataset::WriteParams};
use lance_file::version::LanceFileVersion;
use serde_json::json;
use std::{collections::HashMap, path::Path, process::Stdio, sync::Arc};
use tokio::{io::AsyncWriteExt, process::Command};

async fn preview(root: &Path, key: &str, physical: bool) -> std::process::Output {
  let mut child = Command::new(env!("CARGO_BIN_EXE_omni-stream"))
    .arg("lance-preview-worker")
    .env("TOKIO_WORKER_THREADS", "2")
    .env("LANCE_CPU_THREADS", "2")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .unwrap();
  let request = json!([
    {"name":"test","type":"local","local":{"root_path":root}},
    key,
    {"physical":physical,"limit":1}
  ]);
  let mut input = child.stdin.take().unwrap();
  input
    .write_all(request.to_string().as_bytes())
    .await
    .unwrap();
  drop(input);
  child.wait_with_output().await.unwrap()
}

#[tokio::test]
async fn compressed_rows_are_rejected_during_decode_in_both_readers() {
  let root = tempfile::tempdir().unwrap();
  for (name, bytes, columns) in [
    ("small", 48, 1),
    ("single", 5 << 20, 1),
    ("combined", 3 << 20, 2),
  ] {
    let schema = Arc::new(Schema::new(
      (0..columns)
        .map(|i| {
          Field::new(format!("text{i}"), DataType::Utf8, false).with_metadata(HashMap::from([(
            "lance-encoding:compression".to_owned(),
            "zstd".to_owned(),
          )]))
        })
        .collect::<Vec<_>>(),
    ));
    let text = "a".repeat(bytes);
    let batch = RecordBatch::try_new(
      schema.clone(),
      (0..columns)
        .map(|_| Arc::new(StringArray::from(vec![text.as_str()])) as _)
        .collect(),
    )
    .unwrap();
    let reader = RecordBatchIterator::new([Ok(batch)], schema);
    let key = format!("{name}.lance");
    let dataset = Dataset::write(
      reader,
      root.path().join(&key).to_str().unwrap(),
      Some(WriteParams {
        data_storage_version: Some(LanceFileVersion::V2_1),
        ..Default::default()
      }),
    )
    .await
    .unwrap();
    let file = format!(
      "{key}/data/{}",
      dataset.get_fragments()[0].metadata().files[0].path
    );
    assert!(std::fs::metadata(root.path().join(&file)).unwrap().len() < 64 << 10);
    for (key, physical) in [(&key, false), (&file, true)] {
      let output = preview(root.path(), key, physical).await;
      if bytes > 48 {
        // The allocation guard exits before returning a decoded batch. The
        // later Arrow/JSON display checks would instead send a framed HTTP 413.
        assert_eq!(output.status.code(), Some(75));
        assert!(output.stdout.is_empty());
      } else {
        assert!(output.status.success());
        assert_eq!(&output.stdout[..2], &200_u16.to_be_bytes());
        let page: serde_json::Value = serde_json::from_slice(&output.stdout[2..]).unwrap();
        assert_eq!(page["rows"][0]["text0"], text);
      }
    }
  }
}
