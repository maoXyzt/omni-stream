import { memo, useState, type ComponentType } from 'react'
import { ImageOff, Link2 } from 'lucide-react'

import { proxyUrl, thumbUrl } from '@/api/storage'
import { EntryContextMenu } from '@/components/EntryContextMenu'
import { Checkbox } from '@/components/ui/checkbox'
import {
  colorForKey,
  dirVisual,
  iconForKey,
  previewableKind,
} from '@/components/preview/registry'
import type { GridFit } from '@/hooks/use-grid-fit'
import { extensionOf } from '@/lib/path'
import { canThumbnail, GRID_THUMB_MIN_BYTES } from '@/lib/thumbnail'
import { getRovingEntryAction } from '@/lib/roving-navigation'
import { cn } from '@/lib/utils'
import type { FileEntry } from '@/types/storage'

interface FileTileProps {
  entry: FileEntry
  prefix: string
  storageName: string
  /// True when the current listing is the root of an S3 multi-bucket
  /// storage. Directory tiles flip to the bucket visual at that depth.
  inBucketRoot: boolean
  fit: GridFit
  onSelect: (entry: FileEntry) => void
  rovingTabIndex: 0 | -1
  /// When provided, the tile shows a checkbox in the top-left corner.
  selectionChecked?: boolean
  onSelectionToggle?: (entry: FileEntry, shiftKey: boolean) => void
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
  inBucketRoot,
  fit,
  onSelect,
  rovingTabIndex,
  selectionChecked,
  onSelectionToggle,
}: FileTileProps) {
  const name = displayName(entry.key, prefix)
  const isImage = !entry.is_dir && previewableKind(entry.key) === 'image'
  const dir = dirVisual(entry.is_dir && inBucketRoot)
  const selectable = !entry.is_dir && onSelectionToggle !== undefined

  return (
    <EntryContextMenu entry={entry} storageName={storageName}>
      {/* Outer div carries `group` so hover/focus effects reach all children.
          `group-has-[:focus-visible]:` (Tailwind v4) fires when any focusable
          descendant — tile button or checkbox — receives keyboard focus, giving
          consistent ring/highlight without requiring the div itself to be
          natively focusable. The checkbox lives here as a sibling to the tile
          button so we avoid nesting two interactive elements. */}
      <div className="group relative flex flex-col gap-1.5 text-left">
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
          tabIndex={rovingTabIndex}
          onKeyDown={(e) => {
            if (
              getRovingEntryAction(
                e.key,
                e.target,
                e.currentTarget,
                selectable,
              ) !== 'select'
            ) {
              return
            }
            e.preventDefault()
            onSelectionToggle?.(entry, e.shiftKey)
          }}
          // Stable data attribute for roving focus navigation — queried by the
          // arrow-key handlers in FileList. Derived purely from `entry.key` so
          // it never causes React.memo to re-render.
          data-roving-key={entry.key}
          className="flex flex-col gap-1.5 text-left focus-visible:outline-none"
        >
          {/* Hover state stacks four cues, each cheap on its own:
                - border tints to primary so the focused tile reads from a glance
                - shadow lifts the tile slightly off the grid background
                - background nudges from muted/40 -> muted (already present)
                - inner image / icon scales 1.05-1.10 inside `overflow-hidden`
              Keyboard focus mirrors hover via `group-has-[:focus-visible]:` so
              tabbing through the grid is just as clear. */}
          <div className={cn(
            'relative aspect-square overflow-hidden rounded-md border bg-muted/40 transition duration-200',
            'group-hover:border-primary/40 group-hover:bg-muted group-hover:shadow-md',
            'group-has-[:focus-visible]:border-primary group-has-[:focus-visible]:ring-2 group-has-[:focus-visible]:ring-primary/30',
            selectionChecked && 'border-primary/60 ring-2 ring-primary/20',
          )}>
            {entry.is_dir ? (
              <IconFill icon={dir.Icon} color={dir.color} />
            ) : isImage ? (
              <ImageContent
                entry={entry}
                storageName={storageName}
                alt={name}
                fit={fit}
              />
            ) : (
              <IconFill
                icon={iconForKey(entry.key)}
                color={colorForKey(entry.key)}
              />
            )}
            {entry.is_symlink && (
              <Link2
                aria-label="symlink"
                className="absolute bottom-1 right-1 size-3.5 rounded-full bg-background stroke-[2.5] text-muted-foreground"
              />
            )}
          </div>
          <div className="truncate px-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground group-has-[:focus-visible]:text-foreground">
            {name}
          </div>
        </button>
        {/* Selection checkbox — top-left overlay, sibling to the tile button so
            no interactive element is nested inside another. Visible on hover,
            focus, or when checked. */}
        {selectable && (
          <div
            className={cn(
              'absolute left-1.5 top-1.5 z-10 transition-opacity duration-150',
              selectionChecked
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100',
              'pointer-coarse:opacity-100',
            )}
            onClick={(e) => {
              e.stopPropagation()
              onSelectionToggle(entry, e.shiftKey)
            }}
          >
            <Checkbox
              checked={selectionChecked ?? false}
              aria-label={`Select ${name}`}
              tabIndex={-1}
              className="before:bg-background/90 before:shadow-sm pointer-coarse:bg-background/90 pointer-coarse:shadow-sm"
            />
          </div>
        )}
      </div>
    </EntryContextMenu>
  )
})

interface ImageContentProps {
  entry: FileEntry
  storageName: string
  alt: string
  fit: GridFit
}

function ImageContent({ entry, storageName, alt, fit }: ImageContentProps) {
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)
  const [usingFallback, setUsingFallback] = useState(false)

  const ext = extensionOf(entry.key)
  const useThumb = canThumbnail(ext) && entry.size > GRID_THUMB_MIN_BYTES
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
        'size-full transition duration-200',
        // Tailwind has no runtime-dynamic `object-${fit}` form — the
        // strings need to be literals so the JIT keeps them. Two states
        // mean a simple ternary suffices.
        fit === 'cover' ? 'object-cover' : 'object-contain',
        loaded ? 'opacity-100' : 'opacity-0',
        // `overflow-hidden` on the parent clips the overflow, so the image
        // zooms within the tile box without changing layout.
        'group-hover:scale-105 group-has-[:focus-visible]:scale-105',
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
      <Icon className="size-10 transition-transform duration-200 group-hover:scale-110 group-has-[:focus-visible]:scale-110" />
    </div>
  )
}

function displayName(key: string, prefix: string): string {
  const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key
  return rel.replace(/\/+$/, '') || key
}
