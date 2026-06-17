// README panel — GitHub-style rendered README shown below the file list when
// the current directory contains a README.md and no file is open. Lazy-loaded
// so Vite splits `marked` + `dompurify` out of the main bundle (same reason
// as `widget-markdown.tsx`).

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, BookOpen, Code2, Loader2, RotateCw } from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { renderMarkdown } from '@/lib/markdown'
import { basenameOf } from '@/lib/path'
import { CHUNK_BYTES, describeFetchError, fetchRange } from '@/lib/text-chunks'

import { markdownProseClass } from './markdown-prose-class'

interface ReadmePanelProps {
  fileKey: string
  storage?: string
  version?: string | null
  onViewSource: () => void
}

export function ReadmePanel({ fileKey, storage, version, onViewSource }: ReadmePanelProps) {
  const src = proxyUrl(fileKey, storage, version)
  const name = basenameOf(fileKey)

  const { data, isPending, isError, isFetching, error, refetch } = useQuery({
    queryKey: ['readme', storage ?? '', fileKey, version ?? ''],
    queryFn: () => fetchRange(src, 0, CHUNK_BYTES - 1),
    // README contents are stable across the session; no need to refetch on
    // window focus. The `version` in the query key already invalidates the
    // cache when the file changes.
    staleTime: 5 * 60 * 1000,
  })

  const body = data?.body ?? ''
  const html = useMemo(() => {
    if (!body) return ''
    // GFM on: README files are authored for GitHub and rely on tables,
    // task-lists, and strikethrough.
    return renderMarkdown(body, { gfm: true })
  }, [body])

  return (
    <div className="mt-6 rounded-lg border">
      {/* Header bar --------------------------------------------------------- */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <BookOpen className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{name}</span>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={onViewSource}
          aria-label="View source"
        >
          <Code2 className="size-3.5" />
          View source
        </Button>
      </div>

      {/* Content area ------------------------------------------------------- */}
      <div className="px-6 py-5">
        {isPending && (
          <div className="space-y-3">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}

        {isError && (
          <Alert variant="destructive" className="max-w-xl">
            <AlertCircle className="size-4" />
            <AlertTitle>Failed to load README</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <span>{describeFetchError(error)}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
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

        {!isPending && !isError && html === '' && (
          <p className="text-sm text-muted-foreground italic">(empty)</p>
        )}

        {html !== '' && (
          <>
            <div
              className={markdownProseClass}
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {/* Truncation notice when the file was too large for the initial chunk */}
            {data && !data.isFull && (
              <p className="mt-4 text-xs text-muted-foreground italic">
                README truncated — file exceeds {Math.round(CHUNK_BYTES / 1024)} KiB.{' '}
                <button
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={onViewSource}
                >
                  Open full source
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default ReadmePanel
