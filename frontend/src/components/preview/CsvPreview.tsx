import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Copy,
  LayoutList,
  Loader2,
  RotateCw,
} from 'lucide-react'

import { ApiError } from '@/api/client'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useFileStat } from '@/hooks/use-storage'
import { csvSeparatorFor } from '@/lib/csv-parser'
import { formatBytes } from '@/lib/format'
import { type ColumnInfo, loadRowsSource } from '@/lib/rows-source'
import { cn } from '@/lib/utils'

import { PageControls } from './PageControls'
import { PartialInfoNotice } from './PartialInfoNotice'
import { RowsViewHint } from './RowsViewHint'
import type { PreviewerProps } from './types'

const PAGE_SIZE = 100
const ROWS_PARAM = 'rows'

export function CsvPreview({ fileKey, src, storage }: PreviewerProps) {
  const [pageIndex, setPageIndex] = useState(0)
  const { data: stat } = useFileStat(fileKey, storage)
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  // Open the streaming source once per file. The CSV stream is mutable
  // (rows grow as ensureRowCount drives it forward), so we want the same
  // instance across page-changes — caching by `src` keeps it stable.
  const sourceQuery = useQuery({
    queryKey: ['csv-source', src] as const,
    queryFn: () => loadRowsSource(src, fileKey),
    staleTime: Infinity,
    retry: 1,
  })
  const source = sourceQuery.data
  const metaError = sourceQuery.error

  // Reset to page 1 whenever the file changes — old `pageIndex` would
  // otherwise leak across separate CSVs opened back-to-back.
  useEffect(() => {
    setPageIndex(0)
  }, [src])

  const openRowsPage = () => {
    if (!storage) return
    const rules = searchParams.get(ROWS_PARAM)
    const trail = fileKey
      .split('/')
      .filter((s) => s.length > 0)
      .map(encodeURIComponent)
      .join('/')
    const query = rules ? `?${ROWS_PARAM}=${rules}` : ''
    navigate(`/r/${encodeURIComponent(storage)}/${trail}${query}`)
  }

  const columns: ColumnInfo[] = source?.columns ?? []

  // Per-page read off the streaming source. `keepPreviousData` smooths the
  // page transitions (previous page stays visible while the next slice is
  // being prepared), so jumping pages doesn't flash skeletons.
  const rowsQuery = useQuery({
    queryKey: ['csv-rows', src, pageIndex] as const,
    queryFn: () => {
      if (!source) throw new Error('source not loaded')
      const rowStart = pageIndex * PAGE_SIZE
      const rowEnd = rowStart + PAGE_SIZE
      return source.readRows(rowStart, rowEnd)
    },
    enabled: Boolean(source),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })

  // Prefetch the next page once the current one resolves. The streaming
  // CSV source surfaces `hasMore` per page, so we only prefetch when the
  // current page promises that more rows follow — past EOF the prefetch
  // would just hit the empty tail. Gated on the current fetch being
  // settled to avoid two concurrent reads against the same stream.
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!source) return
    if (rowsQuery.isPending || rowsQuery.isFetching) return
    if (!rowsQuery.data?.hasMore) return
    const next = pageIndex + 1
    void queryClient.prefetchQuery({
      queryKey: ['csv-rows', src, next] as const,
      queryFn: () => source.readRows(next * PAGE_SIZE, (next + 1) * PAGE_SIZE),
      staleTime: Infinity,
    })
  }, [
    queryClient,
    source,
    src,
    pageIndex,
    rowsQuery.data?.hasMore,
    rowsQuery.isPending,
    rowsQuery.isFetching,
  ])

  if (metaError) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Alert variant="destructive" className="max-w-xl">
          <AlertCircle className="size-4" />
          <AlertTitle>Failed to read CSV file</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>{describeError(metaError)}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void sourceQuery.refetch()}
              disabled={sourceQuery.isFetching}
              className="self-start"
            >
              {sourceQuery.isFetching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCw className="size-4" />
              )}
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!source) {
    // Match the post-load layout: InfoBar strip, controls row, table body.
    // Avoids the layout reflow a generic 3-block skeleton would cause.
    return (
      <div className="flex h-full w-full flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-8 w-36" />
        </div>
        <div className="flex flex-1 flex-col gap-2 overflow-hidden">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    )
  }

  const page = rowsQuery.data
  const rows = (page?.rows as Record<string, unknown>[] | undefined) ?? []
  const totalRows = page?.totalRows ?? source.totalRows
  const skipped = page?.diagnostics?.skippedLines ?? source.diagnostics?.skippedLines
  const rowsError = rowsQuery.error
  const rowsFetching = rowsQuery.isFetching
  const rowsFirstLoading = rowsQuery.isPending && rowsFetching
  // Page count stays null while the stream hasn't reached EOF — that
  // signal flows through to PageControls so its jump input loses the cap
  // and the trailing "/ ?" renders.
  const pageCount =
    totalRows !== null ? Math.max(1, Math.ceil(totalRows / PAGE_SIZE)) : null
  // Latest page reflects the canonical "is there more after this page?"
  // signal — falls back to true while streaming and we haven't read yet.
  const hasMore = page ? page.hasMore : totalRows === null

  const separator = csvSeparatorFor(fileKey)

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-hidden p-4">
      <RowsViewHint onOpen={openRowsPage} disabled={!storage} />
      <PartialInfoNotice format="csv" />
      <InfoBar
        rows={totalRows}
        cols={columns.length}
        size={stat?.size}
        separator={separator}
        skippedLines={skipped}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {formatRowRange(pageIndex, PAGE_SIZE, rows.length, totalRows)}
            {rowsFetching && (
              <Loader2 className="ml-2 inline size-4 animate-spin align-[-3px]" />
            )}
          </span>
          <PageControls
            pageIndex={pageIndex}
            pageCount={pageCount}
            hasMore={hasMore}
            loading={rowsFetching}
            onPrev={() => setPageIndex((p) => Math.max(0, p - 1))}
            onNext={() => setPageIndex((p) => p + 1)}
            onJump={(p) => setPageIndex(p)}
          />
        </div>
        <Button
          size="sm"
          onClick={openRowsPage}
          disabled={!storage}
          className="shadow-sm"
        >
          <LayoutList className="size-4" />
          Browse as cards
        </Button>
      </div>

      {rowsError ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Failed to read rows</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>{describeError(rowsError)}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void rowsQuery.refetch()}
              disabled={rowsFetching}
              className="self-start"
            >
              {rowsFetching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCw className="size-4" />
              )}
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          loading={rowsFirstLoading}
          pageIndex={pageIndex}
          pageSize={PAGE_SIZE}
        />
      )}
    </div>
  )
}

interface InfoBarProps {
  rows: number | null
  cols: number
  size?: number
  separator: string
  skippedLines: number | undefined
}

function InfoBar({ rows, cols, size, separator, skippedLines }: InfoBarProps) {
  return (
    <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <Stat
        label="Rows"
        value={rows === null ? 'streaming…' : rows.toLocaleString()}
      />
      <Stat label="Columns" value={cols.toLocaleString()} />
      <Stat
        label="Separator"
        value={separator === '\t' ? 'TAB' : separator}
        mono
      />
      {size !== undefined && <Stat label="Size" value={formatBytes(size)} />}
      {skippedLines !== undefined && skippedLines > 0 && (
        <span
          className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
          title="Malformed quoting situations encountered (e.g. junk after a closing quote)."
        >
          {skippedLines.toLocaleString()} quoting issue
          {skippedLines === 1 ? '' : 's'}
        </span>
      )}
    </dl>
  )
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </div>
  )
}

// Status text alongside PageControls. Three shapes:
//   * "Empty file"
//   * "Rows X–Y of N"                  (totalRows known)
//   * "Rows X–Y, still streaming…"    (totalRows null, stream in flight)
function formatRowRange(
  pageIndex: number,
  pageSize: number,
  rowsInPage: number,
  totalRows: number | null,
): string {
  if (totalRows === 0) return 'Empty file'
  const firstRow = pageIndex * pageSize + 1
  const lastRow = pageIndex * pageSize + rowsInPage
  if (lastRow < firstRow) return '—'
  if (totalRows === null) {
    return `Rows ${firstRow.toLocaleString()}–${lastRow.toLocaleString()}, still streaming…`
  }
  return `Rows ${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${totalRows.toLocaleString()}`
}

interface DataTableProps {
  columns: ColumnInfo[]
  rows: Record<string, unknown>[]
  loading: boolean
  /// Zero-based page index. Combined with `pageSize` so the row counter,
  /// React keys, and the cell-expansion dialog all reference the row's
  /// position in the full file rather than its position within this page.
  pageIndex: number
  pageSize: number
}

interface ExpandedCell {
  rowIndex: number
  column: string
  text: string
}

function DataTable({ columns, rows, loading, pageIndex, pageSize }: DataTableProps) {
  // Single dialog at the table level handles cell expansion for every cell
  // (vs. one Dialog per cell, which would be thousands of unmounted
  // dialogs).
  const [expanded, setExpanded] = useState<ExpandedCell | null>(null)

  if (loading) {
    return (
      <div className="flex-1 space-y-2 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    )
  }
  if (columns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No columns detected — file may be empty.
      </div>
    )
  }
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <Table className="font-mono text-xs">
          <TableHeader className="sticky top-0 z-10 bg-muted/70 backdrop-blur-sm shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-0">
            <TableRow>
              <TableHead className="w-12 text-right align-bottom text-muted-foreground">
                #
              </TableHead>
              {columns.map((c) => (
                <TableHead
                  key={c.name}
                  className="max-w-xs py-2 align-bottom text-foreground"
                >
                  <span className="break-all">{c.name}</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => {
              // Absolute index keeps row numbering ("row 101" on page 2,
              // not restarting at 1), gives stable React keys across
              // paginations, and lets the cell-expansion dialog report
              // the row's actual position in the file.
              const absoluteIndex = pageIndex * pageSize + i
              return (
                <TableRow key={absoluteIndex} className="odd:bg-muted/30">
                  <TableCell className="bg-muted/40 text-right align-top text-muted-foreground tabular-nums">
                    {absoluteIndex + 1}
                  </TableCell>
                  {columns.map((c) => {
                    const value = row[c.name]
                    const text =
                      typeof value === 'string' ? value : String(value ?? '')
                    return (
                      <DataCell
                        key={c.name}
                        text={text}
                        onExpand={() =>
                          setExpanded({
                            rowIndex: absoluteIndex,
                            column: c.name,
                            text,
                          })
                        }
                      />
                    )
                  })}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <CellValueDialog
        cell={expanded}
        onClose={() => setExpanded(null)}
      />
    </>
  )
}

// Cells longer than this gain a click-to-expand affordance. Smaller than
// the parquet one because CSVs tend to be wider with shorter strings, and
// keeping more text inline avoids excessive clicks.
const LONG_VALUE_CHARS = 40
const TOOLTIP_PREVIEW_CAP = 2000

interface DataCellProps {
  text: string
  onExpand: () => void
}

function DataCell({ text, onExpand }: DataCellProps) {
  const isLong = text.length > LONG_VALUE_CHARS || text.includes('\n')
  const isEmpty = text.length === 0
  if (!isLong) {
    return (
      <TableCell className="max-w-xs align-top">
        <span
          className={cn(
            'block whitespace-pre-wrap break-words line-clamp-5',
            isEmpty && 'italic text-muted-foreground',
          )}
        >
          {isEmpty ? '∅' : text}
        </span>
      </TableCell>
    )
  }
  const tooltipText =
    text.length > TOOLTIP_PREVIEW_CAP
      ? `${text.slice(0, TOOLTIP_PREVIEW_CAP)}\n…(click cell to see all ${text.length.toLocaleString()} chars)`
      : text
  return (
    <TableCell className="max-w-xs p-0 align-top">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={onExpand}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onExpand()
              }
            }}
            className="block w-full cursor-pointer whitespace-pre-wrap break-words line-clamp-5 px-2 py-2 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          >
            {text}
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="bg-popover text-popover-foreground max-h-[60vh] max-w-2xl overflow-hidden whitespace-pre-wrap break-words border font-mono text-xs"
        >
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TableCell>
  )
}

interface CellValueDialogProps {
  cell: ExpandedCell | null
  onClose: () => void
}

function CellValueDialog({ cell, onClose }: CellValueDialogProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!cell) setCopied(false)
  }, [cell])

  const handleCopy = async () => {
    if (!cell) return
    try {
      await navigator.clipboard.writeText(cell.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write may fail in insecure contexts / under denied
      // permissions; silently no-op.
    }
  }

  return (
    <Dialog open={cell !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-3xl gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            <span className="font-mono text-sm">{cell?.column}</span>
            {cell && (
              <span className="text-xs font-normal text-muted-foreground">
                row {cell.rowIndex + 1} · {cell.text.length.toLocaleString()} chars
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words selection:bg-primary/20">
          {cell?.text}
        </pre>
        <DialogFooter showCloseButton>
          <Button variant="outline" onClick={handleCopy} aria-live="polite">
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

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

// Used by registry — keep the named export *and* the default for symmetry
// with the other previewers.
export default CsvPreview
