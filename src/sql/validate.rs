//! Read-mostly SQL validation for the `/api/query` endpoint.
//!
//! This is the first, coarse line of defence: a ~100-line lexical pass that
//! rejects obviously-mutating statements before they reach DuckDB. It is NOT
//! the security boundary — that is the per-connection DuckDB session setup
//! (`disabled_filesystems` / `allowed_directories` / `lock_configuration`,
//! see `session.rs`), which holds even if a statement slips past this filter.

use crate::error::AppError;

/// Statements a query may start with. Everything here is read-only except
/// COPY, which gets an extra shape check (`COPY (<query>) TO ...` exports
/// only — never `COPY ... FROM` imports).
const ALLOWED_LEADING: &[&str] = &[
  "SELECT",
  "WITH",
  "FROM", // DuckDB FROM-first syntax
  "VALUES",
  "TABLE",
  "DESCRIBE",
  "DESC",
  "SHOW",
  "SUMMARIZE",
  "EXPLAIN",
  "PIVOT",
  "UNPIVOT",
  "COPY",
];

/// Keywords rejected anywhere in the statement (whole-word match on the
/// stripped text, so string literals / quoted identifiers / comments never
/// trigger them). Mutating DDL/DML plus everything that reconfigures the
/// session or touches extensions.
const FORBIDDEN_ANYWHERE: &[&str] = &[
  "INSTALL",
  "LOAD",
  "ATTACH",
  "DETACH",
  "EXPORT",
  "IMPORT",
  "PRAGMA",
  "SET",
  "RESET",
  "CALL",
  "CREATE",
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "MERGE",
  "VACUUM",
  "CHECKPOINT",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "ABORT",
  "USE",
  "GRANT",
  "REVOKE",
];

pub fn validate_readonly(sql: &str) -> Result<(), AppError> {
  let stripped = strip_literals_and_comments(sql);

  let mut statements = stripped.split(';').filter(|s| !s.trim().is_empty());
  let Some(stmt) = statements.next() else {
    return Err(AppError::QueryRejected("empty statement".into()));
  };
  if statements.next().is_some() {
    return Err(AppError::QueryRejected(
      "multiple statements are not allowed; submit one statement at a time".into(),
    ));
  }

  let words: Vec<&str> = tokenize_words(stmt);
  let Some(first) = words.first() else {
    return Err(AppError::QueryRejected("empty statement".into()));
  };
  let leading = first.to_ascii_uppercase();
  if !ALLOWED_LEADING.contains(&leading.as_str()) {
    return Err(AppError::QueryRejected(format!(
      "statement type '{leading}' is not allowed; only read-only queries \
       (SELECT / WITH / DESCRIBE / SHOW / SUMMARIZE / EXPLAIN / ...) and \
       COPY (...) TO exports are permitted"
    )));
  }

  for w in &words[1..] {
    let upper = w.to_ascii_uppercase();
    if FORBIDDEN_ANYWHERE.contains(&upper.as_str()) {
      return Err(AppError::QueryRejected(format!(
        "keyword '{upper}' is not allowed. If '{w}' is a column or table \
         name, wrap it in double quotes"
      )));
    }
  }

  if leading == "COPY" {
    validate_copy_shape(stmt)?;
  }
  Ok(())
}

/// Enforce that a COPY statement has the export shape `COPY ( <query> ) TO …`.
/// Rejects `COPY tbl FROM 'file'` (data import) and `COPY tbl TO …`
/// (requiring the parenthesised form keeps the parse trivial and loses no
/// expressiveness — any table export is `COPY (FROM tbl) TO …`).
///
/// Operates on stripped text: literals are already blanked, so parens inside
/// strings can't confuse the depth counter. The export target path itself is
/// NOT checked here — the DuckDB session sandbox constrains where writes can
/// land (S3 secret scope / `allowed_directories`).
fn validate_copy_shape(stripped_stmt: &str) -> Result<(), AppError> {
  let rest = stripped_stmt.trim_start();
  // The first *word* being COPY doesn't guarantee the statement *starts*
  // with it — tokenize_words skips punctuation and non-ASCII bytes, so e.g.
  // `(COPY …)` or `★COPY …` reach here too. `get(..4)` (not `[..4]`) keeps
  // a non-char-boundary prefix from panicking; any mismatch is rejected.
  let after_keyword = match rest.get(..4) {
    Some(kw) if kw.eq_ignore_ascii_case("copy") => &rest[4..],
    _ => {
      return Err(AppError::QueryRejected(
        "COPY must be the first token of the statement".into(),
      ));
    }
  };
  let rest = after_keyword.trim_start();
  if !rest.starts_with('(') {
    return Err(AppError::QueryRejected(
      "COPY is only allowed in the export form COPY (<query>) TO '<target>'".into(),
    ));
  }
  let mut depth = 0usize;
  let mut after_close = None;
  for (i, ch) in rest.char_indices() {
    match ch {
      '(' => depth += 1,
      ')' => {
        depth -= 1;
        if depth == 0 {
          after_close = Some(&rest[i + 1..]);
          break;
        }
      }
      _ => {}
    }
  }
  let Some(tail) = after_close else {
    return Err(AppError::QueryRejected(
      "unbalanced parentheses in COPY statement".into(),
    ));
  };
  match tokenize_words(tail).first() {
    Some(w) if w.eq_ignore_ascii_case("TO") => Ok(()),
    _ => Err(AppError::QueryRejected(
      "COPY (<query>) must be followed by TO '<target>'".into(),
    )),
  }
}

/// Split into identifier-ish words ([A-Za-z_][A-Za-z0-9_]*). Digits and
/// punctuation break words, so e.g. OFFSET never matches the SET blacklist
/// entry (whole-word semantics).
fn tokenize_words(s: &str) -> Vec<&str> {
  let mut out = Vec::new();
  let bytes = s.as_bytes();
  let mut i = 0;
  while i < bytes.len() {
    let c = bytes[i] as char;
    if c.is_ascii_alphabetic() || c == '_' {
      let start = i;
      while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_alphanumeric() || c == '_' {
          i += 1;
        } else {
          break;
        }
      }
      out.push(&s[start..i]);
    } else {
      i += 1;
    }
  }
  out
}

/// Blank out comments and quoted regions, preserving everything else so
/// token boundaries and parenthesis structure survive:
/// - `-- …` line comments (up to but not including the newline)
/// - `/* … */` block comments, nested (DuckDB/Postgres allow nesting)
/// - `'…'` string literals (`''` escapes a quote)
/// - `"…"` quoted identifiers (`""` escapes a quote)
/// - `$tag$ … $tag$` dollar-quoted strings (tag may be empty)
///
/// Stripped regions become spaces. Unterminated regions blank to the end of
/// input — DuckDB will reject the malformed SQL anyway; we only need to fail
/// safe (never let "inside a literal" leak into keyword scanning).
fn strip_literals_and_comments(sql: &str) -> String {
  let chars: Vec<char> = sql.chars().collect();
  let mut out: Vec<char> = Vec::with_capacity(chars.len());
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    let next = chars.get(i + 1).copied();
    if c == '-' && next == Some('-') {
      while i < chars.len() && chars[i] != '\n' {
        out.push(' ');
        i += 1;
      }
    } else if c == '/' && next == Some('*') {
      let mut depth = 1;
      out.push(' ');
      out.push(' ');
      i += 2;
      while i < chars.len() && depth > 0 {
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
          depth += 1;
          out.push(' ');
          out.push(' ');
          i += 2;
        } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
          depth -= 1;
          out.push(' ');
          out.push(' ');
          i += 2;
        } else {
          out.push(if chars[i] == '\n' { '\n' } else { ' ' });
          i += 1;
        }
      }
    } else if c == '\'' || c == '"' {
      let quote = c;
      out.push(' ');
      i += 1;
      while i < chars.len() {
        if chars[i] == quote {
          if chars.get(i + 1) == Some(&quote) {
            // Doubled quote = escaped; stay inside the literal.
            out.push(' ');
            out.push(' ');
            i += 2;
          } else {
            out.push(' ');
            i += 1;
            break;
          }
        } else {
          out.push(if chars[i] == '\n' { '\n' } else { ' ' });
          i += 1;
        }
      }
    } else if c == '$'
      && let Some(tag_len) = dollar_tag_len(&chars[i..])
    {
      let tag: Vec<char> = chars[i..i + tag_len].to_vec();
      out.extend(std::iter::repeat_n(' ', tag_len));
      i += tag_len;
      // Scan for the closing tag.
      while i < chars.len() {
        if chars[i] == '$' && chars[i..].starts_with(&tag[..]) {
          out.extend(std::iter::repeat_n(' ', tag_len));
          i += tag_len;
          break;
        }
        out.push(if chars[i] == '\n' { '\n' } else { ' ' });
        i += 1;
      }
    } else {
      out.push(c);
      i += 1;
    }
  }
  out.into_iter().collect()
}

/// If `chars` starts a dollar-quote opener (`$$` or `$tag$` where tag is
/// [A-Za-z_][A-Za-z0-9_]*), return the opener's length. `$1` style parameter
/// markers return None.
fn dollar_tag_len(chars: &[char]) -> Option<usize> {
  debug_assert_eq!(chars.first(), Some(&'$'));
  let mut j = 1;
  while j < chars.len() {
    let c = chars[j];
    if c == '$' {
      // Empty tag ($$) or a complete $tag$.
      return Some(j + 1);
    }
    let valid = if j == 1 {
      c.is_ascii_alphabetic() || c == '_'
    } else {
      c.is_ascii_alphanumeric() || c == '_'
    };
    if !valid {
      return None;
    }
    j += 1;
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ok(sql: &str) {
    validate_readonly(sql).unwrap_or_else(|e| panic!("should accept {sql:?}: {e}"));
  }

  fn rejected(sql: &str) -> String {
    match validate_readonly(sql) {
      Err(AppError::QueryRejected(msg)) => msg,
      other => panic!("should reject {sql:?}, got {other:?}"),
    }
  }

  #[test]
  fn accepts_whitelisted_statements() {
    ok("SELECT 1");
    ok("select * from 's3://bucket/x.parquet' limit 10");
    ok("WITH t AS (SELECT 1 AS a) SELECT * FROM t");
    ok("FROM 'data.csv' SELECT *");
    ok("VALUES (1, 2), (3, 4)");
    ok("DESCRIBE SELECT * FROM 'x.parquet'");
    ok("DESC SELECT 1");
    ok("SHOW TABLES");
    ok("SUMMARIZE SELECT * FROM 'x.parquet'");
    ok("EXPLAIN SELECT 1");
    ok("PIVOT tbl ON col USING sum(v)");
    ok("  \n  select 1  ");
  }

  #[test]
  fn rejects_mutating_statements() {
    rejected("INSERT INTO t VALUES (1)");
    rejected("UPDATE t SET x = 1"); // leading keyword check fires first
    rejected("DELETE FROM t");
    rejected("DROP TABLE t");
    rejected("CREATE TABLE t (x INT)");
    rejected("PRAGMA database_list");
    rejected("ATTACH 'other.db'");
    rejected("INSTALL httpfs");
    rejected("LOAD httpfs");
    rejected("EXPORT DATABASE 'dir'");
    rejected("CALL pragma_version()");
    rejected("VACUUM");
    rejected("BEGIN TRANSACTION");
  }

  #[test]
  fn rejects_forbidden_keywords_embedded() {
    rejected("SELECT 1; SET memory_limit='99GB'");
    rejected("WITH t AS (SELECT 1) INSERT INTO x SELECT * FROM t");
    let msg = rejected("SELECT * FROM t WHERE set = 1");
    assert!(msg.contains("double quotes"), "{msg}");
  }

  #[test]
  fn quoted_identifiers_and_literals_do_not_trigger() {
    ok(r#"SELECT "set", "create" FROM t"#);
    ok("SELECT 'DROP TABLE x' AS payload");
    ok("SELECT ';' AS semi");
    ok("SELECT 1 -- ; DROP TABLE t");
    ok("SELECT 1 /* ; INSERT INTO x */");
    ok("SELECT 1 /* outer /* nested INSERT */ still comment */");
    ok("SELECT $$ ; PRAGMA $$ AS s");
    ok("SELECT $tag$ ; set x $tag$ AS s");
    ok("SELECT 'it''s; fine'");
  }

  #[test]
  fn multiple_statements_rejected() {
    rejected("SELECT 1; SELECT 2");
    ok("SELECT 1;"); // trailing semicolon is fine
    ok("SELECT 1 ; \n ");
  }

  #[test]
  fn empty_input_rejected() {
    rejected("");
    rejected("   ");
    rejected("-- just a comment");
    rejected(";");
  }

  #[test]
  fn copy_export_shape() {
    ok("COPY (SELECT * FROM 's3://b/in.parquet') TO 's3://b/out.parquet' (FORMAT PARQUET)");
    ok("copy (from 'a.csv') to 'out.parquet'");
    ok("COPY ( WITH t AS (SELECT 1) SELECT * FROM t ) TO 'x.csv'");
    // Imports and table-form exports are rejected.
    rejected("COPY t FROM 'evil.csv'");
    rejected("COPY t TO 'out.csv'");
    rejected("COPY (SELECT 1) FROM 'x'");
    rejected("COPY (SELECT 1)");
    rejected("COPY (SELECT 1 TO 'x'"); // unbalanced parens
  }

  #[test]
  fn copy_not_at_statement_start_rejected_without_panic() {
    // tokenize_words skips punctuation / non-ASCII bytes, so the first WORD
    // can be COPY while the statement doesn't START with it. The multi-byte
    // prefix used to panic on a non-char-boundary slice (`rest[4..]`).
    rejected("★★COPY (SELECT 1) TO 'x'");
    rejected("(COPY (SELECT 1) TO 'x')");
    rejected("\u{00e9}COPY (SELECT 1) TO 'x'");
  }

  #[test]
  fn offset_does_not_match_set_blacklist() {
    ok("SELECT * FROM t LIMIT 10 OFFSET 5");
    ok("SELECT reset_count FROM t"); // word boundary: reset_count != RESET
  }

  #[test]
  fn dollar_parameter_is_not_a_quote() {
    // `$1` must not start a dollar-quoted region that swallows the rest.
    rejected("SELECT $1; DROP TABLE t");
  }
}
