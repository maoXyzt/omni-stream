import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertCircle, Check, Loader2, RotateCw, Settings2 } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useRowsPresets } from '@/hooks/use-rows-presets'
import { useRowsViewConfig } from '@/hooks/use-rows-view-config'
import { presetMatch } from '@/lib/rows-applicability'
import { type Node } from '@/lib/rows-schema'
import { type ColumnInfo, type RowsSource } from '@/lib/rows-source'
import { PageControls } from '@/components/preview/PageControls'
import { PartialInfoNotice } from '@/components/preview/PartialInfoNotice'
import { RowCard, RowNode } from '@/components/preview/rows-render'
import { RulesDialog } from '@/components/preview/rows-rules-dialog'

const ROWS_PAGE = 20

// URL param name for the current page. 1-indexed in the URL (human-friendly:
// `?page=3` means page 3), 0-indexed internally. Omitted entirely when on
// page 1 so default URLs stay clean.
const PAGE_PARAM = 'page'

function readPageIndex(sp: URLSearchParams): number {
  const raw = sp.get(PAGE_PARAM)
  if (!raw) return 0
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return 0
  return n - 1
}

interface RowsViewProps {
  fileKey: string
  source: RowsSource
  storage?: string
}

export function RowsView({ fileKey, source, storage }: RowsViewProps) {
  const { rules, decodeError, setRules } = useRowsViewConfig()
  const renderCtx = useMemo(() => ({ fileKey, storage }), [fileKey, storage])
  const columns = source.columns
  const [dialogOpen, setDialogOpen] = useState(false)

  // Drop users straight into the rules editor the first time they land on
  // an unconfigured file — the empty cards-view is a dead-end for someone
  // who hasn't seen the feature before. Guarded per-fileKey via a ref so
  // it doesn't re-trigger after the user cancels, clears the rules, or
  // navigates back to the same file. A decode error means the URL had a
  // `rows=` param that failed validation; in that case we surface the
  // banner instead of opening the editor, since auto-opening would
  // suggest the error is dismissed.
  const autoOpenedForFile = useRef<string | null>(null)
  useEffect(() => {
    if (autoOpenedForFile.current === fileKey) return
    autoOpenedForFile.current = fileKey
    if (rules.length === 0 && !decodeError) {
      setDialogOpen(true)
    }
  }, [fileKey, rules.length, decodeError])
  // pageIndex lives in `?page=N` so reloads + shared links land on the
  // same page. Navigating to a different file path drops the param
  // automatically (it's part of the URL, not a hash), so file changes
  // don't need an explicit reset.
  const [searchParams, setSearchParams] = useSearchParams()
  const pageIndex = readPageIndex(searchParams)
  const setPageIndex = useCallback(
    (next: number | ((prev: number) => number)) => {
      setSearchParams(
        (sp) => {
          const params = new URLSearchParams(sp)
          // Read the current value out of the URL rather than closing
          // over `pageIndex` — keeps `setPageIndex(p => p + 1)` correct
          // across rapid back-to-back clicks where the closure would be
          // stale by the second one.
          const current = readPageIndex(params)
          const resolved =
            typeof next === 'function'
              ? (next as (p: number) => number)(current)
              : next
          const target = Math.max(0, resolved)
          if (target === 0) {
            params.delete(PAGE_PARAM)
          } else {
            params.set(PAGE_PARAM, String(target + 1))
          }
          return params
        },
        // Pagination is in-view navigation — the back button should
        // leave the file, not page back through history one step at a
        // time. Same `replace` choice the rules editor makes.
        { replace: true },
      )
    },
    [setSearchParams],
  )
  // Streaming sources surface the row count only through readRows results,
  // not the static `source.totalRows` snapshot. Lock the latest non-null
  // value in here so flipping back to a cached page (whose snapshot might
  // pre-date the count being known) doesn't lose the freshly-learned total.
  const [knownTotal, setKnownTotal] = useState<number | null>(source.totalRows)

  // Reset memoised total when the user opens a different file. pageIndex
  // resets via the URL change so it doesn't need an explicit reset here.
  useEffect(() => {
    setKnownTotal(source.totalRows)
  }, [storage, fileKey, source])

  // Page-scoped query. keepPreviousData smooths transitions: previous
  // cards stay visible while the next page is fetched, no skeleton
  // flicker between pages.
  const rowsQuery = useQuery({
    queryKey: ['rows-data', storage ?? null, fileKey, pageIndex] as const,
    queryFn: () => source.readRows(pageIndex * ROWS_PAGE, (pageIndex + 1) * ROWS_PAGE),
    enabled: source.totalRows !== 0,
    placeholderData: keepPreviousData,
    // Page slices are deterministic for the lifetime of this source —
    // never re-fetch automatically. The cache survives across page
    // navigations so going back to a visited page is instant.
    staleTime: Infinity,
  })

  // Lock in totalRows whenever a read result reveals it.
  useEffect(() => {
    const v = rowsQuery.data?.totalRows
    if (v !== null && v !== undefined) {
      setKnownTotal((prev) => (prev === v ? prev : v))
    }
  }, [rowsQuery.data])

  const page = rowsQuery.data
  const rows = page?.rows ?? []
  const totalRows = knownTotal
  const diagnostics = page?.diagnostics ?? source.diagnostics
  // First-page-in-flight is the only state that warrants the skeleton; a
  // failing fetchNextPage keeps the prior page on screen via
  // keepPreviousData, so we never blank out.
  const firstLoading =
    source.totalRows !== 0 && rowsQuery.isPending && rowsQuery.isFetching
  const isFetching = rowsQuery.isFetching
  const errorMessage = rowsQuery.error ? describeError(rowsQuery.error) : null

  // Page count is `null` while a streaming source hasn't surfaced the
  // total yet — PageControls switches the cap-display to `?` for that.
  const pageCount =
    totalRows !== null ? Math.max(1, Math.ceil(totalRows / ROWS_PAGE)) : null
  // hasMore: the freshest signal is the current page's readRows result. If
  // we have no page yet, fall back to derived state from the known total.
  const hasMore = page
    ? page.hasMore
    : totalRows !== null
      ? (pageIndex + 1) * ROWS_PAGE < totalRows
      : true

  // Snap-back fallback for an URL ?page= that overshoots the actual data
  // (shared link, bookmark, or a streaming source whose stream resolved
  // smaller than the URL anticipated). Wait for the fetch to settle and
  // the total to be known, then redirect to the last valid page and tell
  // the user — silent snap would leave them wondering why their number
  // got rewritten. Mirrors the FileList pager's clamp-on-EOF UX.
  useEffect(() => {
    if (rowsQuery.isFetching) return
    // Streaming source still in flight — readRows hasn't surfaced a
    // total yet. The next page render will re-trigger this effect once
    // the stream drains and totalRows lands in `knownTotal`.
    if (knownTotal === null) return
    if (pageIndex === 0) return
    if (rows.length > 0) return
    const lastPageIndex =
      knownTotal === 0
        ? 0
        : Math.max(0, Math.ceil(knownTotal / ROWS_PAGE) - 1)
    if (pageIndex === lastPageIndex) return
    if (knownTotal === 0) {
      toast.info(`Page ${pageIndex + 1} doesn't exist — file is empty.`)
    } else {
      toast.info(
        `Page ${pageIndex + 1} doesn't exist — showing last page (${lastPageIndex + 1}).`,
      )
    }
    setPageIndex(lastPageIndex)
  }, [rowsQuery.isFetching, knownTotal, rows.length, pageIndex, setPageIndex])

  const retry = () => {
    void rowsQuery.refetch()
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {source.kind !== 'parquet' && <PartialInfoNotice format={source.kind} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
          <span>
            {formatRowRange(pageIndex, ROWS_PAGE, rows.length, totalRows)}
          </span>
          {diagnostics?.skippedLines && diagnostics.skippedLines > 0 && (
            <span
              className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
              title="Lines that didn't parse as a JSON object — most often empty or malformed entries"
            >
              {diagnostics.skippedLines.toLocaleString()} line
              {diagnostics.skippedLines === 1 ? '' : 's'} skipped
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {source.totalRows !== 0 && (
            <PageControls
              pageIndex={pageIndex}
              pageCount={pageCount}
              hasMore={hasMore}
              loading={isFetching}
              onPrev={() => setPageIndex((p) => Math.max(0, p - 1))}
              onNext={() => setPageIndex((p) => p + 1)}
              onJump={(p) => setPageIndex(p)}
            />
          )}
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
          <EmptyState
            columns={columns}
            onOpenRules={() => setDialogOpen(true)}
            onApplyPreset={setRules}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {firstLoading ? (
              <RowSkeletons count={3} ruleCount={rules.length} />
            ) : source.totalRows === 0 ? (
              <div className="rounded-md border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
                Empty file
              </div>
            ) : (
              rows.map((row, i) => {
                // Absolute index keeps the row header label consistent
                // across pages ("row 41" on page 2 rather than restarting
                // at "row 1") and gives stable React keys per-row.
                const absoluteIndex = pageIndex * ROWS_PAGE + i
                return (
                  <RowCard key={absoluteIndex} index={absoluteIndex}>
                    {rules.map((node, j) => (
                      <RowNode key={j} node={node} row={row} ctx={renderCtx} />
                    ))}
                  </RowCard>
                )
              })
            )}
            {errorMessage && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Failed to load rows</AlertTitle>
                <AlertDescription className="flex flex-col gap-3">
                  <span>{errorMessage}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={retry}
                    disabled={isFetching}
                    className="self-start"
                  >
                    {isFetching ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RotateCw className="size-4" />
                    )}
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}
      </div>

      <RulesDialog
        open={dialogOpen}
        rules={rules}
        columns={columns}
        // Live-preview pane in the dialog uses the first row of whatever
        // page the user is currently on — matches the rows they're seeing
        // behind the dialog rather than always anchoring to row 1.
        sampleRow={rows[0]}
        renderCtx={renderCtx}
        onClose={() => setDialogOpen(false)}
        onSave={(next) => {
          setRules(next)
          setDialogOpen(false)
        }}
      />
    </div>
  )
}

interface EmptyStateProps {
  columns: ColumnInfo[]
  onOpenRules: () => void
  onApplyPreset: (rules: Node[]) => void
}

function EmptyState({ columns, onOpenRules, onApplyPreset }: EmptyStateProps) {
  // Read presets at render — useRowsPresets is cheap (localStorage read on
  // mount + cross-tab sync subscription). We only need the cohort that
  // actually fits the file's columns, capped so the empty state stays a
  // single readable card instead of a wall of buttons.
  const presets = useRowsPresets()
  const fittingPresets = useMemo(() => {
    const colNames = columns.map((c) => c.name)
    return presets.presets
      .map((preset) => ({ preset, match: presetMatch(preset.rules, colNames) }))
      .filter((x) => x.match.fits && x.match.referenced.size > 0)
      .slice(0, 6)
  }, [presets.presets, columns])

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-md border bg-muted/30 p-6 text-center">
        <h3 className="text-base font-medium">No rules configured</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Describe how each row should be laid out using the rules editor.
          Rules live in the URL — share the link to share the view.
        </p>
        {fittingPresets.length > 0 && (
          <div className="mt-4 rounded-md border bg-card p-3 text-left">
            <p className="flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <Check className="size-3" />
              {fittingPresets.length} saved preset
              {fittingPresets.length === 1 ? '' : 's'} fit
              {fittingPresets.length === 1 ? 's' : ''} this file
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Click to apply, or open the editor to tweak first.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {fittingPresets.map(({ preset }) => (
                <Button
                  key={preset.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 max-w-full truncate"
                  title={`Apply preset "${preset.name}"`}
                  onClick={() => onApplyPreset(preset.rules)}
                >
                  <span className="truncate">{preset.name}</span>
                </Button>
              ))}
            </div>
          </div>
        )}
        <Button className="mt-4" onClick={onOpenRules}>
          <Settings2 className="size-4" />
          Set up rules
        </Button>
      </div>
    </div>
  )
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

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// Header counter. Three states map to three phrasings:
//   * totalRows = 0           → "Empty file"
//   * totalRows known         → "Rows X–Y of N"
//   * totalRows null (stream) → "Rows X–Y, still streaming…"
function formatRowRange(
  pageIndex: number,
  pageSize: number,
  rowsInPage: number,
  totalRows: number | null,
): string {
  if (totalRows === 0) return 'Empty file'
  const firstRow = pageIndex * pageSize + 1
  const lastRow = pageIndex * pageSize + rowsInPage
  if (lastRow < firstRow) {
    // Page index past the actual data (over-shoot via the jump input).
    return totalRows !== null
      ? `Past end (${totalRows.toLocaleString()} rows total)`
      : '—'
  }
  if (totalRows === null) {
    return `Rows ${firstRow.toLocaleString()}–${lastRow.toLocaleString()}, still streaming…`
  }
  return `Rows ${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${totalRows.toLocaleString()}`
}
