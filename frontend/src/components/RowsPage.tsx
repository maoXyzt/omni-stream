import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft } from 'lucide-react'

import { ApiError } from '@/api/client'
import { proxyUrl } from '@/api/storage'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TokenPrompt } from '@/components/TokenPrompt'
import { RowsView } from '@/components/preview/RowsView'
import { useStorages } from '@/hooks/use-storage'
import {
  type ParquetSource,
  extractTopLevelColumns,
  loadParquetSource,
  totalRowCount,
} from '@/lib/parquet'

export function RowsPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const params = useParams()
  const storageName = params.storage ?? ''
  // React Router's catch-all `*` is unescaped. Strip leading slashes so the
  // first segment is the file's top-level directory, not an empty string.
  const fileKey = (params['*'] ?? '').replace(/^\/+/, '')

  const storagesQuery = useStorages()
  const src = proxyUrl(fileKey, storageName || undefined)

  const [source, setSource] = useState<ParquetSource | null>(null)
  const [metaError, setMetaError] = useState<ApiError | Error | null>(null)
  // Token guard mirrors `ParquetPreview` — stale loads from an earlier `src`
  // must not splat back into state after the user navigates between files.
  const loadTokenRef = useRef(0)

  useEffect(() => {
    if (!fileKey) return
    const token = ++loadTokenRef.current
    setSource(null)
    setMetaError(null)
    loadParquetSource(src)
      .then((s) => {
        if (loadTokenRef.current === token) setSource(s)
      })
      .catch((err: unknown) => {
        if (loadTokenRef.current !== token) return
        setMetaError(err instanceof ApiError || err instanceof Error ? err : new Error(String(err)))
      })
  }, [src, fileKey])

  // Validate storage exists in the user's roster — typo'd / removed storage
  // bounces to root instead of looping on a perpetual error.
  if (
    storagesQuery.data &&
    storageName &&
    !storagesQuery.data.storages.some((s) => s.name === storageName)
  ) {
    return <Navigate to="/" replace />
  }

  // Missing file path means the URL is malformed (`/r/storage/`). Send the
  // user to the storage's file list rather than rendering a parquet loader
  // pointed at nothing.
  if (!fileKey) {
    return (
      <Navigate
        to={`/s/${encodeURIComponent(storageName)}/`}
        replace
      />
    )
  }

  const isAuthError =
    (metaError instanceof ApiError && metaError.status === 401) ||
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

  const backToBrowser = () => {
    const lastSlash = fileKey.lastIndexOf('/')
    const parentDir = lastSlash >= 0 ? fileKey.slice(0, lastSlash + 1) : ''
    navigate(`/s/${encodeURIComponent(storageName)}/${parentDir}`)
  }

  const fileName = fileKey.split('/').pop() ?? fileKey

  return (
    <div className="flex h-screen w-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-6 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={backToBrowser}
          aria-label="Back to file browser"
        >
          <ArrowLeft className="size-4" />
          Files
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm" title={fileKey}>
            {fileName}
          </span>
          <span className="truncate text-[11px] text-muted-foreground" title={fileKey}>
            {storageName} · {fileKey}
          </span>
        </div>
        <span className="shrink-0 rounded-md border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
          Rows view
        </span>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        {metaError ? (
          <Alert variant="destructive" className="max-w-xl">
            <AlertCircle className="size-4" />
            <AlertTitle>Failed to read parquet file</AlertTitle>
            <AlertDescription>{metaError.message}</AlertDescription>
          </Alert>
        ) : !source ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-72" />
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <RowsView
            fileKey={fileKey}
            source={source}
            columns={extractTopLevelColumns(source.metadata)}
            numRows={totalRowCount(source.metadata)}
            storage={storageName || undefined}
          />
        )}
      </main>
    </div>
  )
}
