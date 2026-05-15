import { useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, RotateCw, Settings2 } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useRowsViewConfig } from '@/hooks/use-rows-view-config'
import { type RowsSource } from '@/lib/rows-source'
import { RowCard, RowNode } from '@/components/preview/rows-render'
import { RulesDialog } from '@/components/preview/rows-rules-dialog'

const ROWS_PAGE = 20

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

  // Paginated read driven by the source's readRows contract. Source is
  // already keyed by (storage, fileKey) upstream, so the same key here
  // gives us a stable cache that survives remounts of this component.
  const rowsQuery = useInfiniteQuery({
    queryKey: ['rows-data', storage ?? null, fileKey] as const,
    queryFn: ({ pageParam }) =>
      source.readRows(pageParam, pageParam + ROWS_PAGE),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.hasMore ? lastPageParam + lastPage.rows.length : undefined,
    enabled: source.totalRows !== 0,
    // Pages are derived from immutable file contents — once loaded they
    // never need to be refetched for the lifetime of this source.
    staleTime: Infinity,
  })

  const pages = useMemo(
    () => rowsQuery.data?.pages ?? [],
    [rowsQuery.data],
  )
  const rows = useMemo(() => pages.flatMap((p) => p.rows), [pages])
  const latestPage = pages.at(-1)
  // Streaming jsonl surfaces totalRows only after the stream completes; fall
  // back to the source's load-time hint until the first page lands.
  const totalRows = latestPage?.totalRows ?? source.totalRows
  const diagnostics = latestPage?.diagnostics ?? source.diagnostics
  const hasMore =
    source.totalRows === 0 ? false : Boolean(rowsQuery.hasNextPage)
  // First-page-in-flight is the only state that warrants the skeleton; a
  // failing fetchNextPage keeps `rows` populated, so we never blank out.
  const firstLoading =
    source.totalRows !== 0 && rowsQuery.isPending && rowsQuery.isFetching
  const loadingMore = rowsQuery.isFetchingNextPage
  const errorMessage = rowsQuery.error ? describeError(rowsQuery.error) : null

  const retry = () => {
    if (rows.length === 0) void rowsQuery.refetch()
    else void rowsQuery.fetchNextPage()
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
          <span>{formatLoadedHint(rows.length, totalRows, hasMore)}</span>
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
            {firstLoading ? (
              <RowSkeletons count={3} ruleCount={rules.length} />
            ) : (
              rows.map((row, i) => (
                <RowCard key={i} index={i}>
                  {rules.map((node, j) => (
                    <RowNode key={j} node={node} row={row} ctx={renderCtx} />
                  ))}
                </RowCard>
              ))
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
                    disabled={rowsQuery.isFetching}
                    className="self-start"
                  >
                    {rowsQuery.isFetching ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RotateCw className="size-4" />
                    )}
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {rows.length > 0 && hasMore && (
              <div className="flex justify-center pb-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void rowsQuery.fetchNextPage()}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Loading…
                    </>
                  ) : (
                    loadMoreLabel(rows.length, totalRows)
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

function EmptyState({ onOpenRules }: { onOpenRules: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-md border bg-muted/30 p-6 text-center">
        <h3 className="text-base font-medium">No rules configured</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Describe how each row should be laid out using the rules editor.
          Rules live in the URL — share the link to share the view.
        </p>
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

// Header counter text. Three states map to three phrasings:
//   * totalRows known, > 0  → "X of N rows loaded"
//   * totalRows null (streaming) + hasMore → "X rows loaded, still streaming…"
//   * totalRows = 0           → "Empty file"
function formatLoadedHint(
  loaded: number,
  totalRows: number | null,
  hasMore: boolean,
): string {
  if (totalRows === 0) return 'Empty file'
  if (totalRows === null) {
    if (hasMore) return `${loaded.toLocaleString()} rows loaded, still streaming…`
    // null totalRows but no more rows = stream resolved empty-ish; treat as
    // loaded but unknown final size
    return `${loaded.toLocaleString()} rows loaded`
  }
  return `${loaded.toLocaleString()} of ${totalRows.toLocaleString()} rows loaded`
}

// "Load N more" button label. When the total is unknown (streaming) we
// can't precompute N — just say "Load more" and let the next batch decide.
function loadMoreLabel(loaded: number, totalRows: number | null): string {
  if (totalRows === null) return 'Load more'
  const remaining = Math.max(0, totalRows - loaded)
  return `Load ${Math.min(20, remaining)} more`
}
