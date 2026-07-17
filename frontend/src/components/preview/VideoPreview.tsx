import { useState } from 'react'
import { RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PreviewSpinner } from './PreviewSpinner'
import type { PreviewerProps } from './types'

export function VideoPreview({ src }: PreviewerProps) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setLoaded(false)
    setFailed(false)
    setAttempt(0)
  }
  const videoSrc =
    attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}_retry=${attempt}`

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-muted/30 p-2">
      {failed ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 text-center"
        >
          <p className="text-sm font-medium text-destructive">
            Failed to load video.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLoaded(false)
              setFailed(false)
              setAttempt((value) => value + 1)
            }}
          >
            <RotateCw className="size-4" />
            Retry
          </Button>
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
            onError={() => setFailed(true)}
            className="h-full w-full rounded-md object-contain"
          />
        </>
      )}
    </div>
  )
}
