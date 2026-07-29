import { useState } from 'react'
import { CircleAlert, Download, RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PreviewLoadError } from './PreviewLoadError'
import { PreviewSpinner } from './PreviewSpinner'
import type { PreviewerProps } from './types'
import { describeVideoFailure, type VideoFailure } from './video-failure'

export function VideoPreview({ src }: PreviewerProps) {
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<VideoFailure | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setLoaded(false)
    setFailure(null)
    setAttempt(0)
  }
  const videoSrc =
    attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}_retry=${attempt}`

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-muted/30 p-2">
      {failure?.kind === 'load' ? (
        <PreviewLoadError
          kind="video"
          onRetry={() => {
            setLoaded(false)
            setFailure(null)
            setAttempt((value) => value + 1)
          }}
        />
      ) : failure ? (
        <div
          role="alert"
          className="flex max-w-md flex-col items-center gap-3 text-center"
        >
          <CircleAlert
            aria-hidden="true"
            className={
              failure.kind === 'unsupported'
                ? 'size-8 text-muted-foreground'
                : 'size-8 text-destructive'
            }
          />
          <div className="space-y-1">
            <p
              className={
                failure.kind === 'unsupported'
                  ? 'text-sm font-medium'
                  : 'text-sm font-medium text-destructive'
              }
            >
              {failure.title}
            </p>
            <p className="text-sm text-muted-foreground">
              {failure.description}
            </p>
          </div>
          {failure.kind === 'unsupported' ? (
            <Button size="sm" asChild>
              <a href={src} download>
                <Download className="size-4" />
                Download
              </a>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setLoaded(false)
                setFailure(null)
                setAttempt((value) => value + 1)
              }}
            >
              <RotateCw className="size-4" />
              Retry
            </Button>
          )}
        </div>
      ) : (
        <>
          {!loaded && <PreviewSpinner />}
          {/* <video> issues HTTP Range requests automatically; the backend returns
              206 with Content-Range, so seeking works without buffering the whole
              file (design.md §6.1). */}
          <video
            key={attempt}
            src={videoSrc}
            controls
            preload="metadata"
            onLoadedMetadata={() => setLoaded(true)}
            onError={(event) =>
              setFailure(describeVideoFailure(event.currentTarget.error?.code))
            }
            className="h-full w-full rounded-md object-contain"
          />
        </>
      )}
    </div>
  )
}
