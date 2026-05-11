import { useState } from 'react'
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { PreviewSpinner } from './PreviewSpinner'
import type { PreviewerProps } from './types'

type Zoom = 'fit' | number

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.05
const ZOOM_MAX = 16

export function ImagePreview({ fileKey, src }: PreviewerProps) {
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  // src can change in place when the user navigates between images. Reset
  // load/natural state during render (React's "adjusting state on prop change"
  // pattern) so the spinner reappears immediately for the new image.
  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setLoaded(false)
    setNatural(null)
  }

  function zoomIn() {
    setZoom((z) =>
      clamp(typeof z === 'number' ? z * ZOOM_STEP : ZOOM_STEP),
    )
  }
  function zoomOut() {
    setZoom((z) =>
      clamp(typeof z === 'number' ? z / ZOOM_STEP : 1 / ZOOM_STEP),
    )
  }

  const isFit = zoom === 'fit'
  const scale = typeof zoom === 'number' ? zoom : null

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setNatural({
      w: e.currentTarget.naturalWidth,
      h: e.currentTarget.naturalHeight,
    })
    setLoaded(true)
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-md bg-muted/30">
      {!loaded && <PreviewSpinner />}
      {isFit ? (
        // Fit mode: no scroll wrapper. The flex container is pinned to the
        // outer box, and the image uses min-h-0/min-w-0 so flex doesn't grant
        // it intrinsic-size overflow that would defeat object-contain.
        <div className="flex h-full w-full items-center justify-center p-2">
          <img
            src={src}
            alt={fileKey}
            onLoad={onLoad}
            className="h-full w-full min-h-0 min-w-0 rounded-md object-contain"
            draggable={false}
          />
        </div>
      ) : (
        <div className="h-full w-full overflow-auto">
          <div className="flex min-h-full min-w-full items-center justify-center p-2">
            <img
              src={src}
              alt={fileKey}
              onLoad={onLoad}
              className="max-w-none rounded-md"
              style={
                scale !== null && natural
                  ? { width: natural.w * scale, height: natural.h * scale }
                  : undefined
              }
              draggable={false}
            />
          </div>
        </div>
      )}

      <div className="absolute top-2 right-2 flex items-center gap-1 rounded-md border bg-background/90 p-1 shadow-sm backdrop-blur supports-backdrop-filter:bg-background/70">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={zoomOut}
          title="Zoom out"
        >
          <ZoomOut className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={zoomIn}
          title="Zoom in"
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button
          variant={isFit ? 'secondary' : 'ghost'}
          size="icon-sm"
          onClick={() => setZoom('fit')}
          title="Fit to window"
        >
          <Maximize className="size-4" />
        </Button>
        <Button
          variant={scale === 1 ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setZoom(1)}
          title="Original resolution"
          className="px-2 font-mono text-xs"
        >
          1:1
        </Button>
        <span className="px-1 font-mono text-xs tabular-nums text-muted-foreground">
          {zoomLabel(zoom, natural)}
        </span>
      </div>
    </div>
  )
}

function clamp(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

function zoomLabel(zoom: Zoom, natural: { w: number; h: number } | null): string {
  if (zoom === 'fit') return natural ? `${natural.w}×${natural.h}` : '…'
  return `${Math.round(zoom * 100)}%`
}
