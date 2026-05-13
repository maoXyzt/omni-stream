import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ImageOff,
  Loader2,
  Settings2,
} from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  type Rule,
  useRowsViewConfig,
  validateRules,
} from '@/hooks/use-rows-view-config'
import { cn } from '@/lib/utils'
import {
  type ParquetColumnInfo,
  type ParquetSource,
  formatCell,
  readParquetRows,
} from '@/lib/parquet'

const ROWS_PAGE = 20

const EXAMPLE_RULES = `[
  { "column": "prompt", "kind": "text" },
  { "column": "image", "kind": "image", "pathPrefix": "" },
  { "column": "image_edit", "kind": "image", "pathPrefix": "" }
]`

interface RowsViewProps {
  source: ParquetSource
  columns: ParquetColumnInfo[]
  numRows: number
  storage?: string
}

export function RowsView({ source, columns, numRows, storage }: RowsViewProps) {
  const { rules, decodeError, setRules } = useRowsViewConfig()

  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [nextRowStart, setNextRowStart] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Same stale-result-guard trick used by `ParquetPreview` itself: when the
  // user opens a different parquet, abandoned page fetches must not splat
  // their rows back into our state.
  const loadTokenRef = useRef(0)

  useEffect(() => {
    const token = ++loadTokenRef.current
    setRows([])
    setNextRowStart(0)
    setError(null)
    if (numRows === 0) return
    setLoading(true)
    const rowEnd = Math.min(ROWS_PAGE, numRows)
    readParquetRows({
      file: source.file,
      metadata: source.metadata,
      rowStart: 0,
      rowEnd,
    })
      .then((batch) => {
        if (loadTokenRef.current !== token) return
        setRows(batch)
        setNextRowStart(rowEnd)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (loadTokenRef.current !== token) return
        setError(describeError(err))
        setLoading(false)
      })
  }, [source, numRows])

  const columnSet = useMemo(() => new Set(columns.map((c) => c.name)), [columns])

  const hasMore = nextRowStart < numRows

  const loadMore = () => {
    if (loading || !hasMore) return
    const token = ++loadTokenRef.current
    setLoading(true)
    setError(null)
    const rowEnd = Math.min(nextRowStart + ROWS_PAGE, numRows)
    readParquetRows({
      file: source.file,
      metadata: source.metadata,
      rowStart: nextRowStart,
      rowEnd,
    })
      .then((batch) => {
        if (loadTokenRef.current !== token) return
        setRows((prev) => [...prev, ...batch])
        setNextRowStart(rowEnd)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (loadTokenRef.current !== token) return
        setError(describeError(err))
        setLoading(false)
      })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {numRows === 0
            ? 'Empty file'
            : `${rows.length.toLocaleString()} of ${numRows.toLocaleString()} rows loaded`}
        </div>
        <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
          <Settings2 className="size-4" />
          Rules
          {rules.length > 0 && (
            <span className="ml-1 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
              {rules.length}
            </span>
          )}
        </Button>
      </div>

      {decodeError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Couldn't read rules from URL</AlertTitle>
          <AlertDescription>{decodeError}</AlertDescription>
        </Alert>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {rules.length === 0 ? (
          <EmptyState onOpenRules={() => setDialogOpen(true)} />
        ) : (
          <div className="flex flex-col gap-4">
            {loading && rows.length === 0 ? (
              <RowSkeletons count={3} ruleCount={rules.length} />
            ) : (
              rows.map((row, i) => (
                <RowCard
                  key={i}
                  index={i}
                  row={row}
                  rules={rules}
                  columnSet={columnSet}
                  storage={storage}
                />
              ))
            )}
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Failed to load rows</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {rows.length > 0 && hasMore && (
              <div className="flex justify-center pb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMore}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Loading…
                    </>
                  ) : (
                    `Load ${Math.min(ROWS_PAGE, numRows - nextRowStart)} more`
                  )}
                </Button>
              </div>
            )}
            {rows.length > 0 && !hasMore && (
              <div className="pb-4 text-center text-xs text-muted-foreground">
                End of file
              </div>
            )}
          </div>
        )}
      </div>

      <RulesDialog
        open={dialogOpen}
        rules={rules}
        columns={columns}
        onClose={() => setDialogOpen(false)}
        onSave={(next) => {
          setRules(next)
          setDialogOpen(false)
        }}
      />
    </div>
  )
}

function EmptyState({ onOpenRules }: { onOpenRules: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-md border bg-muted/30 p-6 text-center">
        <h3 className="text-base font-medium">No rules configured</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Map columns to widgets to browse rows as cards. Each rule picks a
          column and a display kind (text or image). Rules live in the URL —
          share the link to share the view.
        </p>
        <Button className="mt-4" onClick={onOpenRules}>
          <Settings2 className="size-4" />
          Set up rules
        </Button>
      </div>
    </div>
  )
}

interface RowCardProps {
  index: number
  row: Record<string, unknown>
  rules: Rule[]
  columnSet: Set<string>
  storage?: string
}

function RowCard({ index, row, rules, columnSet, storage }: RowCardProps) {
  return (
    <div className="rounded-md border bg-card">
      <div className="border-b bg-muted/40 px-3 py-1.5 font-mono text-xs text-muted-foreground tabular-nums">
        row {(index + 1).toLocaleString()}
      </div>
      <div className="flex flex-col gap-3 p-3">
        {rules.map((rule, i) => {
          const present = columnSet.has(rule.column)
          return (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {rule.label ?? rule.column}
                </span>
                {rule.label && (
                  <span className="font-mono text-[10px] text-muted-foreground/60">
                    ({rule.column})
                  </span>
                )}
              </div>
              {!present ? (
                <MissingColumnHint column={rule.column} />
              ) : rule.kind === 'text' ? (
                <TextWidget value={row[rule.column]} />
              ) : (
                <ImageWidget
                  value={row[rule.column]}
                  pathPrefix={rule.pathPrefix ?? ''}
                  storage={storage}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MissingColumnHint({ column }: { column: string }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
      column <span className="font-mono">"{column}"</span> not in this file
    </div>
  )
}

function TextWidget({ value }: { value: unknown }) {
  const text = formatCell(value)
  if (text === '') {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
        empty
      </div>
    )
  }
  return (
    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words selection:bg-primary/20">
      {text}
    </pre>
  )
}

interface ImageWidgetProps {
  value: unknown
  pathPrefix: string
  storage?: string
}

function ImageWidget({ value, pathPrefix, storage }: ImageWidgetProps) {
  const [failed, setFailed] = useState(false)
  const path = imagePathFromValue(value)

  // Reset the error flag whenever the resolved URL changes — otherwise a row
  // that recycled a previously-failed cell would stay stuck on the fallback.
  const url = useMemo(() => {
    if (!path) return null
    return proxyUrl(pathPrefix + path, storage)
  }, [path, pathPrefix, storage])

  useEffect(() => {
    setFailed(false)
  }, [url])

  if (!url) {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
        no image path
      </div>
    )
  }
  if (failed) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
        <ImageOff className="size-4" />
        failed to load <span className="font-mono not-italic">{pathPrefix + path}</span>
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-md border bg-muted/30">
      <img
        src={url}
        alt={pathPrefix + path}
        onError={() => setFailed(true)}
        className="max-h-96 w-auto max-w-full object-contain"
        loading="lazy"
      />
    </div>
  )
}

// Pull a usable path out of whatever the cell holds. Parquet image columns
// are typically plain strings, but some pipelines wrap them in `{path: ...}`
// or `{uri: ...}` structs — try a couple of common shapes before giving up.
function imagePathFromValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    for (const key of ['path', 'uri', 'url', 'src']) {
      const candidate = v[key]
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
  }
  return null
}

function RowSkeletons({ count, ruleCount }: { count: number; ruleCount: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-md border bg-card">
          <Skeleton className="h-6 w-32 rounded-none rounded-t-md" />
          <div className="flex flex-col gap-3 p-3">
            {Array.from({ length: ruleCount }).map((__, j) => (
              <Skeleton key={j} className="h-16 w-full" />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

interface RulesDialogProps {
  open: boolean
  rules: Rule[]
  columns: ParquetColumnInfo[]
  onClose: () => void
  onSave: (next: Rule[]) => void
}

function RulesDialog({ open, rules, columns, onClose, onSave }: RulesDialogProps) {
  // Draft text lives only while the dialog is open. We seed it from the
  // current saved rules every time the dialog opens so the textarea always
  // reflects what's actually in the URL, not a stale in-memory edit.
  const initialDraft = useMemo(
    () => (rules.length > 0 ? JSON.stringify(rules, null, 2) : EXAMPLE_RULES),
    [rules],
  )
  const [draft, setDraft] = useState(initialDraft)
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setDraft(initialDraft)
      setValidationError(null)
    }
  }, [open, initialDraft])

  const handleSave = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (err) {
      setValidationError(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const result = validateRules(parsed)
    if (result.error) {
      setValidationError(result.error)
      return
    }
    onSave(result.rules)
  }

  const handleClear = () => {
    onSave([])
  }

  const columnNames = columns.map((c) => c.name).join(', ')

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-2xl gap-3">
        <DialogHeader>
          <DialogTitle>Rows view rules</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          JSON array of rules. Each rule: <span className="font-mono">{'{"column": "...", "kind": "text" | "image", "label"?: "...", "pathPrefix"?: "..."}'}</span>.
          Image cells resolve to <span className="font-mono">pathPrefix + value</span> via the storage proxy.
        </p>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={14}
          className={cn(
            'w-full rounded-md border border-input bg-transparent p-3 font-mono text-xs leading-relaxed',
            'transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
            'dark:bg-input/30',
          )}
        />

        {validationError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Invalid rules</AlertTitle>
            <AlertDescription>{validationError}</AlertDescription>
          </Alert>
        )}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Columns in this file ({columns.length})</summary>
          <div className="mt-1 font-mono break-words text-[11px]">{columnNames || '(none)'}</div>
        </details>

        <DialogFooter>
          {rules.length > 0 && (
            <Button variant="ghost" onClick={handleClear} className="mr-auto">
              Clear rules
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
