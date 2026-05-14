//! Small wrapper around `nu_ansi_term` for CLI subcommand output.
//!
//! Why this module exists: every `println!` in `main.rs` would otherwise have
//! to repeat the same TTY / `NO_COLOR` check and `nu_ansi_term::Color::*`
//! incantation. Centralising it keeps call sites short and gives one place
//! to flip behaviour (e.g. when a future `--color={auto,always,never}` flag
//! lands).
//!
//! Two scopes — stdout vs stderr — because we may write CLI output to one
//! and never colour the other, depending on which is a TTY. We cache each
//! decision once via `OnceLock`.

use std::io::IsTerminal;
use std::sync::OnceLock;

use nu_ansi_term::{Color, Style};

// Pure inner function — no env access, no I/O. Lets tests exercise the
// precedence rules without mutating process-global state (which is racy
// under cargo's parallel test runner).
fn evaluate(no_color: bool, force_color: bool, is_tty: bool) -> bool {
  // NO_COLOR wins per https://no-color.org/ — even when forced.
  if no_color {
    return false;
  }
  if force_color {
    return true;
  }
  is_tty
}

fn check_decorate(is_tty: bool) -> bool {
  evaluate(
    std::env::var_os("NO_COLOR").is_some(),
    std::env::var_os("FORCE_COLOR").is_some(),
    is_tty,
  )
}

/// True iff we should decorate output written to stdout.
pub fn decorate() -> bool {
  static V: OnceLock<bool> = OnceLock::new();
  *V.get_or_init(|| check_decorate(std::io::stdout().is_terminal()))
}

/// True iff we should decorate output written to stderr. Independent of
/// `decorate()` because piping `2>file` shouldn't suppress stdout colour.
pub fn decorate_stderr() -> bool {
  static V: OnceLock<bool> = OnceLock::new();
  *V.get_or_init(|| check_decorate(std::io::stderr().is_terminal()))
}

// ---- colour helpers ------------------------------------------------------
//
// Each returns an owned String: when decoration is off we hand back the
// input verbatim, when on we wrap it in ANSI escapes. Callers can drop
// the result straight into a `println!` format string.

pub fn green(s: &str) -> String {
  if decorate() {
    Color::Green.paint(s).to_string()
  } else {
    s.to_string()
  }
}

pub fn red(s: &str) -> String {
  if decorate_stderr() {
    Color::Red.paint(s).to_string()
  } else {
    s.to_string()
  }
}

pub fn yellow(s: &str) -> String {
  if decorate() {
    Color::Yellow.paint(s).to_string()
  } else {
    s.to_string()
  }
}

pub fn cyan(s: &str) -> String {
  if decorate() {
    Color::Cyan.paint(s).to_string()
  } else {
    s.to_string()
  }
}

pub fn dim(s: &str) -> String {
  if decorate() {
    Style::new().dimmed().paint(s).to_string()
  } else {
    s.to_string()
  }
}

pub fn bold(s: &str) -> String {
  if decorate() {
    Style::new().bold().paint(s).to_string()
  } else {
    s.to_string()
  }
}

/// `cyan` gated on the *stderr* TTY flag — for paths printed alongside
/// red FAIL markers on stderr.
pub fn cyan_stderr(s: &str) -> String {
  if decorate_stderr() {
    Color::Cyan.paint(s).to_string()
  } else {
    s.to_string()
  }
}

/// `dim` gated on the *stderr* TTY flag — for line numbers / labels on the
/// error chain printed to stderr.
pub fn dim_stderr(s: &str) -> String {
  if decorate_stderr() {
    Style::new().dimmed().paint(s).to_string()
  } else {
    s.to_string()
  }
}

// ---- glyphs --------------------------------------------------------------
//
// Unicode glyphs render fine in pretty much every modern terminal, but
// piping to a log file or a CI runner that captures stdout as plain text
// often produces visual noise. We collapse to short ASCII fallbacks when
// decoration is off, which keeps logs greppable.

pub fn icon_ok() -> &'static str {
  if decorate() { "✓" } else { "[ok]" }
}

pub fn icon_fail() -> &'static str {
  if decorate_stderr() { "✗" } else { "[fail]" }
}

pub fn icon_warn() -> &'static str {
  if decorate() { "⚠" } else { "[!]" }
}

pub fn icon_active() -> &'static str {
  if decorate() { "🎯" } else { "*" }
}

// Section emoji include their own trailing space when present, and collapse
// to "" (no whitespace at all) when decoration is off. Call sites use
// `"{}rest"` rather than `"{} rest"` so the line has no stray leading space
// in NO_COLOR / pipe mode.

pub fn icon_folder() -> &'static str {
  if decorate() { "📁 " } else { "" }
}

pub fn icon_check() -> &'static str {
  if decorate() { "🔍 " } else { "" }
}

pub fn icon_init() -> &'static str {
  if decorate() { "📝 " } else { "" }
}

pub fn icon_info() -> &'static str {
  if decorate() { "📊 " } else { "" }
}

pub fn icon_prune() -> &'static str {
  if decorate() { "🧹 " } else { "" }
}

pub fn icon_clear() -> &'static str {
  if decorate() { "🗑 " } else { "" }
}

#[cfg(test)]
mod tests {
  use super::evaluate;

  // Tests exercise the pure `evaluate` function so they don't touch process
  // env (which is shared across parallel test threads).

  #[test]
  fn no_color_disables_even_when_tty() {
    assert!(!evaluate(true, false, true), "NO_COLOR must override TTY");
    assert!(!evaluate(true, false, false));
  }

  #[test]
  fn force_color_overrides_non_tty() {
    assert!(
      evaluate(false, true, false),
      "FORCE_COLOR must enable when piped"
    );
    assert!(evaluate(false, true, true));
  }

  #[test]
  fn no_color_beats_force_color() {
    assert!(!evaluate(true, true, true));
    assert!(!evaluate(true, true, false));
  }

  #[test]
  fn falls_back_to_tty_when_neither_env_set() {
    assert!(evaluate(false, false, true));
    assert!(!evaluate(false, false, false));
  }
}
