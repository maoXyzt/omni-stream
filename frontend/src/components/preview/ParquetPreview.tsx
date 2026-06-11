import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  LayoutList,
  Loader2,
  RotateCw,
} from 'lucide-react'

import { ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useFileStat, useServerInfo } from '@/hooks/use-storage'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type ParquetColumnInfo,
  compressionSummary,
  extractTopLevelColumns,
  loadParquetSource,
  readParquetRows,
  rowGroupCount,
  totalRowCount,
} from '@/lib/parquet'

import { DataTable } from './DataTable'
import { ParquetSqlTab } from './ParquetSqlTab'
import { RowsViewHint } from './RowsViewHint'
import type { PreviewerProps } from './types'

const PAGE_SIZE = 20

const TAB_PARAM = 'tab'
const ROWS_PARAM = 'rows'

type ParquetTab = 'schema' | 'data' | 'sql'

// Session-only cache of the last-active tab. Module-level so it survives
// switching between parquet files in the same page load but resets on
// reload — intentionally not persisted to localStorage. Acts as a soft
// fallback when `?tab=` is absent from the URL.
let lastActiveTab: ParquetTab = 'schema'

function resolveActiveTab(searchParams: URLSearchParams, sqlEnabled: boolean): ParquetTab {
  // Explicit `?tab=…` wins — that's what makes a shared link land exactly
  // where the sender was. Rows view used to be a third tab; legacy links
  // with `?tab=rows` are silently downgraded to schema since the Rows view
  // now lives on its own `/r/...` route entered via the toolbar button.
  // `?tab=sql` is only honoured when sql_enabled; otherwise falls back to
  // schema so the link degrades gracefully on servers without the feature.
  const explicit = searchParams.get(TAB_PARAM)
  if (explicit === 'schema' || explicit === 'data') return explicit
  if (explicit === 'sql' && sqlEnabled) return 'sql'
  return lastActiveTab
}

export function ParquetPreview({ fileKey, src, storage }: PreviewerProps) {
  const [pageIndex, setPageIndex] = useState(0)
  const { data: stat } = useFileStat(fileKey, storage)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { data: serverInfo } = useServerInfo()
  const sqlEnabled = Boolean(serverInfo?.sql_enabled)
  // URL is the source of truth for the active tab so shared links land on
  // the right view and browser Back actually walks tab history. Falls back
  // to session memory / 'schema' when no URL hint is present. The SQL tab
  // requires sql_enabled; ?tab=sql without the feature falls back to schema.
  const activeTab = resolveActiveTab(searchParams, sqlEnabled)

  // Parquet footer / metadata. Immutable per src, so caching forever is
  // safe — keeps repeated visits to the same file footer-fetch-free.
  const sourceQuery = useQuery({
    queryKey: ['parquet-source', src] as const,
    queryFn: () => loadParquetSource(src),
    staleTime: Infinity,
    retry: 1,
  })
  const source = sourceQuery.data
  const metaError = sourceQuery.error

  // Switching files resets pagination; keeps the keepPreviousData hop on
  // the rows query semantically meaningful (it carries previous-page rows
  // across page-index transitions within a file, not across files).
  useEffect(() => {
    setPageIndex(0)
  }, [src])

  const setActiveTab = (next: ParquetTab) => {
    lastActiveTab = next
    setSearchParams(
      (sp) => {
        const params = new URLSearchParams(sp)
        if (next === 'schema') {
          // Schema is the natural default — omit so plain URLs stay clean.
          params.delete(TAB_PARAM)
        } else {
          params.set(TAB_PARAM, next)
        }
        return params
      },
      { replace: true },
    )
  }

  // Jump to the standalone Rows page. Pass through any `?rows=` rules the
  // user already has in the URL so the destination opens with the same
  // ruleset and the modal-to-page transition stays seamless. The file key
  // is encoded segment-by-segment so slashes stay literal in the path.
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

  const columns = useMemo<ParquetColumnInfo[]>(
    () => (source ? extractTopLevelColumns(source.metadata) : []),
    [source],
  )
  const numRows = source ? totalRowCount(source.metadata) : 0
  const pageCount = Math.max(1, Math.ceil(numRows / PAGE_SIZE))
  const clampedPage = Math.min(pageIndex, pageCount - 1)

  // Per-page row read. Re-uses the AsyncBuffer in `source` so hyparquet
  // issues only the Range requests needed for that page's row groups; the
  // footer is never re-downloaded. keepPreviousData keeps the old page's
  // rows on screen while the next page loads, so paginating feels
  // continuous instead of flashing skeletons.
  const rowsQuery = useQuery({
    queryKey: ['parquet-rows', src, clampedPage] as const,
    queryFn: () => {
      if (!source) throw new Error('source not loaded')
      const rowStart = clampedPage * PAGE_SIZE
      const rowEnd = Math.min(rowStart + PAGE_SIZE, numRows)
      return readParquetRows({
        file: source.file,
        metadata: source.metadata,
        rowStart,
        rowEnd,
      })
    },
    enabled: activeTab === 'data' && Boolean(source) && numRows > 0,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  })

  if (metaError) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Alert variant="destructive" className="max-w-xl">
          <AlertCircle className="size-4" />
          <AlertTitle>Failed to read parquet file</AlertTitle>
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
    // Match the post-load layout: InfoBar (a row of stats), tab strip +
    // Browse-as-cards button, then the table body. Sidesteps the layout
    // jump that a generic 3-block skeleton would otherwise produce.
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

  const rows = rowsQuery.data ?? []
  const rowsError = rowsQuery.error
  const rowsFetching = rowsQuery.isFetching
  // Only show the skeleton when there's no page at all yet — keepPreviousData
  // keeps prior rows visible across page-index transitions.
  const rowsFirstLoading = rowsQuery.isPending && rowsFetching

  const codec = compressionSummary(source.metadata)
  const groupCount = rowGroupCount(source.metadata)

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-hidden p-4">
      <RowsViewHint onOpen={openRowsPage} disabled={!storage} />
      <InfoBar
        rows={numRows}
        cols={columns.length}
        groups={groupCount}
        codec={codec}
        size={stat?.size}
      />

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (v === 'schema' || v === 'data' || v === 'sql') setActiveTab(v)
        }}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="schema">Schema</TabsTrigger>
            <TabsTrigger value="data">Data</TabsTrigger>
            {sqlEnabled && <TabsTrigger value="sql">SQL</TabsTrigger>}
          </TabsList>
          {/* Rows view used to be a third tab; it's now a top-level page at
              `/r/<storage>/<file>`. The button takes the user there while
              forwarding any `?rows=` rules already in the URL so the
              transition is seamless. */}
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

        <TabsContent
          value="schema"
          className="min-h-0 flex-1 overflow-auto"
        >
          <SchemaTable columns={columns} />
        </TabsContent>

        <TabsContent
          value="data"
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden"
        >
          <PaginationBar
            pageIndex={clampedPage}
            pageCount={pageCount}
            pageSize={PAGE_SIZE}
            totalRows={numRows}
            loading={rowsFetching}
            onPrev={() => setPageIndex((p) => Math.max(0, p - 1))}
            onNext={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
            onJump={(p) => setPageIndex(p)}
          />
          <p className="text-xs text-muted-foreground">
            Parquet preview limits rows, not bytes. Very large cells or row groups
            may still take time to fetch and decode.
          </p>
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
              pageIndex={clampedPage}
              pageSize={PAGE_SIZE}
            />
          )}
        </TabsContent>

        {sqlEnabled && (
          <TabsContent
            value="sql"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <ParquetSqlTab fileKey={fileKey} storage={storage} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}

interface InfoBarProps {
  rows: number
  cols: number
  groups: number
  codec: string | null
  size?: number
}

function InfoBar({ rows, cols, groups, codec, size }: InfoBarProps) {
  return (
    <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <Stat label="Rows" value={rows.toLocaleString()} />
      <Stat label="Columns" value={cols.toLocaleString()} />
      <Stat label="Row groups" value={groups.toLocaleString()} />
      {codec && <Stat label="Codec" value={codec} mono />}
      {size !== undefined && <Stat label="Size" value={formatBytes(size)} />}
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

interface PaginationBarProps {
  pageIndex: number
  pageCount: number
  pageSize: number
  totalRows: number
  loading: boolean
  onPrev: () => void
  onNext: () => void
  onJump: (pageIndex: number) => void
}

function PaginationBar({
  pageIndex,
  pageCount,
  pageSize,
  totalRows,
  loading,
  onPrev,
  onNext,
  onJump,
}: PaginationBarProps) {
  const firstRow = totalRows === 0 ? 0 : pageIndex * pageSize + 1
  const lastRow = Math.min((pageIndex + 1) * pageSize, totalRows)
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm text-muted-foreground">
        {totalRows === 0
          ? 'Empty file'
          : `Rows ${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${totalRows.toLocaleString()}`}
        {loading && (
          <Loader2 className="ml-2 inline size-4 animate-spin align-[-3px]" />
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={pageIndex === 0 || loading}
        >
          <ChevronLeft className="size-4" />
          Prev
        </Button>
        <PageJumpInput
          pageIndex={pageIndex}
          pageCount={pageCount}
          disabled={loading || pageCount <= 1}
          onJump={onJump}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={pageIndex >= pageCount - 1 || loading}
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}

interface PageJumpInputProps {
  pageIndex: number
  pageCount: number
  disabled: boolean
  onJump: (pageIndex: number) => void
}

// Editable page number: type a 1-based page number and press Enter (or blur)
// to jump. Tracks its own draft state so partial input ("12" while typing
// "120") doesn't fire a jump on every keystroke.
function PageJumpInput({
  pageIndex,
  pageCount,
  disabled,
  onJump,
}: PageJumpInputProps) {
  const [draft, setDraft] = useState(String(pageIndex + 1))

  // Sync external page changes (prev/next clicks, src changes) into the
  // visible draft so the field never lies about the current page.
  useEffect(() => {
    setDraft(String(pageIndex + 1))
  }, [pageIndex])

  const commit = () => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed)) {
      setDraft(String(pageIndex + 1))
      return
    }
    const target = Math.min(pageCount, Math.max(1, parsed)) - 1
    if (target !== pageIndex) {
      onJump(target)
    } else {
      // Snap the draft back if the user typed an out-of-range value that
      // clamped to the page they're already on.
      setDraft(String(pageIndex + 1))
    }
  }

  return (
    <div className="flex items-center gap-1 px-1 text-sm tabular-nums">
      <Input
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(String(pageIndex + 1))
            e.currentTarget.blur()
          }
        }}
        onBlur={commit}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Page number"
        className="h-7 w-14 text-center text-sm"
      />
      <span className="text-muted-foreground">/ {pageCount}</span>
    </div>
  )
}

function SchemaTable({ columns }: { columns: ParquetColumnInfo[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader className="bg-muted/70 [&_tr]:border-b">
          <TableRow>
            <TableHead className="w-48 text-foreground">Name</TableHead>
            <TableHead className="text-foreground">Type</TableHead>
            <TableHead className="w-28 text-foreground">Repetition</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {columns.map((c) => (
            <TableRow key={c.name} className="odd:bg-muted/30">
              <TableCell className="font-mono text-xs align-top text-sky-700 dark:text-sky-300">
                {c.name}
              </TableCell>
              {/* Nested signatures (LIST<STRUCT<...>>) can get long; allow
                  wrapping at type-list boundaries so the table stays usable. */}
              <TableCell className="font-mono text-xs whitespace-normal break-words align-top text-rose-700 dark:text-rose-300">
                {c.type}
              </TableCell>
              <TableCell
                className={cn(
                  'text-xs align-top',
                  c.repetition === 'REQUIRED' && 'text-emerald-700 dark:text-emerald-300',
                  c.repetition === 'OPTIONAL' && 'text-muted-foreground',
                  c.repetition === 'REPEATED' && 'text-violet-700 dark:text-violet-300',
                )}
              >
                {c.repetition}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
