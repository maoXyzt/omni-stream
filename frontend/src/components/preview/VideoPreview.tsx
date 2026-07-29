import { useState } from 'react'
import { CircleAlert, Download, Play, RotateCw } from 'lucide-react'

import { transcodeUrl } from '@/api/storage'
import { Button } from '@/components/ui/button'
import { PreviewLoadError } from './PreviewLoadError'
import { useServerInfo } from '@/hooks/use-storage'
import { PreviewSpinner } from './PreviewSpinner'
import type { PreviewerProps } from './types'
import {
  describeTranscodeFailure,
  describeVideoFailure,
  type VideoFailure,
} from './video-failure'

export function VideoPreview({ fileKey, src, storage }: PreviewerProps) {
  const { data: serverInfo } = useServerInfo()
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<VideoFailure | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [compatible, setCompatible] = useState(false)
  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setLoaded(false)
    setFailure(null)
    setAttempt(0)
    setCompatible(false)
  }
  const baseSrc = compatible ? transcodeUrl(fileKey, storage) : src
  const videoSrc =
    attempt === 0
      ? baseSrc
      : `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}_retry=${attempt}`

  const retry = () => {
    setLoaded(false)
    setFailure(null)
    setAttempt((value) => value + 1)
  }

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
            <div className="flex flex-wrap justify-center gap-2">
              {serverInfo?.transcode_enabled && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setCompatible(true)
                    setLoaded(false)
                    setFailure(null)
                    setAttempt(0)
                  }}
                >
                  <Play className="size-4" />
                  Try compatible playback
                </Button>
              )}
              <Button
                size="sm"
                variant={
                  serverInfo?.transcode_enabled ? 'outline' : 'default'
                }
                asChild
              >
                <a href={src} download>
                  <Download className="size-4" />
                  Download
                </a>
              </Button>
            </div>
          ) : failure.kind === 'transcode' ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" size="sm" onClick={retry}>
                <RotateCw className="size-4" />
                Try again
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={src} download>
                  <Download className="size-4" />
                  Download original
                </a>
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={retry}
            >
              <RotateCw className="size-4" />
              Retry
            </Button>
          )}
        </div>
      ) : (
        <>
          {!loaded && <PreviewSpinner />}
          {compatible && (
            <p
              role="status"
              className="absolute top-3 z-10 rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
            >
              Compatible playback · seeking unavailable
            </p>
          )}
          {/* Native playback uses HTTP Range/206 for seeking. The explicit
              compatibility path is a live fragmented MP4 stream, so it starts
              immediately and does not offer seeking. */}
          <video
            key={`${compatible ? 'compatible' : 'native'}-${attempt}`}
            src={videoSrc}
            controls
            autoPlay={compatible}
            preload={compatible ? 'auto' : 'metadata'}
            onLoadedMetadata={() => setLoaded(true)}
            onError={(event) =>
              setFailure(
                compatible
                  ? describeTranscodeFailure()
                  : describeVideoFailure(event.currentTarget.error?.code),
              )
            }
            className="h-full w-full rounded-md object-contain"
          />
        </>
      )}
    </div>
  )
}
