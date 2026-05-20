// Widget components for the Rows View renderer. Each widget renders a single
// cell value into UI; the renderer wraps them based on the schema node.
//
// All widgets share a small set of placeholder/error UIs so the visual
// language stays consistent: missing data → dashed muted box; broken media →
// icon card; failed render → destructive-tinted hint.
//
// Heavyweight widgets live in their own modules so vite can code-split them
// out of the main bundle: marked + DOMPurify (markdown) and highlight.js
// core + grammars (highlight) only download when those widgets are actually
// rendered. We re-export them as React.lazy here so the dispatch site stays
// uniform; the Suspense boundary is in rows-render.tsx.

import { lazy, useEffect, useMemo, useState } from 'react'
import { ImageOff, LinkIcon, Loader2, MicOff, VideoOff } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { thumbUrl } from '@/api/storage'
import { ImagePreview } from '@/components/preview/ImagePreview'
import { formatCell, formatCellExpanded } from '@/lib/parquet'
import { resolveSrc, type SrcResolution } from '@/lib/rows-paths'
import { cn } from '@/lib/utils'

import { EmptyHint } from './widget-shared'

export { EmptyHint } from './widget-shared'

export interface RenderContext {
  fileKey: string
  storage: string | undefined
}

// -----------------------------------------------------------------------
// Default widget
// -----------------------------------------------------------------------

interface DefaultProps {
  value: unknown
  maxHeight?: string
}

export function WidgetDefault({ value, maxHeight = '18rem' }: DefaultProps) {
  if (value === null || value === undefined || value === '') {
    return <EmptyHint />
  }
  // Primitives use the same frame as composites so widgets remain visually
  // homogeneous; the formatter takes care of one-line vs multi-line.
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value instanceof Date
  ) {
    return (
      <pre
        className="overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words selection:bg-primary/20"
        style={{ maxHeight }}
      >
        {formatCell(value)}
      </pre>
    )
  }
  return (
    <pre
      className="overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words selection:bg-primary/20"
      style={{ maxHeight }}
    >
      {formatCellExpanded(value)}
    </pre>
  )
}

// -----------------------------------------------------------------------
// Lazy widgets: markdown + highlight
// -----------------------------------------------------------------------

export const WidgetMarkdown = lazy(() => import('./widget-markdown'))
export const WidgetHighlight = lazy(() => import('./widget-highlight'))
export const WidgetText = lazy(() => import('./widget-text'))

// -----------------------------------------------------------------------
// Image / video / audio / link — all share the resolveSrc pipeline
// -----------------------------------------------------------------------

interface MediaProps {
  value: unknown
  src: string
  ctx: RenderContext
}

// Width hint passed to the backend thumbnail pipeline. The widget's
// rendered `<img>` is capped at `max-h-96` (~384 px); 640 px serves
// crisp on retina and stays well under the original byte cost for
// typical photos. Same pipeline FileTile uses, just sized for cards
// rather than 1:1 grid squares.
const IMAGE_THUMB_WIDTH = 640
// Formats the backend's thumbnail pipeline either can't decode or
// wouldn't shrink: SVG is its own thumbnail, ICO/AVIF would 415 from the
// server. Match FileTile so behaviour stays consistent across the app.
const IMAGE_THUMB_SKIP_EXTS = new Set(['svg', 'ico', 'avif'])

function shouldThumb(key: string | undefined): boolean {
  if (!key) return false
  const ext = key.replace(/\/+$/, '').split('.').pop()?.toLowerCase()
  return !!ext && !IMAGE_THUMB_SKIP_EXTS.has(ext)
}

export function WidgetImage({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  const url = r.ok ? r.url : ''
  const key = r.ok ? r.key : undefined
  const [failed, setFailed] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  // `everLoaded` keeps the initial render free of a spinner — the
  // very first `<img>` mount has no "previous image" to fade over, so a
  // browser-native load with no overlay reads as cleanest. Once an image
  // has loaded at least once, any later URL change shows the overlay so
  // the user can tell their rules edit took effect even when the new src
  // takes a beat to come down.
  const [everLoaded, setEverLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  // Thumb-first, with fallback to the full proxy URL if the backend
  // can't serve a thumbnail (404 / 415 / generator error). Mirrors
  // FileTile's `usingFallback` flag.
  const [usingFallback, setUsingFallback] = useState(false)
  useEffect(() => {
    setFailed(false)
    setLightboxOpen(false)
    setUsingFallback(false)
    setLoading((prev) => (everLoaded ? true : prev))
    // Intentionally exclude `everLoaded` from deps: it's a one-shot latch
    // that should not retrigger the reset when it flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  if (!r.ok) return <MediaError icon={ImageOff} reason={r.reason} />
  if (failed) {
    return (
      <MediaError
        icon={ImageOff}
        reason="failed to load"
        detail={resolutionDetail(r)}
      />
    )
  }
  // Thumb only when the resolved URL goes through our storage proxy
  // (`r.key` is set) AND the extension is one the thumb pipeline
  // handles. External http(s) URLs and SVG/ICO/AVIF use `r.url`
  // directly.
  const useThumb = shouldThumb(key)
  const displaySrc =
    useThumb && !usingFallback && key !== undefined
      ? thumbUrl(key, { storage: ctx.storage, width: IMAGE_THUMB_WIDTH })
      : r.url
  return (
    <>
      {/* Wrapping the image in a real <button> rather than an onClick <div>
          so keyboard focus, Enter/Space activation, and focus-visible rings
          all come for free. The image keeps cursor-zoom-in to signal what
          clicking will do. `relative` anchors the loading overlay below. */}
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        aria-label="Open image at full size"
        className="relative block w-fit overflow-hidden rounded-md border bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={displaySrc}
          alt={resolutionDetail(r)}
          onLoad={() => {
            setEverLoaded(true)
            setLoading(false)
          }}
          onError={() => {
            // First failure on the thumb URL — swap to the original via
            // proxy. The src change re-fires onLoad / onError; keep
            // `loading` true so the spinner stays up through the swap.
            if (useThumb && !usingFallback) {
              setUsingFallback(true)
              setLoading(true)
              return
            }
            setLoading(false)
            setFailed(true)
          }}
          loading="lazy"
          className={cn(
            'max-h-96 w-auto max-w-full cursor-zoom-in object-contain transition-opacity duration-150',
            loading && 'opacity-40',
          )}
        />
        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-6 animate-spin text-foreground drop-shadow" />
          </div>
        )}
      </button>
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent
          // Full-bleed lightbox: 95vw × 95vh, no padding, no default close
          // button (ImagePreview's zoom toolbar lives at top-right and the
          // default button would collide). Esc and backdrop click both still
          // close via Radix.
          className="flex h-[95vh] w-[95vw] max-w-[95vw] flex-col gap-0 p-0 sm:max-w-[95vw]"
          showCloseButton={false}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Image preview</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1">
            <ImagePreview
              fileKey={r.key ?? ''}
              src={r.url}
              storage={ctx.storage}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function WidgetVideo({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  const url = r.ok ? r.url : ''
  const [failed, setFailed] = useState(false)
  const [everLoaded, setEverLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    setFailed(false)
    setLoading((prev) => (everLoaded ? true : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  if (!r.ok) return <MediaError icon={VideoOff} reason={r.reason} />
  if (failed) {
    return (
      <MediaError
        icon={VideoOff}
        reason="failed to load"
        detail={resolutionDetail(r)}
      />
    )
  }
  return (
    <div className="relative w-full">
      <video
        src={r.url}
        controls
        // `onLoadedData` fires when the first frame is ready to display —
        // earlier than `canplay` but enough that the player is visually
        // "loaded" rather than a black box. Falling back to fading the
        // element so the old frame stays visible during the swap.
        onLoadedData={() => {
          setEverLoaded(true)
          setLoading(false)
        }}
        onError={() => {
          setLoading(false)
          setFailed(true)
        }}
        className={cn(
          'max-h-96 w-full rounded-md border bg-black transition-opacity duration-150',
          loading && 'opacity-40',
        )}
      />
      {loading && (
        // `pointer-events-none` keeps the playback controls clickable
        // through the overlay if the user tries to interact mid-swap.
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-7 animate-spin text-white drop-shadow-md" />
        </div>
      )}
    </div>
  )
}

export function WidgetAudio({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  const url = r.ok ? r.url : ''
  const [failed, setFailed] = useState(false)
  const [everLoaded, setEverLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    setFailed(false)
    setLoading((prev) => (everLoaded ? true : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  if (!r.ok) return <MediaError icon={MicOff} reason={r.reason} />
  if (failed) {
    return (
      <MediaError
        icon={MicOff}
        reason="failed to load"
        detail={resolutionDetail(r)}
      />
    )
  }
  // Audio controls are a horizontal strip — overlaying a spinner over
  // them would block playback. Tuck the spinner inline beside the strip
  // instead so users see motion without losing access to Play/Pause.
  return (
    <div className="flex w-full items-center gap-2">
      <audio
        src={r.url}
        controls
        onLoadedMetadata={() => {
          setEverLoaded(true)
          setLoading(false)
        }}
        onError={() => {
          setLoading(false)
          setFailed(true)
        }}
        className={cn(
          'flex-1 transition-opacity duration-150',
          loading && 'opacity-60',
        )}
      />
      {loading && (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      )}
    </div>
  )
}

export function WidgetLink({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  if (!r.ok) return <MediaError icon={LinkIcon} reason={r.reason} />
  return (
    <a
      href={r.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs underline-offset-2 hover:underline"
    >
      <LinkIcon className="size-3.5 shrink-0" />
      <span className="truncate">{r.url}</span>
    </a>
  )
}

// -----------------------------------------------------------------------
// Shared MediaError card
// -----------------------------------------------------------------------

interface MediaErrorProps {
  icon: typeof ImageOff
  reason: string
  detail?: string
}

function MediaError({ icon: Icon, reason, detail }: MediaErrorProps) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-xs italic text-destructive">
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-all">
        {reason}
        {detail && (
          <>
            : <span className="font-mono not-italic">{detail}</span>
          </>
        )}
      </span>
    </div>
  )
}

function resolutionDetail(r: SrcResolution): string {
  return r.ok ? r.url : ''
}
