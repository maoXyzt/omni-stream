//! Query execution and row → JSON serialization.

use duckdb::Connection;
use duckdb::types::{TimeUnit, ValueRef};
use serde_json::{Value as Json, json};

use crate::error::AppError;
use crate::sql::ColumnInfo;

/// (columns, rows, truncated)
pub type QueryOutput = (Vec<ColumnInfo>, Vec<Vec<Json>>, bool);

/// Run one (already validated) statement, returning column metadata plus up
/// to `max_rows` rows as JSON values.
pub fn run_query(conn: &Connection, sql: &str, max_rows: usize) -> Result<QueryOutput, AppError> {
  let mut stmt = conn
    .prepare(sql)
    .map_err(|e| AppError::Query(e.to_string()))?;
  let mut rows = stmt.query([]).map_err(|e| AppError::Query(e.to_string()))?;

  // Column metadata is only available once the statement has executed,
  // which `query()` above guarantees.
  let columns: Vec<ColumnInfo> = rows
    .as_ref()
    .map(|s| {
      (0..s.column_count())
        .map(|i| ColumnInfo {
          name: s.column_name(i).cloned().unwrap_or_default(),
          r#type: s.column_type(i).to_string(),
        })
        .collect()
    })
    .unwrap_or_default();
  let ncols = columns.len();

  let mut out: Vec<Vec<Json>> = Vec::new();
  let mut truncated = false;
  while let Some(row) = rows.next().map_err(|e| AppError::Query(e.to_string()))? {
    if out.len() >= max_rows {
      // One probe row past the cap proves there was more.
      truncated = true;
      break;
    }
    let mut record = Vec::with_capacity(ncols);
    for i in 0..ncols {
      let vref = row.get_ref(i).map_err(|e| AppError::Query(e.to_string()))?;
      record.push(value_to_json(vref));
    }
    out.push(record);
  }
  Ok((columns, out, truncated))
}

/// Lossy-but-stable mapping into JSON. Numbers stay numbers where JSON can
/// hold them exactly; everything temporal / high-precision degrades to a
/// human-readable string rather than failing the whole response.
fn value_to_json(v: ValueRef<'_>) -> Json {
  match v {
    ValueRef::Null => Json::Null,
    ValueRef::Boolean(b) => b.into(),
    ValueRef::TinyInt(i) => i.into(),
    ValueRef::SmallInt(i) => i.into(),
    ValueRef::Int(i) => i.into(),
    ValueRef::BigInt(i) => i.into(),
    ValueRef::UTinyInt(i) => i.into(),
    ValueRef::USmallInt(i) => i.into(),
    ValueRef::UInt(i) => i.into(),
    ValueRef::UBigInt(i) => i.into(),
    // i128 exceeds JSON number range; keep precision as a string.
    ValueRef::HugeInt(i) => json!(i.to_string()),
    ValueRef::Float(f) => float_to_json(f64::from(f)),
    ValueRef::Double(f) => float_to_json(f),
    ValueRef::Decimal(d) => json!(d.to_string()),
    ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
    ValueRef::Blob(b) => json!(format!("<blob {} bytes>", b.len())),
    ValueRef::Date32(days) => json!(format_date(days)),
    ValueRef::Time64(unit, v) => json!(format_time(unit.to_micros(v))),
    ValueRef::Timestamp(unit, v) => {
      let micros = unit.to_micros(v);
      let days = micros.div_euclid(86_400_000_000);
      let in_day = micros.rem_euclid(86_400_000_000);
      json!(format!(
        "{} {}",
        format_date(days as i32),
        format_time(in_day),
      ))
    }
    ValueRef::Interval {
      months,
      days,
      nanos,
    } => json!(format!("{months} months {days} days {nanos} ns")),
    // Nested / exotic types: degrade to the debug rendering of the owned
    // value. Not pretty, but lossless enough for an exploratory UI; can be
    // upgraded to recursive JSON later without an API change.
    other => {
      let owned = other.to_owned();
      match owned {
        duckdb::types::Value::Enum(s) => json!(s),
        v => json!(format!("{v:?}")),
      }
    }
  }
}

/// serde_json rejects non-finite floats; surface them as strings.
fn float_to_json(f: f64) -> Json {
  if f.is_finite() {
    json!(f)
  } else {
    json!(f.to_string())
  }
}

/// Days-since-epoch → `YYYY-MM-DD`, via the classic civil-from-days
/// algorithm (Howard Hinnant). Avoids pulling in chrono for one format call.
fn format_date(days_since_epoch: i32) -> String {
  let z = i64::from(days_since_epoch) + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097); // [0, 146096]
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
  let mp = (5 * doy + 2) / 153; // [0, 11]
  let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
  let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
  let y = if m <= 2 { y + 1 } else { y };
  format!("{y:04}-{m:02}-{d:02}")
}

/// Microseconds within a day → `HH:MM:SS[.ffffff]`.
fn format_time(micros_in_day: i64) -> String {
  let secs = micros_in_day.div_euclid(1_000_000);
  let frac = micros_in_day.rem_euclid(1_000_000);
  let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
  if frac == 0 {
    format!("{h:02}:{m:02}:{s:02}")
  } else {
    format!("{h:02}:{m:02}:{s:02}.{frac:06}")
  }
}

#[allow(dead_code)]
fn _assert_time_unit_exhaustive(u: TimeUnit) {
  // Compile-time nudge: if duckdb adds a TimeUnit variant, to_micros above
  // keeps working (it's their method), so no action needed here.
  match u {
    TimeUnit::Second | TimeUnit::Millisecond | TimeUnit::Microsecond | TimeUnit::Nanosecond => {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn conn() -> Connection {
    Connection::open_in_memory().expect("open in-memory duckdb")
  }

  #[test]
  fn basic_types_roundtrip() {
    let c = conn();
    let (cols, rows, truncated) = run_query(
      &c,
      "SELECT 1::INT AS i, 'x' AS s, true AS b, 1.5::DOUBLE AS f, NULL AS n",
      100,
    )
    .unwrap();
    assert_eq!(
      cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
      ["i", "s", "b", "f", "n"],
    );
    assert!(!truncated);
    assert_eq!(
      rows,
      vec![vec![
        json!(1),
        json!("x"),
        json!(true),
        json!(1.5),
        Json::Null
      ]]
    );
  }

  #[test]
  fn truncation_at_max_rows() {
    let c = conn();
    let (_, rows, truncated) = run_query(&c, "SELECT * FROM range(100)", 10).unwrap();
    assert_eq!(rows.len(), 10);
    assert!(truncated);

    let (_, rows, truncated) = run_query(&c, "SELECT * FROM range(10)", 10).unwrap();
    assert_eq!(rows.len(), 10);
    assert!(!truncated, "exactly max_rows is not truncated");
  }

  #[test]
  fn temporal_and_precision_types_degrade_to_strings() {
    let c = conn();
    let (_, rows, _) = run_query(
      &c,
      "SELECT DATE '2024-02-29' AS d, TIME '12:34:56' AS t, \
       TIMESTAMP '2024-02-29 12:34:56' AS ts, \
       1.25::DECIMAL(10,2) AS dec, \
       170141183460469231731687303715884105727::HUGEINT AS h, \
       encode('ab') AS blob",
      10,
    )
    .unwrap();
    let row = &rows[0];
    assert_eq!(row[0], json!("2024-02-29"));
    assert_eq!(row[1], json!("12:34:56"));
    assert_eq!(row[2], json!("2024-02-29 12:34:56"));
    assert_eq!(row[3], json!("1.25"));
    assert_eq!(row[4], json!("170141183460469231731687303715884105727"));
    assert_eq!(row[5], json!("<blob 2 bytes>"));
  }

  #[test]
  fn nested_types_do_not_panic() {
    let c = conn();
    let (_, rows, _) = run_query(&c, "SELECT [1,2,3] AS l, {'a': 1} AS st", 10).unwrap();
    assert!(rows[0][0].is_string());
    assert!(rows[0][1].is_string());
  }

  #[test]
  fn query_errors_pass_through_message() {
    let c = conn();
    let err = run_query(&c, "SELECT * FROM nonexistent_table_xyz", 10).unwrap_err();
    match err {
      AppError::Query(msg) => {
        assert!(msg.contains("nonexistent_table_xyz"), "{msg}");
      }
      other => panic!("expected Query error, got {other:?}"),
    }
  }

  #[test]
  fn pre_epoch_date_formats_correctly() {
    assert_eq!(format_date(0), "1970-01-01");
    assert_eq!(format_date(-1), "1969-12-31");
    assert_eq!(format_date(19_789), "2024-03-07");
  }

  #[test]
  fn local_sandbox_blocks_reads_outside_root() {
    use crate::config::SqlConfig;
    use crate::sql::SqlTarget;

    let dir = std::env::temp_dir().join("omni-sql-sandbox-test");
    std::fs::create_dir_all(&dir).unwrap();
    let inside = dir.join("ok.csv");
    std::fs::write(&inside, "a,b\n1,2\n").unwrap();

    let c = conn();
    let setup = crate::sql::session::setup_statements(
      &SqlConfig::default(),
      &SqlTarget::Local {
        root_path: dir.clone(),
      },
    )
    .unwrap();
    c.execute_batch(&setup).unwrap();

    // Inside the root: works.
    let (_, rows, _) = run_query(
      &c,
      &format!("SELECT * FROM read_csv('{}')", inside.display()),
      10,
    )
    .unwrap();
    assert_eq!(rows.len(), 1);

    // Outside the root: blocked by allowed_directories.
    let err = run_query(&c, "SELECT * FROM read_csv('/etc/hosts')", 10).unwrap_err();
    match err {
      AppError::Query(msg) => assert!(
        msg.to_lowercase().contains("permission")
          || msg.to_lowercase().contains("not allowed")
          || msg.to_lowercase().contains("disabled"),
        "unexpected error: {msg}"
      ),
      other => panic!("expected Query error, got {other:?}"),
    }

    // Sandbox settings are locked.
    let err = run_query(&c, "SET enable_external_access = true", 10).unwrap_err();
    match err {
      AppError::Query(msg) => assert!(msg.to_lowercase().contains("lock"), "{msg}"),
      other => panic!("expected Query error, got {other:?}"),
    }
  }
}
