import { useFileStat } from '@/hooks/use-storage'
import { colorForKey, iconForKey } from '@/components/preview/registry'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { PreviewerProps } from './types'

export function GenericPreview({ fileKey, storage }: PreviewerProps) {
  const Icon = iconForKey(fileKey)
  const color = colorForKey(fileKey)
  const name = basenameOf(fileKey)
  const { data: meta, isPending } = useFileStat(fileKey, storage)

  return (
    <div className="flex h-full w-full flex-col items-center gap-6 overflow-y-auto p-8">
      <div className="flex flex-col items-center gap-4 pt-8">
        <Icon className={cn('size-32', color)} />
        <h2 className="max-w-2xl text-center text-2xl font-medium break-all">
          {name}
        </h2>
        <p className="max-w-xl text-center text-sm text-muted-foreground">
          No inline preview for this file type — use{' '}
          <span className="text-foreground">Open in new tab</span> or{' '}
          <span className="text-foreground">Download</span> below.
        </p>
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
  )
}

function basenameOf(key: string): string {
  const stripped = key.replace(/\/+$/, '')
  const slash = stripped.lastIndexOf('/')
  return slash < 0 ? stripped : stripped.slice(slash + 1)
}
