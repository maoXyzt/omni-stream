// Placeholder pieces shared across widgets. Pulled into its own module so
// lazily-loaded widgets (markdown, highlight) don't have to pull the whole
// rows-widgets bundle just to render their empty state.

import type { ReactNode } from 'react'

import { shortenPath } from '@/lib/format'
import { cn } from '@/lib/utils'

export function EmptyHint({ text }: { text?: string } = {}) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
      {text ?? '(empty)'}
    </div>
  )
}

interface MediaFrameProps {
  /// The resolved storage key or URL to display in the header. Use
  /// `resolution.key ?? resolution.url` from rows-paths so external links
  /// still get a label.
  path: string
  /// Right-aligned slot for per-widget metadata (e.g. line count / byte
  /// progress for the text widget). Omit for image / video / audio where
  /// the media element itself already exposes size / duration controls.
  rightSlot?: ReactNode
  /// Image widgets hug their rendered size (`w-fit`); video / audio fill
  /// the available row width. Default fills.
  fitContent?: boolean
  /// When true, the path label floats over the bottom edge of the
  /// content with a translucent backdrop instead of taking up its own
  /// strip above. Use for `fitContent` widgets (image) so the label can
  /// never push the frame wider than the media — only the media element
  /// determines width, and the label truncates to fit. Bottom placement
  /// reads as a caption and avoids obscuring the subject of most photos.
  overlayHeader?: boolean
  children: ReactNode
}

/// Wraps a media widget in a card with a header strip showing the file
/// path — same visual language the text widget uses, so image / video /
/// audio widgets feel coherent with it. Children control their own
/// content background; the frame contributes border + rounded corners
/// + header divider.
export function MediaFrame({
  path,
  rightSlot,
  fitContent = false,
  overlayHeader = false,
  children,
}: MediaFrameProps) {
  const label = (
    <>
      <span
        className="min-w-0 truncate font-mono"
        title={path}
      >
        {shortenPath(path)}
      </span>
      {rightSlot && <span className="shrink-0">{rightSlot}</span>}
    </>
  )
  return (
    <div
      className={cn(
        'group/media flex flex-col overflow-hidden rounded-md border bg-muted/30',
        overlayHeader && 'relative',
        fitContent ? 'w-fit max-w-full' : 'w-full',
      )}
    >
      {!overlayHeader && (
        <div className="flex items-center justify-between gap-2 border-b bg-background/50 px-2 py-1 text-[11px] text-muted-foreground">
          {label}
        </div>
      )}
      {children}
      {overlayHeader && (
        // `inset-x-0` ties the strip's width to the frame's content box,
        // which (because the strip is out of flow) is sized purely by
        // the in-flow children — i.e. the image. Long paths can never
        // make the card wider than the image itself.
        //
        // Hidden by default and faded in on hover / keyboard focus
        // (`group-hover` on the wrapper above, `focus-within` for
        // tab-keyboard users) so the image stays unobstructed at rest.
        // Title tooltip + drag-select still work once it's visible. The
        // trade-off: clicks on the bottom strip don't open the image
        // lightbox (the rest of the image surface still does).
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-2 border-t border-border/20 bg-background/40 px-2 py-0.5 text-[11px] text-foreground/70 opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover/media:pointer-events-auto group-hover/media:opacity-100 group-focus-within/media:pointer-events-auto group-focus-within/media:opacity-100">
          {label}
        </div>
      )}
    </div>
  )
}
