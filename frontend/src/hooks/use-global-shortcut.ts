// Global keyboard shortcut registry.
//
// All application shortcuts are routed through a **single** `window keydown`
// listener rather than each component adding its own. Benefits:
//
//   * One listener for the whole app — simpler to reason about priority and
//     easier to verify (grep for `window.addEventListener('keydown'` should
//     return only the dispatcher in this file + any third-party Radix handlers).
//   * Deterministic priority — handlers registered first run first; later
//     handlers can check `e.defaultPrevented` to yield.
//   * Easy "pause when a dialog is open" gating — callers pass `active: false`
//     while their dialog is open, so the shortcut is temporarily unregistered
//     without unmounting the component.
//
// Usage:
//   // Simple shortcut — active while component is mounted
//   useGlobalShortcut('mod+k', () => setOpen(true))
//
//   // Gated — only fires while `previewOpen` is true
//   useGlobalShortcut('escape', closePreview, { active: previewOpen })
//
//   // Include media elements in the "editable" guard
//   useGlobalShortcut('arrowdown', next, { includeMedia: true })

import { useEffect, useRef } from 'react'

import { isEditableTarget, matchesCombo, parseCombo } from '@/lib/keyboard'
import type { KeyCombo } from '@/lib/keyboard'

// ---------------------------------------------------------------------------
// Module-level dispatcher — one window listener for the whole session.
// ---------------------------------------------------------------------------

type Handler = {
  combo: KeyCombo
  fn: (e: KeyboardEvent) => void
  includeMedia: boolean
}

// Ordered list of registered handlers. We don't bother with a WeakMap here
// because handlers are added/removed by object identity via the `useEffect`
// cleanup.
let handlers: Handler[] = []
let listenerMounted = false

function ensureListener() {
  if (listenerMounted) return
  listenerMounted = true
  window.addEventListener('keydown', dispatch, { capture: false })
}

function dispatch(e: KeyboardEvent) {
  for (const h of handlers) {
    if (isEditableTarget(e, h.includeMedia)) continue
    if (!matchesCombo(e, h.combo)) continue
    h.fn(e)
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface Options {
  /// When false the shortcut is temporarily inactive (the handler is not
  /// registered). Defaults to true.
  active?: boolean
  /// When true, INPUT/TEXTAREA/SELECT/isContentEditable guard also includes
  /// VIDEO and AUDIO elements. Useful for shortcuts that should skip while
  /// media controls have focus.
  includeMedia?: boolean
}

/// Register a global keyboard shortcut.
///
/// The handler fires when the key combination is pressed anywhere in the
/// page, unless focus is in an editable element (input, textarea, contenteditable)
/// or `active` is false.
///
/// `combo` syntax: modifiers (`mod`, `ctrl`, `alt`, `shift`) joined by `+`,
/// then the key name. Examples: `'mod+k'`, `'escape'`, `'?'`, `'arrowdown'`.
/// `mod` resolves to Cmd on macOS, Ctrl elsewhere.
export function useGlobalShortcut(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  { active = true, includeMedia = false }: Options = {},
): void {
  // Stable ref so the effect doesn't re-run when `handler` changes identity
  // (common with inline arrow functions in render). Synced via useEffect to
  // satisfy the react-hooks/refs rule (no ref writes during render).
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    if (!active) return
    ensureListener()
    const parsed = parseCombo(combo)
    const entry: Handler = {
      combo: parsed,
      fn: (e) => handlerRef.current(e),
      includeMedia,
    }
    handlers.push(entry)
    return () => {
      handlers = handlers.filter((h) => h !== entry)
    }
  }, [combo, active, includeMedia])
}
