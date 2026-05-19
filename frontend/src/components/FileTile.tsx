import { memo, useState, type ComponentType } from 'react'
import { Folder, ImageOff } from 'lucide-react'

import { proxyUrl, thumbUrl } from '@/api/storage'
import { EntryContextMenu } from '@/components/EntryContextMenu'
import {
  FOLDER_COLOR,
  colorForKey,
  iconForKey,
  previewableKind,
} from '@/components/preview/registry'
import { cn } from '@/lib/utils'
import type { FileEntry } from '@/types/storage'

// Formats the backend thumbnail pipeline doesn't decode (or doesn't benefit
// from resizing). SVG is its own thumbnail; ICO/AVIF would 415 from the
// server. Skip the round-trip and serve the original directly.
const THUMB_SKIP_EXTS = new Set(['svg', 'ico', 'avif'])

// Below this size, a 320 px WebP thumbnail (~10–15 KB) wouldn't save bandwidth
// vs. the original — small images are already well-compressed. Serve the
// original via proxy instead, avoiding the decode/resize/re-encode cost.
const THUMB_MIN_BYTES = 64 * 1024

interface FileTileProps {
  entry: FileEntry
  prefix: string
  storageName: string
  onSelect: (entry: FileEntry) => void
}

// Memoized: a directory with 10k+ entries renders a tile per row, and the
// only props that ever change per-tile across a filter/sort/render cycle are
// the entry itself (stable reference within a page) and the parent's callback
// (now a useCallback in FileList). Memo + native title attribute together
// drop the dominant cost — 10k Radix Tooltip + 10k ResizeObserver
// subscriptions — to zero.
export const FileTile = memo(function FileTile({
  entry,
  prefix,
  storageName,
  onSelect,
}: FileTileProps) {
  const name = displayName(entry.key, prefix)
  const isImage = !entry.is_dir && previewableKind(entry.key) === 'image'

  return (
    <EntryContextMenu entry={entry} storageName={storageName}>
      <button
        type="button"
        onClick={() => onSelect(entry)}
        // `title` gives us hover-tooltips for the (often) truncated caption
        // without per-tile Radix Tooltip mounts or a ResizeObserver-based
        // overflow check. Browsers only render the tooltip on hover delay, so
        // tiles the user never hovers cost nothing extra. UX trade-off: short
        // names that aren't actually truncated also get a redundant tooltip
        // on long hovers, which is acceptable.
        title={name}
        className="group flex flex-col gap-1.5 text-left focus-visible:outline-none"
      >
        {/* Hover state stacks four cues, each cheap on its own:
              - border tints to primary so the focused tile reads from a glance
              - shadow lifts the tile slightly off the grid background
              - background nudges from muted/40 -> muted (already present)
              - inner image / icon scales 1.05-1.10 inside `overflow-hidden`
            Keyboard focus mirrors hover via `group-focus-visible:` so tabbing
            through the grid is just as clear. */}
        <div className="relative aspect-square overflow-hidden rounded-md border bg-muted/40 transition duration-200 group-hover:border-primary/40 group-hover:bg-muted group-hover:shadow-md group-focus-visible:border-primary group-focus-visible:ring-2 group-focus-visible:ring-primary/30">
          {entry.is_dir ? (
            <IconFill icon={Folder} color={FOLDER_COLOR} />
          ) : isImage ? (
            <ImageContent
              entry={entry}
              storageName={storageName}
              alt={name}
            />
          ) : (
            <IconFill
              icon={iconForKey(entry.key)}
              color={colorForKey(entry.key)}
            />
          )}
        </div>
        <div className="truncate px-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
          {name}
        </div>
      </button>
    </EntryContextMenu>
  )
})

interface ImageContentProps {
  entry: FileEntry
  storageName: string
  alt: string
}

function ImageContent({ entry, storageName, alt }: ImageContentProps) {
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)
  const [usingFallback, setUsingFallback] = useState(false)

  const ext = extensionOf(entry.key)
  const useThumb =
    (!ext || !THUMB_SKIP_EXTS.has(ext)) && entry.size > THUMB_MIN_BYTES
  const src =
    useThumb && !usingFallback
      ? thumbUrl(entry.key, {
          storage: storageName || undefined,
          width: 320,
          version: entry.last_modified,
        })
      : proxyUrl(entry.key, storageName || undefined, entry.last_modified)

  if (errored) return <IconFill icon={ImageOff} />

  function handleError() {
    // First failure on the thumb URL — could be 404 (thumbnails disabled),
    // 415 (server refused this format), or generation error. Retry once with
    // the original via proxy so the grid degrades gracefully.
    if (!usingFallback && useThumb) {
      setUsingFallback(true)
      setLoaded(false)
      return
    }
    setErrored(true)
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={cn(
        // `transition` (everything) instead of `transition-opacity` so the
        // hover-scale below animates alongside the fade-in.
        'size-full object-cover transition duration-200',
        loaded ? 'opacity-100' : 'opacity-0',
        // `overflow-hidden` on the parent clips the overflow, so the image
        // zooms within the tile box without changing layout.
        'group-hover:scale-105 group-focus-visible:scale-105',
      )}
      onLoad={() => setLoaded(true)}
      onError={handleError}
    />
  )
}

function IconFill({
  icon: Icon,
  color = 'text-muted-foreground',
}: {
  icon: ComponentType<{ className?: string }>
  color?: string
}) {
  return (
    <div className={cn('flex size-full items-center justify-center', color)}>
      {/* Icons are smaller than thumbnails so a slightly bigger zoom (1.10
          vs 1.05) reads more clearly on directories / non-image files. */}
      <Icon className="size-10 transition-transform duration-200 group-hover:scale-110 group-focus-visible:scale-110" />
    </div>
  )
}

function displayName(key: string, prefix: string): string {
  const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key
  return rel.replace(/\/+$/, '') || key
}

function extensionOf(key: string): string | null {
  const stripped = key.replace(/\/+$/, '')
  const dot = stripped.lastIndexOf('.')
  if (dot < 0 || dot === stripped.length - 1) return null
  return stripped.slice(dot + 1).toLowerCase()
}
