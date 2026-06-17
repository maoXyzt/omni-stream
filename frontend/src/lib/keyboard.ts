/// Keyboard utility helpers shared across the application.
///
/// Centralises the input-guard check that previously was duplicated in four
/// separate `window keydown` handlers (FileList × 2, ImagePreview,
/// PreviewModal) and provides a lightweight key-combo normaliser used by the
/// global shortcut registry.

// ---------------------------------------------------------------------------
// Input guard
// ---------------------------------------------------------------------------

/// Returns true when the keyboard event originated from an interactive element
/// where the key has a native meaning (typing, editing, media control) and
/// should NOT trigger application shortcuts.
///
/// Optionally includes VIDEO/AUDIO elements when `includeMedia` is true —
/// relevant for PreviewModal which renders video/audio controls.
export function isEditableTarget(
  e: KeyboardEvent,
  includeMedia = false,
): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (t.isContentEditable) return true
  if (includeMedia && (tag === 'VIDEO' || tag === 'AUDIO')) return true
  return false
}

// ---------------------------------------------------------------------------
// Key-combo normalisation
// ---------------------------------------------------------------------------

export interface KeyCombo {
  key: string       // lowercase key name, e.g. "k", "arrowdown", "escape"
  meta: boolean     // Cmd on Mac, Win on other (matches `metaKey`)
  ctrl: boolean
  alt: boolean
  shift: boolean
  /// True for "mod" combos — ⌘ on Mac, Ctrl on Windows/Linux.
  mod: boolean
}

const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

/// Parse a shortcut string into a normalised `KeyCombo`.
///
/// Syntax: zero or more modifiers separated by `+`, then the key name.
/// Recognised modifiers: `mod` (⌘/Ctrl), `cmd`, `meta`, `ctrl`, `alt`,
///   `shift`.  Key names are lower-cased.
///
/// Examples:
///   parseCombo('mod+k')        → { mod:true, key:'k', … }
///   parseCombo('shift+?')      → { shift:true, key:'?', … }
///   parseCombo('escape')       → { key:'escape', … }
///   parseCombo('arrowdown')    → { key:'arrowdown', … }
export function parseCombo(combo: string): KeyCombo {
  const lower = combo.toLowerCase()
  // '+' can be both a separator AND the key name. When the last segment after
  // splitting on '+' is empty, the combo ends with '+', meaning the key IS '+'.
  // e.g. '+' → ['','']  and  'shift++' → ['shift','','']
  const raw = lower.split('+')
  const key = raw.at(-1) === '' ? '+' : (raw.at(-1) ?? '')
  const modParts = raw.at(-1) === '' ? raw.slice(0, -2) : raw.slice(0, -1)
  const mods = new Set(modParts.filter(Boolean))
  const mod = mods.has('mod') || mods.has('cmd') || mods.has('meta')
  return {
    key,
    meta: mod ? isMac : mods.has('meta'),
    ctrl: mod ? !isMac : mods.has('ctrl'),
    alt: mods.has('alt'),
    shift: mods.has('shift'),
    mod,
  }
}

/// Returns true when a keyboard event matches the given combo.
export function matchesCombo(e: KeyboardEvent, combo: KeyCombo): boolean {
  if (e.key.toLowerCase() !== combo.key) return false
  if (combo.meta && !e.metaKey) return false
  if (combo.ctrl && !e.ctrlKey) return false
  if (combo.alt && !e.altKey) return false
  if (combo.shift && !e.shiftKey) return false
  // Reject unintended modifier combinations (e.g. combo expects no meta but
  // user holds Cmd — the browser's native shortcut should win).
  if (!combo.meta && e.metaKey) return false
  if (!combo.ctrl && e.ctrlKey) return false
  if (!combo.alt && e.altKey) return false
  return true
}
