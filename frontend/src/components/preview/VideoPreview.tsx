import { useState } from 'react'

import { PreviewSpinner } from './PreviewSpinner'
import type { PreviewerProps } from './types'

export function VideoPreview({ src }: PreviewerProps) {
  const [loaded, setLoaded] = useState(false)
  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setLoaded(false)
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-muted/30 p-2">
      {!loaded && <PreviewSpinner />}
      {/* <video> issues HTTP Range requests automatically; the backend returns
          206 with Content-Range, so seeking works without buffering the whole
          file (design.md §6.1). */}
      <video
        src={src}
        controls
        preload="metadata"
        onLoadedMetadata={() => setLoaded(true)}
        className="h-full w-full rounded-md object-contain"
      />
    </div>
  )
}
