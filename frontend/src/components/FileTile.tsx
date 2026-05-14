import { useState, type ComponentType } from 'react'
import { Folder, ImageOff } from 'lucide-react'

import { proxyUrl, thumbUrl } from '@/api/storage'
import { EntryContextMenu } from '@/components/EntryContextMenu'
import {
  FOLDER_COLOR,
  colorForKey,
  iconForKey,
  previewableKind,
} from '@/components/preview/registry'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useOverflow } from '@/hooks/use-overflow'
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

export function FileTile({ entry, prefix, storageName, onSelect }: FileTileProps) {
  const name = displayName(entry.key, prefix)
  const isImage = !entry.is_dir && previewableKind(entry.key) === 'image'

  // Only show the name-tooltip when the filename is actually clipped by
  // `truncate`. ref attached to the caption div; ResizeObserver re-checks on
  // tile resize, and `name` as a dep re-checks on directory navigation.
  const [nameRef, nameOverflow] = useOverflow<HTMLDivElement>(name)

  return (
    <Tooltip>
      <EntryContextMenu entry={entry} storageName={storageName}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onSelect(entry)}
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
            <div
              ref={nameRef}
              className="truncate px-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground"
            >
              {name}
            </div>
          </button>
        </TooltipTrigger>
      </EntryContextMenu>
      {nameOverflow && (
        <TooltipContent side="bottom" className="max-w-sm break-all">
          {name}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

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
      : proxyUrl(entry.key, storageName || undefined)

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
