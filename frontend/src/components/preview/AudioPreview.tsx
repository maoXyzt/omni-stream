import { useState } from 'react'

import { colorForKey, iconForKey } from '@/components/preview/registry'
import { cn } from '@/lib/utils'

import { PreviewSpinner } from './PreviewSpinner'
import type { PreviewerProps } from './types'

export function AudioPreview({ src, fileKey }: PreviewerProps) {
  const Icon = iconForKey(fileKey)
  const color = colorForKey(fileKey)
  const name = basenameOf(fileKey)

  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setLoaded(false)
    setFailed(false)
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center overflow-y-auto p-8">
      {!loaded && !failed && <PreviewSpinner />}
      <div className="my-auto flex w-full flex-col items-center gap-6">
        <Icon className={cn('size-32', color)} />
        <h2 className="max-w-2xl text-center text-2xl font-medium break-all">
          {name}
        </h2>
        {/* `<audio>` issues HTTP Range requests via `preload="metadata"` to
            fetch duration without downloading the full file. No `autoPlay` —
            playback starts only when the user clicks the native ▶ control. */}
        <audio
          src={src}
          controls
          preload="metadata"
          onLoadedMetadata={() => setLoaded(true)}
          onError={() => {
            setLoaded(true)
            setFailed(true)
          }}
          className="w-full max-w-xl"
        />
        {failed && (
          <p className="text-sm text-destructive">Failed to load audio.</p>
        )}
      </div>
    </div>
  )
}

function basenameOf(key: string): string {
  const stripped = key.replace(/\/+$/, '')
  const slash = stripped.lastIndexOf('/')
  return slash < 0 ? stripped : stripped.slice(slash + 1)
}
