/// Central catalog of application keyboard shortcuts.
///
/// Each entry describes a shortcut that is displayed in the `?` help dialog
/// and (optionally) in the command palette. Registration of the actual
/// handler is done by individual components via `useGlobalShortcut` —
/// this file is pure metadata, no side effects.
///
/// Groups are shown as sections in the help dialog. Keep labels short (one
/// or two words). The `combo` string follows `parseCombo` syntax:
///   'mod+k', 'escape', '?', 'arrowdown', 'shift+/', etc.

export interface ShortcutEntry {
  id: string
  /// Human-readable key combination shown in the help dialog.
  /// Use platform-neutral labels: `⌘/Ctrl` for Mod, `Alt`, `Shift`.
  displayCombo: string
  label: string
  group: ShortcutGroup
}

export type ShortcutGroup =
  | 'Navigation'
  | 'Preview'
  | 'File operations'
  | 'View'
  | 'General'

export const SHORTCUTS: ShortcutEntry[] = [
  // --- General --------------------------------------------------------------
  {
    id: 'help',
    displayCombo: '?',
    label: 'Show keyboard shortcuts',
    group: 'General',
  },
  {
    id: 'command-palette',
    displayCombo: '⌘/Ctrl K',
    label: 'Open command palette',
    group: 'General',
  },

  // --- Navigation -----------------------------------------------------------
  {
    id: 'go-up',
    displayCombo: 'Backspace',
    label: 'Go up one folder',
    group: 'Navigation',
  },
  {
    id: 'nav-prev',
    displayCombo: '← / ↑',
    label: 'Previous file (while preview is open)',
    group: 'Navigation',
  },
  {
    id: 'nav-next',
    displayCombo: '→ / ↓',
    label: 'Next file (while preview is open)',
    group: 'Navigation',
  },

  // --- Preview --------------------------------------------------------------
  {
    id: 'close-preview',
    displayCombo: 'Esc',
    label: 'Close preview',
    group: 'Preview',
  },
  {
    id: 'zoom-in',
    displayCombo: '+',
    label: 'Zoom in (image preview)',
    group: 'Preview',
  },
  {
    id: 'zoom-out',
    displayCombo: '−',
    label: 'Zoom out (image preview)',
    group: 'Preview',
  },
]

/// Returns shortcuts grouped for display, preserving the order groups first
/// appear in the SHORTCUTS array.
export function groupedShortcuts(): Array<{
  group: ShortcutGroup
  entries: ShortcutEntry[]
}> {
  const seen = new Map<ShortcutGroup, ShortcutEntry[]>()
  for (const s of SHORTCUTS) {
    if (!seen.has(s.group)) seen.set(s.group, [])
    seen.get(s.group)!.push(s)
  }
  return Array.from(seen.entries()).map(([group, entries]) => ({
    group,
    entries,
  }))
}
