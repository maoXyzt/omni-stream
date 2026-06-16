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
import JSON5 from 'json5'
import { Editor } from '@/lib/code-editor'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { RowNode } from '@/components/preview/rows-render'
import { type RenderContext } from '@/components/preview/rows-widgets'
import { buildAiPrompt } from '@/components/preview/rows-ai-prompt'
import { type Preset, useRowsPresets } from '@/hooks/use-rows-presets'
import { type PresetMatch, presetMatch } from '@/lib/rows-applicability'
import { highlightJson5 } from '@/lib/highlight-json5'
import { type Node, parseRules } from '@/lib/rows-schema'
import { type ColumnInfo } from '@/lib/rows-source'
import { cn } from '@/lib/utils'

// Used only when the file has no detectable columns (corrupted schema, or
// the dialog opened before a source resolved). Real templates are derived
// from `columns` — see `defaultTemplateFor` below.
const EXAMPLE_RULES = `[
  "prompt",
  { "image": "image" },
  { "image": "image_edit", "src": "../edits/{value}" }
]`

// Substring hints used to map a column name to a widget. Conservative on
// purpose — false positives are worse than no inference (a "url" column
// rendered as a clickable link is fine; a "description" column rendered
// as a link 404s). Order doesn't matter; the first match wins.
const NAME_HINTS: ReadonlyArray<{ pattern: RegExp; widget: 'image' | 'video' | 'audio' | 'link' | 'markdown' }> = [
  {
    widget: 'image',
    pattern: /(^|_)(image|img|thumb(?:nail)?|picture|photo|avatar|cover|poster|icon)(_|s?$)/i,
  },
  { widget: 'video', pattern: /(^|_)(video|clip|movie)(_|s?$)/i },
  { widget: 'audio', pattern: /(^|_)(audio|sound|voice|music|mp3|wav)(_|s?$)/i },
  { widget: 'link', pattern: /(^|_)(url|link|href|uri|homepage|website)(_|s?$)/i },
  { widget: 'markdown', pattern: /(^|_)(markdown|readme)(_|s?$)/i },
]

// LIST-typed columns get a `.[*]` fan-out so every element renders. Covers
// parquet's `LIST<…>` schema strings and the inferred `array` type that the
// jsonl/json sources emit. Anything else (STRUCT, scalar) renders as-is.
function isListType(type: string): boolean {
  return /^list\b/i.test(type) || /\barray\b/i.test(type)
}

// Selector form of a column name. Plain identifiers can be inserted bare;
// names with dots / spaces / other punctuation need backtick-wrapping so
// the selector parser doesn't try to walk into a nested field. Names
// containing a literal backtick are exotic enough that we punt — the
// generated template will fail validation and the status line will tell
// the user to wrap that one column themselves.
function selectorFor(col: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) return col
  if (!col.includes('`')) return `\`${col}\``
  return col
}

// Widgets whose default `src` ("{value}") deserves a heads-up when the
// auto-generated template includes them. text widget intentionally
// excluded — the template's name hints don't currently emit it.
const SRC_AWARE_WIDGETS = new Set(['image', 'video', 'audio', 'link', 'text'])

/// Best-effort default template: one node per column, widget inferred from
/// the column name, LIST types fanned out via `.[*]`. Emits sugar JSON
/// (matches how a human would write it) and goes through the same
/// `JSON.stringify(_, null, 2)` formatter as saved rules so the output is
/// idempotent — Save → reopen → no "modified" indicator. When the
/// template contains any media widget, prepends a JSON5 comment block
/// above the array explaining the implicit `src: "{value}"` default and
/// how to override it; safe because the editor parses JSON5 and Save
/// canonicalises the comments away.
function defaultTemplateFor(columns: ColumnInfo[]): string {
  if (columns.length === 0) return EXAMPLE_RULES
  const nodes = columns.map((c) => {
    const list = isListType(c.type)
    const selector = selectorFor(c.name) + (list ? '.[*]' : '')
    const widget = NAME_HINTS.find((h) => h.pattern.test(c.name))?.widget
    if (!widget) {
      // Sugar: bare string = default-widget atom on this selector.
      return selector
    }
    const node: Record<string, unknown> = { [widget]: selector }
    // Lists of images render best as a grid; a long horizontal flow row
    // either truncates or wraps awkwardly. 3 columns is a reasonable
    // starting point users tweak.
    if (list && widget === 'image') {
      node.layout = 'grid'
      node.columns = 3
    }
    return node
  })
  const json = JSON.stringify(nodes, null, 2)
  const hasMediaWidget = nodes.some(
    (n) =>
      typeof n === 'object' &&
      n !== null &&
      Object.keys(n).some((k) => SRC_AWARE_WIDGETS.has(k)),
  )
  if (!hasMediaWidget) return json
  // Banner sits above the array — keeps the JSON body itself the canonical
  // `JSON.stringify(_, null, 2)` form a Format round-trip would emit (and
  // also reads more like a file-level docstring than an inline aside).
  const banner = [
    '// Each image / video / audio / link / text widget below omits "src",',
    '// which defaults to "{value}" — the cell\'s value is treated as a',
    '// storage path resolved relative to this data file. Override per-node:',
    '//   { "image": "id", "src": "https://cdn/{value}.png" }   ← remote URL',
    '//   { "image": "id", "src": "./images/{value}.jpg" }      ← sibling dir',
    '//   { "image": "id", "src": "/shared/{value}" }           ← absolute key',
    '//   { "image": "id", "src": "s3://bucket/{value}" }       ← s3:// URI (this storage)',
  ].join('\n')
  return `${banner}\n\n${json}`
}

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
  {
    label: 'Text file',
    snippet: '{ "text": "column_name" }',
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
    () =>
      rules.length > 0
        ? JSON.stringify(rules, null, 2)
        : defaultTemplateFor(columns),
    [rules, columns],
  )
  const [draft, setDraft] = useState(seededDraft)
  // Reseed when the dialog reopens — the saved rules might have changed in
  // another tab, or an earlier session bailed without saving.
  useEffect(() => {
    if (open) setDraft(seededDraft)
  }, [open, seededDraft])

  // Live validation: every keystroke parses + validates. Cheap enough that
  // running on every change is fine (parseRules on a typical config is
  // sub-ms). We accept JSON5 (comments, trailing commas, unquoted keys,
  // single-quoted strings) — strict JSON still parses since JSON5 is a
  // superset. Save canonicalises back to plain JSON before storing in the
  // URL, so the JSON5 conveniences are editor-time helpers only and any
  // comments are lost on save.
  const validation = useMemo<Validation>(() => {
    if (draft.trim().length === 0) {
      return { ok: false, error: 'empty config' }
    }
    let parsed: unknown
    try {
      parsed = JSON5.parse(draft)
    } catch (err) {
      return {
        ok: false,
        error: `invalid JSON5: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const result = parseRules(parsed)
    if (result.error) return { ok: false, error: result.error }
    return { ok: true, rules: result.rules }
  }, [draft])

  const modified = draft !== seededDraft

  // The Editor component renders its own div + pre + textarea; we wrap it in
  // our own div both to hang the border / focus-within styling on and to
  // anchor a ref we can use to locate the underlying textarea (the lib
  // doesn't expose a textarea ref directly).
  const editorWrapperRef = useRef<HTMLDivElement | null>(null)
  const getTextarea = useCallback(
    () => editorWrapperRef.current?.querySelector('textarea') ?? null,
    [],
  )

  const insertAtCursor = useCallback(
    (snippet: string, selectPlaceholder?: string) => {
      const ta = getTextarea()
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
    [draft, getTextarea],
  )

  const handleSave = useCallback(() => {
    if (!validation.ok) return
    onSave(validation.rules)
  }, [validation, onSave])

  const handleFormat = useCallback(() => {
    try {
      // Parse with JSON5 (accept whatever the editor accepts), emit
      // canonical JSON — Format gives the user a preview of what Save
      // will actually persist, so comments / trailing commas / unquoted
      // keys drop here just like on Save.
      const parsed = JSON5.parse(draft)
      setDraft(JSON.stringify(parsed, null, 2))
    } catch {
      // Invalid input can't be formatted — leave the draft alone so the
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
  const [aiPromptOpen, setAiPromptOpen] = useState(false)

  const presets = useRowsPresets()
  // Load a preset by replacing the draft with its serialized canonical form.
  // Goes through the normal `setDraft` path so live validation, the modified
  // dot, and Save behave exactly as if the user typed it.
  const handleLoadPreset = useCallback(
    (preset: Preset) => {
      setDraft(JSON.stringify(preset.rules, null, 2))
    },
    [],
  )

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
          JSON5 array of rule nodes. Sugar accepted: <span className="font-mono">"col"</span> (text atom),{' '}
          <span className="font-mono">{'{ "image": "col" }'}</span> (widget shortcut),{' '}
          <span className="font-mono">{'{ "row": [...] }'}</span> (container).{' '}
          <span className="font-medium text-foreground/80">JSON5</span> means{' '}
          <span className="font-mono">// comments</span>, trailing commas, unquoted keys, and single-quoted
          strings are all valid; Save canonicalises to plain JSON so comments
          are stripped on persist.{' '}
          See <span className="font-mono">docs/parquet_rows_view_user_guide.md</span> for the full reference.
        </p>

        <div className="flex min-h-0 flex-1 gap-3">
          {/* Editor pane */}
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div
              ref={editorWrapperRef}
              className={cn(
                // `json5-editor` scopes the prism token CSS to just this
                // surface (see lib/highlight-json5.css).
                'json5-editor min-h-0 flex-1 overflow-auto rounded-md border border-input bg-transparent font-mono text-xs leading-relaxed',
                'transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
                'dark:bg-input/30',
              )}
            >
              <Editor
                value={draft}
                onValueChange={setDraft}
                highlight={highlightJson5}
                padding={12}
                tabSize={2}
                insertSpaces
                textareaClassName="outline-none"
                className="min-h-full"
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <StatusLine validation={validation} />
          </div>

          {/* Side panel */}
          <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-auto">
            <PresetsSection
              presets={presets}
              currentRules={validation.ok ? validation.rules : null}
              columns={columns}
              onLoad={handleLoadPreset}
            />

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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAiPromptOpen(true)}
          >
            <Sparkles className="size-4" />
            AI prompt
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
      <AiPromptDialog
        open={aiPromptOpen}
        columns={columns}
        onClose={() => setAiPromptOpen(false)}
      />
    </Dialog>
  )
}

// Nested dialog: presents the AI prompt as an editable textarea with one-
// click clipboard copy. Rebuilds the prompt on open so the column list
// reflects whichever file the user is currently viewing.
function AiPromptDialog({
  open,
  columns,
  onClose,
}: {
  open: boolean
  columns: ColumnInfo[]
  onClose: () => void
}) {
  const initial = useMemo(() => buildAiPrompt(columns), [columns])
  const [text, setText] = useState(initial)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (open) {
      setText(initial)
      setCopied(false)
    }
  }, [open, initial])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard API can refuse under insecure contexts / denied perms;
      // a silent no-op is acceptable — the user can still select all + copy.
    }
  }, [text])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex h-[85vh] w-[92vw] max-w-3xl flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            Generate rules with AI
          </DialogTitle>
          <DialogDescription className="text-xs">
            Copy this prompt into ChatGPT / Claude / Gemini. Replace the
            <span className="font-mono"> {'<<<…>>>'} </span>
            placeholder with what you want each card to look like, send,
            then paste the JSON the AI returns into the editor.
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className={cn(
            'min-h-0 flex-1 resize-none rounded-md border border-input bg-transparent p-3 font-mono text-[11px] leading-relaxed',
            'transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
            'dark:bg-input/30',
          )}
        />
        <DialogFooter className="gap-2 sm:gap-2">
          <p className="mr-auto text-[10px] text-muted-foreground">
            Prompt is editable — tweak anything before copying.
          </p>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={handleCopy}>
            {copied ? (
              <>
                <Check className="size-4" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-4" />
                Copy
              </>
            )}
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

// Presets stored in localStorage. Disabled save when the current draft is
// invalid or the name is blank; loading a preset replaces the draft so it
// flows through the same validation + modified-indicator path as typing.
//
// Each preset is annotated with its applicability against the current
// file's columns (rows-applicability.ts). Fully-fitting presets float to
// the top of the list with a green "fits" badge; partial matches show
// `matched/total` in amber so the user can decide whether to load and
// tweak. The applicability signal also drives the per-section summary
// line right above the list.
function PresetsSection({
  presets,
  currentRules,
  columns,
  onLoad,
}: {
  presets: ReturnType<typeof useRowsPresets>
  /// Canonical rules from the current draft, or null when the draft is
  /// invalid (Save is disabled in that case).
  currentRules: Node[] | null
  columns: ColumnInfo[]
  onLoad: (preset: Preset) => void
}) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const canSave = currentRules !== null && trimmed.length > 0

  const handleSave = () => {
    if (!canSave || currentRules === null) return
    const saved = presets.save(trimmed, currentRules)
    if (saved) setName('')
  }

  // Pair each preset with its match status against the open file. Sort
  // fitting presets first, then partials (by matched-column count desc),
  // then unrelated presets — the user's eye lands on what's relevant
  // without us hiding anything.
  const annotated = useMemo(() => {
    const colNames = columns.map((c) => c.name)
    return presets.presets
      .map((preset) => ({ preset, match: presetMatch(preset.rules, colNames) }))
      .sort((a, b) => {
        if (a.match.fits !== b.match.fits) return a.match.fits ? -1 : 1
        if (a.match.matched.size !== b.match.matched.size) {
          return b.match.matched.size - a.match.matched.size
        }
        return b.preset.updatedAt - a.preset.updatedAt
      })
  }, [presets.presets, columns])

  const fittingCount = annotated.filter((a) => a.match.fits).length

  return (
    <Section title={`Presets · ${presets.presets.length}`}>
      <div className="flex gap-1">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSave()
            }
          }}
          placeholder="Preset name"
          aria-label="Preset name"
          className="h-7 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={handleSave}
          disabled={!canSave}
          title={
            currentRules === null
              ? 'Fix validation errors first'
              : trimmed.length === 0
                ? 'Enter a name'
                : 'Save current rules'
          }
        >
          Save
        </Button>
      </div>
      {presets.error && (
        <p className="mt-1 text-[10px] text-destructive">{presets.error}</p>
      )}
      {fittingCount > 0 && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400">
          <Check className="size-3" />
          {fittingCount} preset{fittingCount === 1 ? '' : 's'} fit
          {fittingCount === 1 ? 's' : ''} this file
        </p>
      )}
      {presets.presets.length === 0 ? (
        <p className="mt-2 text-[10px] italic text-muted-foreground">
          No saved presets. Save the current rules to reuse them later.
        </p>
      ) : (
        <ul className="mt-1.5 space-y-0.5">
          {annotated.map(({ preset: p, match }) => (
            <li
              key={p.id}
              className="group flex items-center gap-1 rounded hover:bg-muted"
            >
              <button
                type="button"
                onClick={() => onLoad(p)}
                title={`Load "${p.name}"`}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-xs focus:outline-none"
              >
                <span className="truncate">{p.name}</span>
                <PresetMatchBadge match={match} />
              </button>
              <button
                type="button"
                onClick={() => presets.remove(p.id)}
                title={`Delete "${p.name}"`}
                aria-label={`Delete preset ${p.name}`}
                className="mr-1 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
              >
                <Trash2 className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

// Small per-row indicator. Three buckets keep the visual language tight:
//   * fits     — green check, "fits"            (preset will render cleanly)
//   * partial  — amber count, "N/M"             (some columns won't resolve)
//   * none     — nothing (avoid noise on unrelated presets, but the tooltip
//                still explains *why* it's grey when the user hovers)
function PresetMatchBadge({ match }: { match: PresetMatch }) {
  if (match.referenced.size === 0) return null
  if (match.fits) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-emerald-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300"
        title={`All ${match.matched.size} referenced columns are in this file`}
      >
        <Check className="size-2.5" />
        fits
      </span>
    )
  }
  if (match.matched.size > 0) {
    const missing = [...match.missing].slice(0, 6).join(', ')
    const more =
      match.missing.size > 6 ? `, +${match.missing.size - 6} more` : ''
    return (
      <span
        className="inline-flex shrink-0 items-center rounded-sm bg-amber-500/15 px-1 py-0.5 font-mono text-[9px] font-medium text-amber-700 tabular-nums dark:bg-amber-400/15 dark:text-amber-300"
        title={`Missing columns: ${missing}${more}`}
      >
        {match.matched.size}/{match.referenced.size}
      </span>
    )
  }
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-sm bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
      title={`None of the ${match.referenced.size} referenced column${match.referenced.size === 1 ? '' : 's'} (${[...match.referenced].slice(0, 6).join(', ')}) are in this file`}
    >
      other
    </span>
  )
}

// Cheap check: only run the Format button when JSON5.parse will succeed.
// Avoids enabling the button on a typo and silently dropping the user's
// in-progress edits.
function isFormattableJson(text: string): boolean {
  if (text.trim().length === 0) return false
  try {
    JSON5.parse(text)
    return true
  } catch {
    return false
  }
}

// Encode a column name as a JSON string holding a valid selector. Three
// branches, in order of preference:
//   * Plain identifier — emit bare, no quoting needed.
//   * Backtick-quoted (raw) — preferred for special chars (dots, spaces, …)
//     since it avoids double escaping inside the JSON layer.
//   * Double-quoted (JSON escapes) — required when the name itself contains
//     a backtick, since backtick-quoted selectors are raw and end at the
//     first inner backtick. `JSON.stringify(col)` already produces exactly
//     the double-quoted selector form (JSON escapes are a superset of what
//     the selector accepts), so the outer `JSON.stringify` just escapes it
//     for the embedded JSON layer.
function asJsonString(col: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) return JSON.stringify(col)
  if (col.includes('`')) return JSON.stringify(JSON.stringify(col))
  return JSON.stringify(`\`${col}\``)
}
