/// SQL query tab embedded inside the Parquet file preview.
///
/// Prefills `SELECT * FROM '<current file>' LIMIT 100` using the file's
/// storage descriptor to build the correct DuckDB URI (local or S3). The
/// user can edit the SQL freely — any file reachable within the same storage
/// can be queried this way. Results are rendered with the shared DataTable
/// component so they look identical to the Data tab.
///
/// Only shown when `serverInfo.sql_enabled` is true (i.e. the server was
/// built with `--features duckdb` and `auth.enabled = true`).

import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Copy,
  CornerDownLeft,
  Loader2,
  TriangleAlert,
} from 'lucide-react'

import { ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { executeQuery } from '@/api/query'
import { extractErrorDetail } from '@/lib/api-error'
import { useStorages } from '@/hooks/use-storage'
import { highlightSql } from '@/lib/highlight-sql'
import type { StorageDescriptor } from '@/types/storage'
import { TokenPrompt } from '@/components/TokenPrompt'

import { DataTable } from './DataTable'

import EditorImport from 'react-simple-code-editor'

// react-simple-code-editor 0.14.x ships a CJS bundle that sets module.exports
// to the component; ESM interop gives us { default: Component }. Work around
// both bundle shapes so the import resolves in every Vite / Jest environment.
const Editor =
  (EditorImport as unknown as { default?: typeof EditorImport }).default ??
  EditorImport

/// Cap DOM rendering at 1 000 rows; avoids stalling the browser on very wide
/// results while the server already caps the row count via [sql].max_rows.
const RENDER_ROW_CAP = 1000

const DRAFT_KEY_PREFIX = 'omni-stream:sql-draft:'

function loadDraft(key: string): string {
  try { return window.sessionStorage.getItem(key) ?? '' } catch { return '' }
}
function saveDraft(key: string, sql: string): void {
  try { window.sessionStorage.setItem(key, sql) } catch { /* sandboxed context */ }
}

/// Escape single quotes for DuckDB string literals (double them: ' → '').
function sqlEscape(val: string): string {
  return val.replace(/'/g, "''")
}

/// Build the DuckDB-visible file path for the query pre-fill.
/// Mirrors `src/sql/convert.rs::build_uris` logic for the client side.
function fileSqlPath(descriptor: StorageDescriptor, fileKey: string): string {
  const key = sqlEscape(fileKey.replace(/^\/+/, '')) // strip leading slash, escape quotes
  if (descriptor.type === 's3') {
    const bucket = descriptor.s3?.bucket
    if (bucket) {
      // Fixed-bucket storage: prepend the bucket.
      return `'s3://${sqlEscape(bucket)}/${key}'`
    }
    // Multi-bucket storage: key's first path segment IS the bucket name.
    return `'s3://${key}'`
  }
  // Local filesystem storage.
  const root = sqlEscape((descriptor.local?.root_path ?? '').replace(/\/+$/, ''))
  return `'${root}/${key}'`
}

interface Props {
  fileKey: string
  storage?: string
}

export function ParquetSqlTab({ fileKey, storage }: Props) {
  const storagesQuery = useStorages()

  /// Resolve the storage descriptor — used only for building the pre-fill SQL
  /// path. Prefer the explicitly passed storage name; fall back to the server's
  /// default when the prop is absent (e.g. when opened without ?storage= param).
  const descriptor = useMemo(() => {
    const list = storagesQuery.data?.storages
    if (!list) return undefined
    const name = storage ?? storagesQuery.data?.default
    return list.find((s) => s.name === name) ?? list.find((s) => s.valid)
  }, [storagesQuery.data, storage])

  /// The storage name to pass to executeQuery.
  const storageName = storage ?? storagesQuery.data?.default ?? ''

  // sessionStorage key scoped to (storage, file) so drafts don't bleed across
  // files or storages. Uses the `storage` prop directly (always the URL param,
  // available synchronously) rather than the async-resolved storageName.
  const draftKey = `${DRAFT_KEY_PREFIX}${storage ?? 'default'}:${fileKey}`

  const defaultSql = useMemo(() => {
    if (!descriptor) return `SELECT * FROM '<file>' LIMIT 100`
    return `SELECT * FROM ${fileSqlPath(descriptor, fileKey)} LIMIT 100`
  }, [descriptor, fileKey])

  // Initialise from the saved draft so tab switches don't discard in-progress SQL.
  const [sql, setSql] = useState(() => loadDraft(draftKey))

  // Apply the resolved defaultSql whenever the file changes or the storage
  // descriptor finishes loading — but only when no draft is present, so a
  // user's edits are never silently overwritten.
  useEffect(() => {
    if (!loadDraft(draftKey)) setSql(defaultSql)
  }, [draftKey, defaultSql])

  const mutation = useMutation({
    mutationFn: (statement: string) => executeQuery(statement, storageName),
  })

  const result = mutation.data
  const [queryErrMsgCopied, setQueryErrMsgCopied] = useState(false)

  // 401 from the query endpoint — happens in full-lockdown mode (public_read =
  // false) when the user hasn't supplied a bearer token yet.
  const authError =
    mutation.error instanceof ApiError && mutation.error.status === 401

  const runnable = sql.trim().length > 0 && !mutation.isPending

  const run = () => {
    if (!runnable) return
    mutation.mutate(sql)
  }

  // Convert QueryResult rows (row-major 2-D array) to the Record<string,
  // unknown>[] format expected by DataTable. Done here so DataTable stays
  // format-agnostic.
  const tableRows = useMemo(() => {
    if (!result) return []
    return result.rows
      .slice(0, RENDER_ROW_CAP)
      .map((r) =>
        Object.fromEntries(result.columns.map((c, i) => [c.name, r[i] as unknown])),
      )
  }, [result])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div
        className="sql-editor max-h-[35%] shrink-0 overflow-auto rounded-md border border-border bg-muted/20 font-mono text-sm"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            run()
          }
        }}
      >
        <Editor
          value={sql}
          onValueChange={(next) => { setSql(next); saveDraft(draftKey, next) }}
          highlight={highlightSql}
          padding={12}
          placeholder={defaultSql}
          textareaClassName="focus:outline-none"
          style={{ minHeight: '6rem' }}
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
          Cmd/Ctrl+Enter · Query any file in this storage
        </span>
        {result && (
          <span className="ml-auto text-xs text-muted-foreground">
            {result.row_count > RENDER_ROW_CAP
              ? `showing first ${RENDER_ROW_CAP.toLocaleString()} of ${result.row_count.toLocaleString()} rows`
              : `${result.row_count} rows`}
            {' '}· {result.elapsed_ms} ms
          </span>
        )}
      </div>

      {result?.truncated && (
        <Alert className="shrink-0 border-amber-500/50 text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-4" />
          <AlertDescription>
            Results truncated to {result.row_count} rows by the server&apos;s
            row cap.
          </AlertDescription>
        </Alert>
      )}

      {mutation.error && !authError && (() => {
        const detail = extractErrorDetail(mutation.error)
        return (
          <Alert variant="destructive" className="shrink-0 overflow-auto">
            <AlertCircle className="size-4" />
            <AlertTitle>Query failed</AlertTitle>
            <AlertDescription className="space-y-2">
              {/* Verbatim DuckDB / server message — always shown */}
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 font-mono text-xs whitespace-pre-wrap break-words">
                  {detail.message}
                </pre>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mt-0.5 size-6 shrink-0 text-destructive-foreground/70 hover:text-destructive-foreground"
                  onClick={() => {
                    void navigator.clipboard.writeText(detail.message)
                    setQueryErrMsgCopied(true)
                    setTimeout(() => setQueryErrMsgCopied(false), 1500)
                  }}
                  aria-label="Copy error message"
                >
                  {queryErrMsgCopied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </Button>
              </div>
              {/* Actionable hint — only present when the server classified
                  the error as an infrastructure problem (S3, permissions, …) */}
              {detail.hint && (
                <p className="text-xs opacity-80">
                  <span className="font-medium">How to fix: </span>
                  {detail.hint}
                </p>
              )}
            </AlertDescription>
          </Alert>
        )
      })()}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {mutation.isPending ? (
          // Show the table's loading skeleton while a query is running.
          <DataTable
            columns={[]}
            rows={[]}
            loading
            pageIndex={0}
            pageSize={1}
          />
        ) : result ? (
          result.columns.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Statement completed with no result set.
            </p>
          ) : (
            <DataTable
              columns={result.columns}
              rows={tableRows}
              loading={false}
              pageIndex={0}
              pageSize={tableRows.length || 1}
            />
          )
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            Results will appear here. Edit the SQL above and press Run.
          </p>
        )}
      </div>

      {authError && (
        <TokenPrompt
          onSubmit={() => {
            // Token saved; reset error state and retry with the same SQL.
            mutation.reset()
            mutation.mutate(sql)
          }}
          onCancel={() => mutation.reset()}
        />
      )}
    </div>
  )
}
