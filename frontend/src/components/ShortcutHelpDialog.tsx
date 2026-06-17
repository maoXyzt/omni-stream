import { Kbd } from '@/components/ui/kbd'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { groupedShortcuts } from '@/lib/shortcuts'

interface ShortcutHelpDialogProps {
  open: boolean
  onClose: () => void
}

/// Keyboard shortcut reference dialog. Opened by pressing `?` anywhere in
/// the app (when focus is not in an editable element). Lists all registered
/// shortcuts grouped by area.
export function ShortcutHelpDialog({ open, onClose }: ShortcutHelpDialogProps) {
  const groups = groupedShortcuts()
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg gap-4">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          {groups.map(({ group, entries }) => (
            <section key={group}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </h3>
              <ul className="space-y-1">
                {entries.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-4 rounded-sm px-1 py-0.5 text-sm"
                  >
                    <span className="text-foreground">{s.label}</span>
                    {/* Each token in displayCombo is a separate keycap. Tokens
                        are whitespace-separated; `/` is a separator not a key. */}
                    <span className="shrink-0 flex items-center gap-0.5 font-mono text-xs text-muted-foreground">
                      {formatComboTokens(s.displayCombo).map((token, i) => (
                        <span key={i} className="flex items-center gap-0.5">
                          {token.type === 'sep' ? (
                            <span className="px-0.5 text-muted-foreground/60">{token.value}</span>
                          ) : (
                            <Kbd variant="default">{token.value}</Kbd>
                          )}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Press <Kbd variant="default">?</Kbd> to toggle this dialog
        </p>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Token parser for displayCombo strings
// ---------------------------------------------------------------------------

interface ComboToken {
  type: 'key' | 'sep'
  value: string
}

/// Split a displayCombo string like "⌘/Ctrl K" or "← / ↑" into renderable
/// tokens (keycap vs. separator).
///
/// Rules:
///   - Split on whitespace; trim each token.
///   - Lone `/` or `+` tokens are separators (between-key connectives).
///   - Everything else is a keycap.
function formatComboTokens(combo: string): ComboToken[] {
  const rawParts = combo.split(/(\s+)/).filter((p) => p.trim().length > 0)
  const out: ComboToken[] = []
  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i].trim()
    if (part === '/' || part === '+') {
      out.push({ type: 'sep', value: part })
    } else {
      out.push({ type: 'key', value: part })
    }
  }
  return out
}
