mod budget;
mod worker;
pub(crate) use worker::run_worker;
mod decimal;
mod store;

use crate::{error::AppError, handlers::AppState, storage::StorageBackend};
use arrow_schema::DataType;
use axum::{
  extract::{Path, Query, State},
  http::header,
  response::{IntoResponse, Response},
};
use futures::{StreamExt, TryStreamExt, stream};
use lance::{dataset::builder::DatasetBuilder, session::Session};
use lance_file::reader::{FileReader, FileReaderOptions};
use lance_io::{
  ReadBatchParams,
  object_store::{ObjectStoreProvider, ObjectStoreRegistry},
  scheduler::{ScanScheduler, SchedulerConfig},
  utils::CachedFileSize,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
  error::Error as _,
  io::{self, Write},
  sync::Arc,
};
use tokio::sync::Semaphore;

static READERS: Semaphore = Semaphore::const_new(4);
const PAGE_ROWS: usize = 20;
const DISPLAY_BYTES: usize = 4 << 20;
const DISPLAY_LIMIT: &str = "The preview exceeds the 4 MiB display limit.";

// Arrow string escaping and vector formatting can expand a small binary
// batch considerably. Enforce the byte cap while constructing either JSON
// representation, including the schema.
#[derive(Default)]
struct PageBuffer(Vec<u8>);

impl Write for PageBuffer {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    if buf.len() > DISPLAY_BYTES - self.0.len() {
      return Err(io::Error::new(
        io::ErrorKind::FileTooLarge,
        "Lance page exceeds the display budget",
      ));
    }
    self.0.extend_from_slice(buf);
    Ok(buf.len())
  }
  fn flush(&mut self) -> io::Result<()> {
    Ok(())
  }
}

#[derive(Serialize)]
struct DatasetPage {
  #[serde(skip_serializing_if = "Option::is_none")]
  version: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  file_format: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  fragments: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  file_size: Option<u64>,
  total: usize,
  offset: usize,
  columns: Vec<Column>,
  rows: Vec<Value>,
}

#[derive(Serialize)]
struct Column {
  name: String,
  #[serde(rename = "type")]
  data_type: String,
  omitted: bool,
  nullable: bool,
}

#[derive(Deserialize, Serialize)]
pub struct PageQuery {
  #[serde(default)]
  physical: bool,
  #[serde(default)]
  schema_only: bool,
  storage: Option<String>,
  #[serde(default)]
  offset: usize,
  limit: Option<usize>,
  version: Option<u64>,
}

#[tracing::instrument(skip_all, fields(dataset = %key, offset = query.offset))]
pub async fn handler(
  State(state): State<AppState>,
  Path(key): Path<String>,
  Query(query): Query<PageQuery>,
) -> Result<Response, AppError> {
  let entry = state.resolve_entry(query.storage.as_deref())?;
  let _permit = READERS
    .acquire()
    .await
    .map_err(|_| AppError::Busy("Lance previews are busy".into()))?;
  if query.schema_only {
    page_response(entry.backend.clone(), &key, query).await
  } else {
    worker::request(&entry.config, &key, &query).await
  }
}

async fn page_response(
  backend: Arc<dyn StorageBackend>,
  key: &str,
  query: PageQuery,
) -> Result<Response, AppError> {
  let page = page(backend, key, query).await?;
  let mut output = PageBuffer::default();
  budget::format_output(|| serde_json::to_writer(&mut output, &page)).map_err(|e| {
    if e.io_error_kind() == Some(io::ErrorKind::FileTooLarge) {
      AppError::LancePageTooLarge(DISPLAY_LIMIT)
    } else {
      AppError::Unsupported(e.to_string())
    }
  })?;
  Ok(([(header::CONTENT_TYPE, "application/json")], output.0).into_response())
}

fn dataset_error(error: lance::Error) -> AppError {
  let mut cause = error.source();
  while let Some(err) = cause {
    if let Some(storage) = err.downcast_ref::<AppError>()
      && (matches!(
        storage,
        AppError::ObjectReadForbidden(_) | AppError::Forbidden(_)
      ) || matches!(storage, AppError::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied))
    {
      return AppError::Forbidden("access to the dataset was denied".into());
    }
    cause = err.source();
  }
  AppError::InvalidModel(format!("Lance: {error}"))
}

fn projected(ty: &DataType) -> bool {
  match ty {
    DataType::FixedSizeList(item, n) => (1..=2048).contains(n) && item.data_type().is_numeric(),
    DataType::Utf8
    | DataType::LargeUtf8
    | DataType::Utf8View
    | DataType::Boolean
    | DataType::Null => true,
    other => other.is_numeric() || other.is_temporal(),
  }
}

async fn page(
  backend: Arc<dyn StorageBackend>,
  root: &str,
  query: PageQuery,
) -> Result<DatasetPage, AppError> {
  let root = root.trim_end_matches('/');
  if !root.to_ascii_lowercase().ends_with(".lance")
    || root
      .split('/')
      .any(|s| matches!(s, "" | "." | "..") || s.contains('\\'))
  {
    return Err(AppError::InvalidPath(root.into()));
  }
  let limit = query.limit.unwrap_or(PAGE_ROWS);
  if !(1..=PAGE_ROWS).contains(&limit) {
    return Err(AppError::InvalidRange("limit must be 1..20".into()));
  }

  enum Source {
    Dataset(Box<lance::Dataset>),
    File(FileReader),
  }
  let store = Arc::new(store::DatasetStore::new(backend.clone(), root));
  let read_error = |error| {
    if store
      .read_limit_hit
      .load(std::sync::atomic::Ordering::Relaxed)
    {
      AppError::LancePageTooLarge("Reading this preview exceeds the 32 MiB storage read limit.")
    } else {
      dataset_error(error)
    }
  };
  let mut file_size = None;
  let source = if query.physical {
    if query.version.is_some() {
      return Err(AppError::Unsupported(
        "physical files have no snapshot version".into(),
      ));
    }
    backend.check_read_scope(root, root).await?;
    let meta = backend.stat(root).await?;
    file_size = Some(meta.size);
    let virtual_uri =
      url::Url::parse("memory:///selected-file").map_err(|e| AppError::Backend(e.to_string()))?;
    let object_store = store
      .new_store(virtual_uri, &Default::default())
      .await
      .map_err(read_error)?;
    let scheduler = ScanScheduler::new(Arc::new(object_store), SchedulerConfig::new(4 << 20));
    let file = scheduler
      .open_file(
        &object_store::path::Path::from("selected-file"),
        &CachedFileSize::new(meta.size),
      )
      .await
      .map_err(read_error)?;
    let reader = FileReader::try_open(
      file,
      None,
      Default::default(),
      &lance::cache::LanceCache::no_cache(),
      FileReaderOptions {
        batch_size_bytes: Some(DISPLAY_BYTES as u64),
        ..Default::default()
      },
    )
    .await
    .map_err(read_error)?;
    Source::File(reader)
  } else {
    // A missing versions directory identifies an ordinary folder. Preserve all
    // subsequent errors (missing fragments, stale snapshots, corrupt manifests).
    if query.version.is_none() {
      backend
        .check_read_scope(root, &format!("{root}/_versions"))
        .await?;
      let versions = backend
        .list_files(&format!("{root}/_versions/"), None)
        .await?;
      if versions.entries.is_empty() {
        return Err(AppError::NotFound("Lance versions directory".into()));
      }
    }

    let registry = Arc::new(ObjectStoreRegistry::empty());
    registry.insert("memory", store.clone());
    let session = Arc::new(Session::new(0, 2 << 20, registry));
    let mut builder = DatasetBuilder::from_uri("memory:///dataset").with_session(session);
    if let Some(version) = query.version {
      builder = builder.with_version(version);
    }
    let ds = builder.load().await.map_err(read_error)?;
    if !ds.manifest().base_paths.is_empty() {
      return Err(AppError::Unsupported("external Lance base paths".into()));
    }
    Source::Dataset(Box::new(ds))
  };
  let (schema, total, version, file_format) = match &source {
    Source::File(f) => (
      f.schema().as_ref(),
      usize::try_from(f.num_rows())
        .map_err(|_| AppError::Unsupported("file row count too large".into()))?,
      None,
      Some(f.version().to_string()),
    ),
    Source::Dataset(ds) => (
      ds.schema(),
      ds.count_rows(None).await.map_err(read_error)?,
      Some(ds.version().version),
      None,
    ),
  };
  if query.offset > total {
    return Err(AppError::InvalidRange(
      "offset exceeds dataset row count".into(),
    ));
  }
  let columns: Vec<_> = schema
    .fields
    .iter()
    .map(|field| {
      let ty = field.data_type();
      Column {
        name: field.name.clone(),
        data_type: ty.to_string(),
        omitted: !projected(&ty),
        nullable: field.nullable,
      }
    })
    .collect();
  let mut result = DatasetPage {
    version,
    file_format,
    file_size,
    total,
    offset: query.offset,
    columns,
    rows: Vec::new(),
    fragments: match &source {
      Source::Dataset(ds) => Some(ds.manifest().fragments.len()),
      Source::File(_) => None,
    },
  };
  if query.schema_only {
    return Ok(result);
  }
  let mut projection = schema.clone();
  projection.fields.retain(|f| projected(&f.data_type()));
  let range = query.offset..query.offset.saturating_add(limit).min(total);
  let mut rows: Vec<Value> = if range.is_empty() || projection.fields.is_empty() {
    vec![json!({}); range.len()]
  } else {
    let mut batches = match &source {
      Source::Dataset(ds) => {
        // take() materializes every requested row. Decode successive rows on
        // demand so an over-budget page can stop before fetching its tail.
        stream::iter(range)
          .then(move |row| {
            let projection = projection.clone();
            async move { ds.take(&[row as u64], projection).await.map_err(read_error) }
          })
          .boxed()
      }
      Source::File(f) => {
        let names = projection
          .fields
          .iter()
          .map(|v| v.name.as_str())
          .collect::<Vec<_>>();
        let projection =
          lance_file::versions::reader_projection_from_column_names(f.version(), schema, &names)
            .map_err(read_error)?;
        f.read_stream_projected(
          ReadBatchParams::Range(range),
          1,
          1,
          projection,
          lance_encoding::decoder::FilterExpression::no_filter(),
        )
        .await
        .map_err(read_error)?
        .map_err(read_error)
        .boxed()
      }
    };
    let mut writer: arrow_json::ArrayWriter<_> = arrow_json::WriterBuilder::new()
      .with_encoder_factory(Arc::new(decimal::DecimalStrings))
      .build(PageBuffer::default());
    let write_error = |e: arrow_schema::ArrowError| match e {
      arrow_schema::ArrowError::IoError(_, cause)
        if cause.kind() == io::ErrorKind::FileTooLarge =>
      {
        AppError::LancePageTooLarge(DISPLAY_LIMIT)
      }
      other => AppError::Unsupported(other.to_string()),
    };
    while let Some(batch) = batches.try_next().await? {
      if batch.get_array_memory_size() > DISPLAY_BYTES {
        return Err(AppError::LancePageTooLarge(DISPLAY_LIMIT));
      }
      budget::format_output(|| writer.write(&batch)).map_err(write_error)?;
    }
    budget::format_output(|| writer.finish()).map_err(write_error)?;
    budget::format_output(|| serde_json::from_slice(&writer.into_inner().0))
      .map_err(|e| AppError::Backend(e.to_string()))?
  };
  for row in &mut rows {
    preserve_integer_precision(row);
  }
  tracing::debug!(
    range_bytes = store.bytes_requested(),
    offset = query.offset,
    "read Lance page"
  );
  result.rows = rows;
  Ok(result)
}

// Preserve values that a JavaScript Number cannot represent exactly.
fn preserve_integer_precision(value: &mut Value) {
  const SAFE: u64 = (1 << 53) - 1;
  match value {
    Value::Number(n)
      if n.as_u64().is_some_and(|v| v > SAFE)
        || n.as_i64().is_some_and(|v| v.unsigned_abs() > SAFE) =>
    {
      *value = Value::String(n.to_string());
    }
    Value::Object(fields) => fields.values_mut().for_each(preserve_integer_precision),
    Value::Array(values) => values.iter_mut().for_each(preserve_integer_precision),
    _ => {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn preserves_nested_integer_and_decimal_precision() {
    use arrow_array::{Decimal128Array, RecordBatch};
    let mut nested = json!({"items":[{"id":9007199254740993_i64,"count":7}]});
    preserve_integer_precision(&mut nested);
    assert_eq!(
      nested,
      json!({"items":[{"id":"9007199254740993","count":7}]})
    );

    let values = Decimal128Array::from(vec![Some(12345678901234567890123456789_i128), None])
      .with_precision_and_scale(30, 8)
      .unwrap();
    let batch =
      RecordBatch::try_from_iter([("price", Arc::new(values) as arrow_array::ArrayRef)]).unwrap();
    let mut writer: arrow_json::ArrayWriter<_> = arrow_json::WriterBuilder::new()
      .with_encoder_factory(Arc::new(decimal::DecimalStrings))
      .build(Vec::new());
    writer.write(&batch).unwrap();
    writer.finish().unwrap();
    assert_eq!(
      serde_json::from_slice::<Value>(&writer.into_inner()).unwrap(),
      json!([{"price":"123456789012345678901.23456789"}, {}])
    );
  }

  #[tokio::test]
  async fn file_keeps_deleted_rows_and_dataset_respects_snapshot() {
    use crate::storage::local::LocalFsBackend;
    let dir = tempfile::tempdir().unwrap();
    let dataset = dir.path().join("fixture.lance");
    let schema = arrow_schema::Schema::new(vec![
      arrow_schema::Field::new("id", DataType::Int64, false),
      arrow_schema::Field::new("payload", DataType::Binary, true),
    ]);
    let reader = arrow_json::ReaderBuilder::new(Arc::new(schema))
      .build(std::io::Cursor::new(
        b"{\"id\":1}\n{\"id\":9007199254740993}\n",
      ))
      .unwrap();
    let mut ds = lance::Dataset::write(reader, dataset.to_str().unwrap(), None)
      .await
      .unwrap();
    let storage = Arc::new(LocalFsBackend::new(dir.path(), false));
    let query = PageQuery {
      physical: false,
      schema_only: false,
      storage: None,
      offset: 1,
      limit: Some(20),
      version: Some(1),
    };
    let result = page(storage.clone(), "fixture.lance/", query)
      .await
      .unwrap();
    assert!(result.columns[1].omitted);
    assert_eq!(result.total, 2);
    assert_eq!(result.rows, vec![json!({"id":"9007199254740993"})]);
    let file = format!(
      "fixture.lance/data/{}",
      ds.get_fragments()[0].metadata().files[0].path
    );
    ds.delete("id = 1").await.unwrap();
    let query = |physical| PageQuery {
      storage: None,
      offset: 0,
      limit: None,
      version: None,
      physical,
      schema_only: false,
    };
    for (key, physical) in [("fixture.lance", false), (file.as_str(), true)] {
      let metadata = page(
        storage.clone(),
        key,
        PageQuery {
          schema_only: true,
          ..query(physical)
        },
      )
      .await
      .unwrap();
      assert!(metadata.rows.is_empty());
      assert_eq!(metadata.file_size.is_some(), physical);
      assert_eq!(metadata.fragments, (!physical).then_some(1));
      assert!(metadata.columns[1].nullable);
    }
    let snapshot = page(storage.clone(), "fixture.lance", query(false))
      .await
      .unwrap();
    assert_eq!(snapshot.total, 1);
    assert_eq!(snapshot.version, Some(2));
    assert_eq!(snapshot.rows, result.rows);
    let physical = page(storage.clone(), &file, query(true)).await.unwrap();
    assert_eq!(physical.total, 2);
    assert!(physical.version.is_none());
    assert!(physical.file_format.is_some());
    assert_eq!(
      physical.rows,
      vec![json!({"id":1}), json!({"id":"9007199254740993"})]
    );
    tokio::fs::copy(dir.path().join(&file), dir.path().join("single.lance"))
      .await
      .unwrap();
    let single = page(storage.clone(), "single.lance", query(true))
      .await
      .unwrap();
    assert_eq!(single.rows, physical.rows);

    tokio::fs::remove_file(dir.path().join(&file))
      .await
      .unwrap();
    let missing_file = page(storage.clone(), &file, query(true))
      .await
      .err()
      .unwrap();
    assert_eq!(
      missing_file.into_response().status(),
      axum::http::StatusCode::NOT_FOUND
    );
    let broken_dataset = page(storage, "fixture.lance", query(false))
      .await
      .err()
      .unwrap();
    assert!(matches!(broken_dataset, AppError::InvalidModel(_)));
  }
  #[cfg(unix)]
  #[tokio::test]
  async fn members_must_resolve_inside_the_dataset() {
    use crate::storage::local::LocalFsBackend;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("preview.lance");
    tokio::fs::create_dir(&root).await.unwrap();
    tokio::fs::write(dir.path().join("sibling"), b"other dataset")
      .await
      .unwrap();
    tokio::fs::symlink("../sibling", root.join("part"))
      .await
      .unwrap();
    let backend = LocalFsBackend::new(dir.path(), true);
    assert!(matches!(
      backend
        .check_read_scope("preview.lance", "preview.lance/part")
        .await,
      Err(AppError::Forbidden(_))
    ));
    for follow in [true, false] {
      let backend = LocalFsBackend::new(dir.path(), follow);
      assert!(matches!(
        backend
          .get_scoped_file("preview.lance", "preview.lance/part", Default::default())
          .await,
        Err(AppError::Forbidden(_))
      ));
    }
  }

  #[test]
  fn excludes_unbounded_binary_and_large_vectors() {
    assert!(!projected(&DataType::Binary));
    let item = Arc::new(arrow_schema::Field::new("item", DataType::Float32, false));
    assert!(projected(&DataType::FixedSizeList(item.clone(), 768)));
    assert!(!projected(&DataType::FixedSizeList(item, 8192)));
  }
}
