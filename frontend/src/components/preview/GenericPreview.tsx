import { useState } from 'react'
import { FileText } from 'lucide-react'

import { useFileStat } from '@/hooks/use-storage'
import { colorForKey, iconForKey } from '@/components/preview/registry'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes, formatTime } from '@/lib/format'
import { basenameOf } from '@/lib/path'
import { cn } from '@/lib/utils'

import { TextPreview } from './TextPreview'
import type { PreviewerProps } from './types'

export function GenericPreview({ fileKey, src, storage }: PreviewerProps) {
  const [asText, setAsText] = useState(false)
  // PreviewModal reuses one GenericPreview instance across navigations, so
  // without an explicit reset the `asText` choice from file A would carry
  // into file B and silently render it as text. Tracking `src` instead of
  // `fileKey` because `src` already encodes the cache-busting `version`.
  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setAsText(false)
  }
  const Icon = iconForKey(fileKey)
  const color = colorForKey(fileKey)
  const name = basenameOf(fileKey)
  const { data: meta, isPending } = useFileStat(fileKey, storage)

  if (asText) {
    return <TextPreview fileKey={fileKey} src={src} storage={storage} />
  }

  return (
    // Inner `my-auto` wrapper does the vertical centering: in a flex-col
    // parent, auto margins distribute free space evenly, so the group sits
    // mid-height when it fits and falls back to flow-from-top (scrollable)
    // when the content outgrows the viewport. `justify-center` alone would
    // clip the top of the overflowed content; `my-auto` does not.
    <div className="flex h-full w-full flex-col items-center overflow-y-auto p-8">
      <div className="my-auto flex w-full flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-4">
          <Icon className={cn('size-32', color)} />
          <h2 className="max-w-2xl text-center text-2xl font-medium break-all">
            {name}
          </h2>
          <p className="max-w-xl text-center text-sm text-muted-foreground">
            No inline preview for this file type — use{' '}
            <span className="text-foreground">Open in new tab</span> or{' '}
            <span className="text-foreground">Download</span> below, or
            view it as text if the bytes are decodable.
          </p>
          <Button variant="outline" size="sm" onClick={() => setAsText(true)}>
            <FileText className="size-4" />
            View as text
          </Button>
        </div>

        <dl className="grid w-full max-w-xl grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Path</dt>
        <dd className="font-mono text-xs break-all">{fileKey}</dd>

        <dt className="text-muted-foreground">Size</dt>
        <dd>
          {isPending ? (
            <Skeleton className="h-4 w-20" />
          ) : meta?.size !== undefined ? (
            <>
              {formatBytes(meta.size)}{' '}
              <span className="text-muted-foreground">
                ({meta.size.toLocaleString()} bytes)
              </span>
            </>
          ) : (
            '—'
          )}
        </dd>

        <dt className="text-muted-foreground">Type</dt>
        <dd className="font-mono text-xs break-all">
          {isPending ? (
            <Skeleton className="h-4 w-32" />
          ) : (
            (meta?.content_type ?? '—')
          )}
        </dd>

        <dt className="text-muted-foreground">Modified</dt>
        <dd>
          {isPending ? (
            <Skeleton className="h-4 w-40" />
          ) : (
            formatTime(meta?.last_modified ?? null)
          )}
        </dd>

          {!isPending && meta?.etag && (
            <>
              <dt className="text-muted-foreground">ETag</dt>
              <dd className="font-mono text-xs break-all">{meta.etag}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  )
}

