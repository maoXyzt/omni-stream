// Rules editor dialog for the Rows View. Extracted from RowsView.tsx so it
// can grow without crowding the main view file.
//
// Features beyond the basic textarea:
//   * Live validation — parses JSON + schema on every keystroke. Save is
//     disabled until the draft is valid; the error banner explains why.
//   * Modified indicator — title shows a bullet when the draft diverges
//     from the saved rules.
//   * Format button — pretty-prints valid JSON with 2-space indent.
//   * Cmd/Ctrl+S shortcut — saves when the draft is valid.
//   * Quick-insert templates — drop common atom/container snippets at the
//     cursor, with the placeholder pre-selected so the user can immediately
//     type the column name.
//   * Column chips — click to insert the column reference at the cursor
//     (wrapped in backticks when the column has special chars).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Eye, Wand2 } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RowNode } from '@/components/preview/rows-render'
import { type RenderContext } from '@/components/preview/rows-widgets'
import { type Node, parseRules } from '@/lib/rows-schema'
import { type ColumnInfo } from '@/lib/rows-source'
import { cn } from '@/lib/utils'

const EXAMPLE_RULES = `[
  "prompt",
  { "image": "image" },
  { "image": "image_edit", "src": "../edits/{value}" }
]`

interface Template {
  label: string
  /// Snippet inserted at cursor. The substring matching `placeholder`
  /// (if provided) is selected after insert so the user can type over it.
  snippet: string
  placeholder?: string
}

// Curated set of common building blocks. Atom widgets come first since
// they're the most common starting point; containers below for grouping.
const TEMPLATES: Template[] = [
  { label: 'Text', snippet: '"column_name"', placeholder: 'column_name' },
  {
    label: 'Image',
    snippet: '{ "image": "column_name" }',
    placeholder: 'column_name',
  },
  {
    label: 'Video',
    snippet: '{ "video": "column_name" }',
    placeholder: 'column_name',
  },
  {
    label: 'Audio',
    snippet: '{ "audio": "column_name" }',
    placeholder: 'column_name',
  },
  {
    label: 'Link',
    snippet: '{ "link": "column_name" }',
    placeholder: 'column_name',
  },
  {
    label: 'Markdown',
    snippet: '{ "markdown": "column_name" }',
    placeholder: 'column_name',
  },
  {
    label: 'Highlight',
    snippet: '{ "highlight": "column_name", "lang": "json" }',
    placeholder: 'column_name',
  },
  { label: 'Row', snippet: '{ "row": [] }' },
  { label: 'Column', snippet: '{ "column": [] }' },
  { label: 'Grid', snippet: '{ "grid": [], "columns": 2 }' },
]

interface RulesDialogProps {
  open: boolean
  rules: Node[]
  columns: ColumnInfo[]
  /// First loaded data row, used for the live-preview pane. Undefined while
  /// rows are still loading or the file is empty.
  sampleRow: Record<string, unknown> | undefined
  /// Forwarded to the preview RowNodes so image / video / link widgets
  /// resolve paths the same way the real renderer does.
  renderCtx: RenderContext
  onClose: () => void
  onSave: (next: Node[]) => void
}

export function RulesDialog({
  open,
  rules,
  columns,
  sampleRow,
  renderCtx,
  onClose,
  onSave,
}: RulesDialogProps) {
  const seededDraft = useMemo(
    () => (rules.length > 0 ? JSON.stringify(rules, null, 2) : EXAMPLE_RULES),
    [rules],
  )
  const [draft, setDraft] = useState(seededDraft)
  // Reseed when the dialog reopens — the saved rules might have changed in
  // another tab, or an earlier session bailed without saving.
  useEffect(() => {
    if (open) setDraft(seededDraft)
  }, [open, seededDraft])

  // Live validation: every keystroke parses + validates. Cheap enough that
  // running on every change is fine (parseRules on a typical config is sub-ms).
  const validation = useMemo<Validation>(() => {
    if (draft.trim().length === 0) {
      return { ok: false, error: 'empty config' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (err) {
      return {
        ok: false,
        error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const result = parseRules(parsed)
    if (result.error) return { ok: false, error: result.error }
    return { ok: true, rules: result.rules }
  }, [draft])

  const modified = draft !== seededDraft

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const insertAtCursor = useCallback(
    (snippet: string, selectPlaceholder?: string) => {
      const ta = textareaRef.current
      if (!ta) {
        setDraft((prev) => prev + snippet)
        return
      }
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const next = draft.slice(0, start) + snippet + draft.slice(end)
      setDraft(next)
      // Defer cursor placement until React applies the new value.
      requestAnimationFrame(() => {
        ta.focus()
        if (selectPlaceholder) {
          const phStart = next.indexOf(selectPlaceholder, start)
          if (phStart >= 0) {
            ta.setSelectionRange(phStart, phStart + selectPlaceholder.length)
            return
          }
        }
        ta.setSelectionRange(start + snippet.length, start + snippet.length)
      })
    },
    [draft],
  )

  const handleSave = useCallback(() => {
    if (!validation.ok) return
    onSave(validation.rules)
  }, [validation, onSave])

  const handleFormat = useCallback(() => {
    try {
      const parsed = JSON.parse(draft)
      setDraft(JSON.stringify(parsed, null, 2))
    } catch {
      // Invalid JSON can't be formatted — leave the draft alone so the
      // user can see what's wrong without losing context.
    }
  }, [draft])

  // Cmd/Ctrl+S in the dialog content saves when valid. We scope the handler
  // to the dialog (not window) so it doesn't fire while the dialog is closed.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave],
  )

  const handleClear = () => {
    onSave([])
  }

  const formattable = isFormattableJson(draft)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="flex h-[88vh] w-[95vw] max-w-7xl flex-col gap-3 sm:max-w-7xl"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Rows view rules
            {modified && (
              <span
                className="inline-block size-2 rounded-full bg-amber-500"
                aria-label="unsaved changes"
                title="Unsaved changes"
              />
            )}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          JSON array of rule nodes. Sugar accepted: <span className="font-mono">"col"</span> (text atom),{' '}
          <span className="font-mono">{'{ "image": "col" }'}</span> (widget shortcut),{' '}
          <span className="font-mono">{'{ "row": [...] }'}</span> (container).
          See <span className="font-mono">docs/parquet_rows_view_user_guide.md</span> for the full reference.
        </p>

        <div className="flex min-h-0 flex-1 gap-3">
          {/* Editor pane */}
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className={cn(
                'min-h-0 flex-1 resize-none rounded-md border border-input bg-transparent p-3 font-mono text-xs leading-relaxed',
                'transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                'dark:bg-input/30',
              )}
            />
            <StatusLine validation={validation} />
          </div>

          {/* Side panel */}
          <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-auto">
            <Section title="Insert">
              <div className="flex flex-wrap gap-1">
                {TEMPLATES.map((t) => (
                  <Button
                    key={t.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => insertAtCursor(t.snippet, t.placeholder)}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Click to insert at cursor.
              </p>
            </Section>

            <Section title={`Columns · ${columns.length}`}>
              {columns.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">
                  No columns detected.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {columns.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => insertAtCursor(asJsonString(c.name))}
                      title={c.type}
                      className="inline-flex items-center rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              {columns.length > 0 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Click to insert as <span className="font-mono">"col"</span>.
                </p>
              )}
            </Section>
          </aside>

          {/* Preview pane */}
          <PreviewPane
            validation={validation}
            sampleRow={sampleRow}
            renderCtx={renderCtx}
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleFormat}
            disabled={!formattable}
            className="mr-auto"
          >
            <Wand2 className="size-4" />
            Format
          </Button>
          {rules.length > 0 && (
            <Button variant="ghost" onClick={handleClear}>
              Clear rules
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!validation.ok}>
            Save{' '}
            <kbd className="ml-1 inline-flex h-4 items-center rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1 font-mono text-[10px] leading-none">
              ⌘S
            </kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Validation =
  | { ok: true; rules: Node[] }
  | { ok: false; error: string }

// Live preview pane — renders the first loaded row using the current draft
// (when valid). Mirrors the body layout of the real RowCard so the user
// sees something close to the production rendering.
function PreviewPane({
  validation,
  sampleRow,
  renderCtx,
}: {
  validation: Validation
  sampleRow: Record<string, unknown> | undefined
  renderCtx: RenderContext
}) {
  return (
    <aside className="flex w-[28rem] shrink-0 min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Eye className="size-3.5" />
        Live preview
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card">
        <div className="border-b bg-muted/40 px-3 py-1.5 font-mono text-xs text-muted-foreground">
          {sampleRow ? 'row 1' : '—'}
        </div>
        <div className="flex flex-wrap items-start gap-3 p-3">
          <PreviewBody
            validation={validation}
            sampleRow={sampleRow}
            renderCtx={renderCtx}
          />
        </div>
      </div>
    </aside>
  )
}

function PreviewBody({
  validation,
  sampleRow,
  renderCtx,
}: {
  validation: Validation
  sampleRow: Record<string, unknown> | undefined
  renderCtx: RenderContext
}) {
  if (!validation.ok) {
    return (
      <div className="w-full rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-xs italic text-muted-foreground">
        Fix the errors above to see the live preview.
      </div>
    )
  }
  if (!sampleRow) {
    return (
      <div className="w-full rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-xs italic text-muted-foreground">
        No row loaded yet. Open a non-empty file to preview.
      </div>
    )
  }
  if (validation.rules.length === 0) {
    return (
      <div className="w-full rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-xs italic text-muted-foreground">
        Empty rule set — nothing to render.
      </div>
    )
  }
  return (
    <>
      {validation.rules.map((node, i) => (
        <RowNode key={i} node={node} row={sampleRow} ctx={renderCtx} />
      ))}
    </>
  )
}

function StatusLine({ validation }: { validation: Validation }) {
  if (validation.ok) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="size-3.5" />
        <span>
          {validation.rules.length} node
          {validation.rules.length === 1 ? '' : 's'} — valid
        </span>
      </div>
    )
  }
  return (
    <Alert variant="destructive" className="py-2">
      <AlertCircle className="size-4" />
      <AlertTitle className="text-xs">Invalid rules</AlertTitle>
      <AlertDescription className="font-mono text-[11px] break-words">
        {validation.error}
      </AlertDescription>
    </Alert>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  )
}

// Cheap check: only run the Format button when JSON.parse will succeed.
// Avoids enabling the button on a typo and silently dropping the user's
// in-progress edits.
function isFormattableJson(text: string): boolean {
  if (text.trim().length === 0) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// Encode a column name as a JSON string holding a valid selector. Plain
// identifiers go through as-is; anything else gets wrapped in backticks so
// special chars (dots, spaces, ...) don't get re-interpreted by the selector
// parser. The JSON.stringify then escapes any embedded quotes for the
// JSON layer.
function asJsonString(col: string): string {
  const isPlainIdent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(col)
  const selector = isPlainIdent ? col : `\`${col}\``
  return JSON.stringify(selector)
}
