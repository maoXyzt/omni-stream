// SQL query page (/q/:storage) — a DuckDB editor against one storage.
//
// Availability is server-driven: the entry button and this page only work
// when /api/server reports sql_enabled (duckdb build + [sql] enabled + auth
// on). Being able to read that endpoint at all proves the stored bearer
// token is valid, so no extra auth gating is needed here beyond the usual
// 401 → TokenPrompt fallback.
//
// The draft SQL survives navigation via sessionStorage (per storage) — long
// queries don't belong in the URL, and localStorage would leak drafts
// across browser sessions.

import { useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowLeft,
  CornerDownLeft,
  Loader2,
  TriangleAlert,
} from 'lucide-react'
import EditorImport from 'react-simple-code-editor'

import { ApiError } from '@/api/client'
import { executeQuery } from '@/api/query'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TokenPrompt } from '@/components/TokenPrompt'
import { useServerInfo, useStorages } from '@/hooks/use-storage'
import { highlightSql } from '@/lib/highlight-sql'

// Same CJS default-interop unwrap as rows-rules-dialog.tsx — see the
// comment there for why the bare default import arrives double-wrapped.
const Editor =
  (EditorImport as unknown as { default?: typeof EditorImport }).default ??
  EditorImport

const DRAFT_KEY_PREFIX = 'omni-stream:sql:'

// DOM render cap, independent of the server's max_rows (default 10k). A
// 10k×N-column table means hundreds of thousands of DOM nodes — enough to
// freeze the tab. The full result still lives in memory (mutation.data);
// only the table is clipped, with a notice in the status bar.
const RENDER_ROW_CAP = 1000

function loadDraft(storage: string): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY_PREFIX + storage) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(storage: string, sql: string): void {
  try {
    window.sessionStorage.setItem(DRAFT_KEY_PREFIX + storage, sql)
  } catch {
    // ignore: sessionStorage may be unavailable in sandboxed contexts
  }
}

export function SqlPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const params = useParams()
  const storageName = params.storage ?? ''

  const storagesQuery = useStorages()
  const serverQuery = useServerInfo()

  const [sql, setSql] = useState(() => loadDraft(storageName))

  const mutation = useMutation({
    mutationFn: (statement: string) => executeQuery(statement, storageName),
  })

  const storage = storagesQuery.data?.storages.find(
    (s) => s.name === storageName,
  )

  const placeholder = useMemo(() => {
    if (storage?.type === 's3') {
      const bucket = storage.s3?.bucket ?? 'bucket'
      return `SELECT * FROM 's3://${bucket}/path/to/file.parquet' LIMIT 100`
    }
    const root = storage?.local?.root_path ?? '/path/to/root'
    return `SELECT * FROM '${root}/file.parquet' LIMIT 100`
  }, [storage])

  // Typo'd / removed storage bounces to root, same as RowsPage.
  if (
    storagesQuery.data &&
    storageName &&
    !storagesQuery.data.storages.some((s) => s.name === storageName)
  ) {
    return <Navigate to="/" replace />
  }

  const isAuthError =
    (serverQuery.isError &&
      serverQuery.error instanceof ApiError &&
      serverQuery.error.status === 401) ||
    (storagesQuery.isError &&
      storagesQuery.error instanceof ApiError &&
      storagesQuery.error.status === 401)
  if (isAuthError) {
    return (
      <TokenPrompt
        onSubmit={() => {
          queryClient.invalidateQueries()
        }}
      />
    )
  }

  const runnable = sql.trim().length > 0 && !mutation.isPending

  const run = () => {
    if (!runnable) return
    mutation.mutate(sql)
  }

  const result = mutation.data

  return (
    <div className="flex h-screen w-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-6 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/s/${encodeURIComponent(storageName)}/`)}
          aria-label="Back to file browser"
        >
          <ArrowLeft className="size-4" />
          Files
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm">{storageName}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            DuckDB read-only queries · COPY (…) TO exports
          </span>
        </div>
        <span className="shrink-0 rounded-md border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
          SQL
        </span>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
        {serverQuery.data && !serverQuery.data.sql_enabled ? (
          <Alert variant="destructive" className="max-w-xl">
            <AlertCircle className="size-4" />
            <AlertTitle>SQL is disabled on this server</AlertTitle>
            <AlertDescription>
              The server must be built with the duckdb feature and have both
              auth and [sql] enabled in its config.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div
              className="sql-editor max-h-[45%] shrink-0 overflow-auto rounded-md border border-border bg-muted/20 font-mono text-sm"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  run()
                }
              }}
            >
              <Editor
                value={sql}
                onValueChange={(next) => {
                  setSql(next)
                  saveDraft(storageName, next)
                }}
                highlight={highlightSql}
                padding={12}
                placeholder={placeholder}
                textareaClassName="focus:outline-none"
                style={{ minHeight: '8rem' }}
              />
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <Button size="sm" onClick={run} disabled={!runnable}>
                {mutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CornerDownLeft className="size-4" />
                )}
                Run
              </Button>
              <span className="text-xs text-muted-foreground">
                Cmd/Ctrl+Enter to run
              </span>
              {result && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {result.row_count > RENDER_ROW_CAP
                    ? `showing first ${RENDER_ROW_CAP.toLocaleString()} of ${result.row_count.toLocaleString()} rows`
                    : `${result.row_count} rows`}{' '}
                  · {result.elapsed_ms} ms
                </span>
              )}
            </div>

            {result?.truncated && (
              <Alert className="shrink-0 border-amber-500/50 text-amber-600 dark:text-amber-400">
                <TriangleAlert className="size-4" />
                <AlertDescription>
                  Results truncated to {result.row_count} rows by the server's
                  row cap.
                </AlertDescription>
              </Alert>
            )}

            {mutation.error && (
              <Alert variant="destructive" className="shrink-0 overflow-auto">
                <AlertCircle className="size-4" />
                <AlertTitle>Query failed</AlertTitle>
                <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                  {mutation.error.message}
                </AlertDescription>
              </Alert>
            )}

            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
              {result ? (
                result.columns.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    Statement completed with no result set.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {result.columns.map((col, i) => (
                          <TableHead key={`${col.name}-${i}`} className="whitespace-nowrap">
                            <span className="font-medium">{col.name}</span>
                            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                              {col.type}
                            </span>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.rows.slice(0, RENDER_ROW_CAP).map((row, ri) => (
                        <TableRow key={ri}>
                          {row.map((cell, ci) => (
                            <TableCell
                              key={ci}
                              className="max-w-[40ch] truncate font-mono text-xs whitespace-pre"
                              title={cell === null ? undefined : String(cell)}
                            >
                              {cell === null ? (
                                <span className="text-muted-foreground italic">
                                  NULL
                                </span>
                              ) : (
                                String(cell)
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  {mutation.isPending
                    ? 'Running query…'
                    : 'Results will appear here. Query files with read_parquet / read_csv / read_json, or just FROM a file path.'}
                </p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
