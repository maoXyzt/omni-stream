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
import { ImageOff, LinkIcon, MicOff, VideoOff } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ImagePreview } from '@/components/preview/ImagePreview'
import { formatCell, formatCellExpanded } from '@/lib/parquet'
import { resolveSrc, type SrcResolution } from '@/lib/rows-paths'

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

// -----------------------------------------------------------------------
// Image / video / audio / link — all share the resolveSrc pipeline
// -----------------------------------------------------------------------

interface MediaProps {
  value: unknown
  src: string
  ctx: RenderContext
}

export function WidgetImage({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  const url = r.ok ? r.url : ''
  const [failed, setFailed] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  // Reset both flags whenever the resolved URL changes — a recycled cell
  // shouldn't stay stuck on the previous image's error / lightbox state.
  useEffect(() => {
    setFailed(false)
    setLightboxOpen(false)
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
  return (
    <>
      {/* Wrapping the image in a real <button> rather than an onClick <div>
          so keyboard focus, Enter/Space activation, and focus-visible rings
          all come for free. The image keeps cursor-zoom-in to signal what
          clicking will do. */}
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        aria-label="Open image at full size"
        className="block w-fit overflow-hidden rounded-md border bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={r.url}
          alt={resolutionDetail(r)}
          onError={() => setFailed(true)}
          loading="lazy"
          className="max-h-96 w-auto max-w-full cursor-zoom-in object-contain"
        />
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
  useEffect(() => setFailed(false), [url])

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
    <video
      src={r.url}
      controls
      onError={() => setFailed(true)}
      className="max-h-96 w-full rounded-md border bg-black"
    />
  )
}

export function WidgetAudio({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  const url = r.ok ? r.url : ''
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])

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
  return (
    <audio
      src={r.url}
      controls
      onError={() => setFailed(true)}
      className="w-full"
    />
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
