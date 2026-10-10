import { useState, type ComponentType } from 'react'
import { Download, ExternalLink, TriangleAlert } from 'lucide-react'

import { useFileStat } from '@/hooks/use-storage'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { colorForKey, iconForKey } from './registry'
import { formatBytes, formatTime } from '@/lib/format'
import { basenameOf } from '@/lib/path'

import { isLargePreview } from './large-preview-gate'
import type { PreviewKind, PreviewerProps } from './types'
import type { FileMeta } from '@/types/storage'

interface Props extends PreviewerProps {
  kind: PreviewKind
  size?: number
  previewer: ComponentType<PreviewerProps>
}

interface CardProps extends PreviewerProps {
  kind: PreviewKind
  size?: number
  stat?: FileMeta
  sizeUnavailable: boolean
  onPreview: () => void
}

function LargePreviewCard({
  fileKey,
  src,
  kind,
  size,
  stat,
  sizeUnavailable,
  onPreview,
}: CardProps) {
  const Icon = iconForKey(fileKey)
  const color = colorForKey(fileKey)
  const name = basenameOf(fileKey)
  const previewLabel = kind === 'numpy' ? 'NumPy preview' : '3D preview'

  return (
    <div className="flex h-full w-full flex-col items-center overflow-y-auto p-8">
      <div className="my-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
        <Icon className={`size-24 ${color}`} aria-hidden="true" />
        <div className="space-y-2">
          <h2 className="break-all text-2xl font-medium">{name}</h2>
          <p className="text-sm text-muted-foreground">
            {sizeUnavailable || size === undefined
              ? 'The file size could not be determined.'
              : `This ${kind === 'numpy' ? 'NumPy' : '3D'} file is ${formatBytes(size)}.`}
          </p>
        </div>

        <Alert className="text-left">
          <TriangleAlert />
          <AlertTitle>Preview may use significant browser resources</AlertTitle>
          <AlertDescription>
            Rendering this file can use substantial memory and CPU. Continue only if you are comfortable with the possible impact on this browser tab.
          </AlertDescription>
        </Alert>

        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={onPreview}>{previewLabel}</Button>
          <Button variant="outline" asChild>
            <a href={src} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              Open in new tab
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href={src} download>
              <Download className="size-4" />
              Download
            </a>
          </Button>
        </div>

        <dl className="grid w-full max-w-xl grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-left text-sm">
          <dt className="text-muted-foreground">Path</dt>
          <dd className="break-all font-mono text-xs">{fileKey}</dd>
          <dt className="text-muted-foreground">Size</dt>
          <dd>{size === undefined ? 'Unknown' : `${formatBytes(size)} (${size.toLocaleString()} bytes)`}</dd>
          <dt className="text-muted-foreground">Modified</dt>
          <dd>{formatTime(stat?.last_modified ?? null)}</dd>
          <dt className="text-muted-foreground">Type</dt>
          <dd>{stat?.content_type ?? '—'}</dd>
        </dl>
      </div>
    </div>
  )
}

function isValidFileSize(size: number | undefined): size is number {
  return size !== undefined && Number.isSafeInteger(size) && size >= 0
}

export function LargePreviewGate({
  fileKey,
  src,
  storage,
  size,
  kind,
  previewer: Previewer,
}: Props) {
  const [confirmed, setConfirmed] = useState(false)

  const statQuery = useFileStat(
    fileKey,
    storage,
    size === undefined || isLargePreview(kind, size),
  )
  const effectiveSize = size ?? statQuery.data?.size

  if (
    size === undefined &&
    storage !== undefined &&
    statQuery.isPending &&
    statQuery.isFetching
  ) {
    return <Skeleton className="min-h-0 w-full flex-1 rounded-md" />
  }

  if (confirmed) {
    return <Previewer fileKey={fileKey} src={src} storage={storage} />
  }

  if (size === undefined && statQuery.isError) {
    return (
      <LargePreviewCard
        fileKey={fileKey}
        src={src}
        storage={storage}
        kind={kind}
        size={undefined}
        stat={statQuery.data}
        sizeUnavailable
        onPreview={() => setConfirmed(true)}
      />
    )
  }

  const sizeKnown = isValidFileSize(effectiveSize)
  if (!sizeKnown) {
    return (
      <LargePreviewCard
        fileKey={fileKey}
        src={src}
        storage={storage}
        kind={kind}
        size={undefined}
        stat={statQuery.data}
        sizeUnavailable
        onPreview={() => setConfirmed(true)}
      />
    )
  }

  if (!isLargePreview(kind, effectiveSize)) {
    return <Previewer fileKey={fileKey} src={src} storage={storage} />
  }

  return (
    <LargePreviewCard
      fileKey={fileKey}
      src={src}
      storage={storage}
      kind={kind}
      size={effectiveSize}
      stat={statQuery.data}
      sizeUnavailable={false}
      onPreview={() => setConfirmed(true)}
    />
  )
}
