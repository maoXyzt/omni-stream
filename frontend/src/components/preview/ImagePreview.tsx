import { useEffect, useRef, useState } from 'react'
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useFileStat } from '@/hooks/use-storage'
import { formatBytes } from '@/lib/format'

import { PreviewSpinner } from './PreviewSpinner'
import type { PreviewerProps } from './types'

type Zoom = 'fit' | number

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.05
const ZOOM_MAX = 16

export function ImagePreview({ fileKey, src, storage }: PreviewerProps) {
  // File metadata for the corner overlay (resolution + size). `meta?.size`
  // is the byte count from `/api/stat`; resolution comes from the image's
  // natural dimensions after `onLoad`. Two independent sources because the
  // image is decoded by the browser, not the backend — we don't have the
  // pixel count until the bytes have actually been rendered.
  const { data: meta } = useFileStat(fileKey, storage)

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

  // Global keydown shortcuts: `+`/`=` to zoom in, `-`/`_` to zoom out. The
  // listener lives only for this component's lifetime, so it's scoped to
  // "while the image preview is open". `=` is the unshifted form of `+` on
  // US/CN keyboards — typing `+` literally requires Shift, so accepting
  // either keeps the shortcut single-stroke. Same trick for `-`/`_`.
  // We skip when modifier keys are held (so the browser's own Ctrl/Cmd-+
  // page zoom still works) and when focus is in an editable element.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        setZoom((z) => clamp(typeof z === 'number' ? z * ZOOM_STEP : ZOOM_STEP))
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setZoom((z) => clamp(typeof z === 'number' ? z / ZOOM_STEP : 1 / ZOOM_STEP))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const isFit = zoom === 'fit'
  const scale = typeof zoom === 'number' ? zoom : null

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setNatural({
      w: e.currentTarget.naturalWidth,
      h: e.currentTarget.naturalHeight,
    })
    setLoaded(true)
  }

  // --- Grab-to-pan -------------------------------------------------------
  //
  // Active only in the scroll wrapper (rendered when `!isFit`); the wrapper
  // already paginates the over-sized image with native scrollbars, so we
  // just translate pointer drag into scroll-position writes. Pointer capture
  // keeps events flowing if the cursor leaves the wrapper mid-drag.
  //
  // Mouse-only on purpose: touch / pen devices already pan via the wrapper's
  // native scroll + pinch, and overriding `touch-action` would break that.
  const dragRef = useRef<{
    startX: number
    startY: number
    scrollLeft: number
    scrollTop: number
  } | null>(null)

  const onPanPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    // Skip clicks that landed on the wrapper element itself — that's the
    // scrollbar. Letting the browser handle scrollbar drags directly is
    // simpler than fighting pointer capture against the native behavior.
    if (e.target === e.currentTarget) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    }
  }

  const onPanPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const el = e.currentTarget
    el.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX)
    el.scrollTop = drag.scrollTop - (e.clientY - drag.startY)
  }

  const onPanPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
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
        // `active:cursor-grabbing` swaps the cursor for the full duration of
        // the drag (CSS `:active` is true between pointerdown and pointerup),
        // so we don't need React state for that. `select-none` prevents the
        // browser from highlighting the image / inner div mid-drag.
        <div
          className="h-full w-full cursor-grab select-none overflow-auto active:cursor-grabbing"
          onPointerDown={onPanPointerDown}
          onPointerMove={onPanPointerMove}
          onPointerUp={onPanPointerUp}
          onPointerCancel={onPanPointerUp}
        >
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={zoomOut} aria-label="Zoom out">
              <ZoomOut className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Zoom out <Kbd>-</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={zoomIn} aria-label="Zoom in">
              <ZoomIn className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Zoom in <Kbd>+</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={isFit ? 'secondary' : 'ghost'}
              size="icon-sm"
              onClick={() => setZoom('fit')}
              aria-label="Fit to window"
            >
              <Maximize className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Fit to window</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={scale === 1 ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setZoom(1)}
              aria-label="Original resolution"
              className="px-2 font-mono text-xs"
            >
              1:1
            </Button>
          </TooltipTrigger>
          <TooltipContent>Original resolution</TooltipContent>
        </Tooltip>
        {/* Only the numeric zoom level lives in the toolbar now — it's a
            property of the toolbar's current state. Fit mode is already
            indicated by the highlighted Maximize button, so showing "Fit"
            here would just duplicate that signal. */}
        {!isFit && (
          <span className="px-1 font-mono text-xs tabular-nums text-muted-foreground">
            {Math.round((scale ?? 1) * 100)}%
          </span>
        )}
      </div>

      {/* Bottom-left metadata overlay — same chrome as the toolbar so the
          two pills feel like a matched pair. Resolution waits on the image
          to load (natural dimensions); file size waits on /api/stat. We
          render either dash when the data isn't ready yet rather than
          gating the whole overlay, so the layout doesn't pop in. */}
      <div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-md border bg-background/90 px-2 py-1 font-mono text-xs text-muted-foreground shadow-sm backdrop-blur supports-backdrop-filter:bg-background/70">
        <span className="tabular-nums">
          {natural ? `${natural.w}×${natural.h}` : '—'}
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular-nums">
          {meta?.size !== undefined ? formatBytes(meta.size) : '—'}
        </span>
      </div>
    </div>
  )
}

// Small keycap badge for shortcut hints inside Tooltip content. Inverse of
// the tooltip surface (`bg-primary-foreground/20` on a `bg-primary` tooltip),
// monospaced for visual alignment with the symbol it wraps.
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1 font-mono text-[10px] leading-none">
      {children}
    </kbd>
  )
}

function clamp(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}
