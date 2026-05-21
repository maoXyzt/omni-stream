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
  children,
}: MediaFrameProps) {
  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-md border bg-muted/30',
        fitContent ? 'w-fit max-w-full' : 'w-full',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b bg-background/50 px-2 py-1 text-[11px]">
        <span
          className="min-w-0 truncate font-mono text-muted-foreground"
          title={path}
        >
          {shortenPath(path)}
        </span>
        {rightSlot && <span className="shrink-0">{rightSlot}</span>}
      </div>
      {children}
    </div>
  )
}
