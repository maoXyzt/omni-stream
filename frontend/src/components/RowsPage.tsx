import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft, Loader2, RotateCw } from 'lucide-react'

import { ApiError } from '@/api/client'
import { proxyUrl } from '@/api/storage'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TokenPrompt } from '@/components/TokenPrompt'
import { RowsView } from '@/components/preview/RowsView'
import { useStorages } from '@/hooks/use-storage'
import { loadRowsSource } from '@/lib/rows-source'

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

  const sourceQuery = useQuery({
    queryKey: ['rows-source', storageName, fileKey] as const,
    queryFn: () => loadRowsSource(src, fileKey),
    enabled: fileKey.length > 0,
    staleTime: 60_000,
    retry: 1,
  })

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
  // user to the storage's file list rather than rendering a data loader
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
    (sourceQuery.error instanceof ApiError && sourceQuery.error.status === 401) ||
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
        {sourceQuery.error ? (
          <Alert variant="destructive" className="max-w-xl">
            <AlertCircle className="size-4" />
            <AlertTitle>Failed to read data file</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <span>{sourceQuery.error.message}</span>
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
        ) : !sourceQuery.data ? (
          // Match the post-load RowsView shape: header strip with metadata
          // + Rules button, then a stack of card-shaped rows. Keeps the
          // transition into the real view visually continuous.
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-64" />
              <Skeleton className="h-9 w-24" />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <RowsView
            fileKey={fileKey}
            source={sourceQuery.data}
            storage={storageName || undefined}
          />
        )}
      </main>
    </div>
  )
}
