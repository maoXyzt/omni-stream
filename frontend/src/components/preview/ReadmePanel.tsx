// README panel — GitHub-style rendered README shown below the file list when
// the current directory contains a README.md and no file is open. Lazy-loaded
// so Vite splits `marked` + `dompurify` out of the main bundle (same reason
// as `widget-markdown.tsx`).

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, Code2 } from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { renderMarkdown } from '@/lib/markdown'
import { basenameOf } from '@/lib/path'
import { CHUNK_BYTES, describeFetchError, fetchRange } from '@/lib/text-chunks'
import { cn } from '@/lib/utils'

interface ReadmePanelProps {
  fileKey: string
  storage?: string
  version?: string | null
  onViewSource: () => void
}

export function ReadmePanel({ fileKey, storage, version, onViewSource }: ReadmePanelProps) {
  const src = proxyUrl(fileKey, storage, version)
  const name = basenameOf(fileKey)

  const { data, isPending, isError, error } = useQuery({
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
          aria-label="查看源码"
        >
          <Code2 className="size-3.5" />
          查看源码
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
          <p className="text-sm text-destructive">
            Failed to load README: {describeFetchError(error)}
          </p>
        )}

        {!isPending && !isError && html === '' && (
          <p className="text-sm text-muted-foreground italic">(empty)</p>
        )}

        {html !== '' && (
          <>
            <div
              className={cn(
                'prose-readme text-sm leading-relaxed',
                // Headings
                '[&_h1]:mb-3 [&_h1]:mt-0 [&_h1]:border-b [&_h1]:pb-2 [&_h1]:text-xl [&_h1]:font-semibold',
                '[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-lg [&_h2]:font-semibold',
                '[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold',
                '[&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-sm [&_h4]:font-semibold',
                '[&_h5]:mb-1 [&_h5]:mt-3 [&_h5]:text-sm [&_h5]:font-medium',
                '[&_h6]:mb-1 [&_h6]:mt-3 [&_h6]:text-sm [&_h6]:font-medium [&_h6]:text-muted-foreground',
                // Paragraphs & spacing
                '[&_p]:my-2',
                '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
                // Links
                '[&_a]:text-primary [&_a]:underline-offset-2 [&_a:hover]:underline',
                // Inline code
                '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
                // Code blocks
                '[&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/60 [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-xs',
                '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
                // Lists
                '[&_ul]:my-2 [&_ul]:ml-5 [&_ul]:list-disc [&_ul_ul]:mt-1',
                '[&_ol]:my-2 [&_ol]:ml-5 [&_ol]:list-decimal [&_ol_ol]:mt-1',
                '[&_li]:my-0.5',
                // Blockquote
                '[&_blockquote]:my-2 [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
                // Horizontal rule
                '[&_hr]:my-4 [&_hr]:border-border',
                // Tables (GFM)
                '[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
                '[&_th]:border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium',
                '[&_td]:border [&_td]:px-3 [&_td]:py-1.5',
                // Images
                '[&_img]:max-w-full [&_img]:rounded',
              )}
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
