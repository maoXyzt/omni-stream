import { useState, type ComponentType } from 'react'
import { Folder, ImageOff } from 'lucide-react'

import { proxyUrl, thumbUrl } from '@/api/storage'
import { iconForKey, previewableKind } from '@/components/preview/registry'
import { cn } from '@/lib/utils'
import type { FileEntry } from '@/types/storage'

// Formats the backend thumbnail pipeline doesn't decode (or doesn't benefit
// from resizing). SVG is its own thumbnail; ICO/AVIF would 415 from the
// server. Skip the round-trip and serve the original directly.
const THUMB_SKIP_EXTS = new Set(['svg', 'ico', 'avif'])

interface FileTileProps {
  entry: FileEntry
  prefix: string
  storageName: string
  onSelect: (entry: FileEntry) => void
}

export function FileTile({ entry, prefix, storageName, onSelect }: FileTileProps) {
  const name = displayName(entry.key, prefix)
  const isImage = !entry.is_dir && previewableKind(entry.key) === 'image'

  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      className="group flex flex-col gap-1.5 text-left"
      title={name}
    >
      <div className="relative aspect-square overflow-hidden rounded-md border bg-muted/40 transition-colors group-hover:bg-muted">
        {entry.is_dir ? (
          <IconFill icon={Folder} />
        ) : isImage ? (
          <ImageContent
            entry={entry}
            storageName={storageName}
            alt={name}
          />
        ) : (
          <IconFill icon={iconForKey(entry.key)} />
        )}
      </div>
      <div className="truncate px-1 text-xs text-muted-foreground">{name}</div>
    </button>
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
  const useThumb = !ext || !THUMB_SKIP_EXTS.has(ext)
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
        'size-full object-cover transition-opacity duration-200',
        loaded ? 'opacity-100' : 'opacity-0',
      )}
      onLoad={() => setLoaded(true)}
      onError={handleError}
    />
  )
}

function IconFill({ icon: Icon }: { icon: ComponentType<{ className?: string }> }) {
  return (
    <div className="flex size-full items-center justify-center text-muted-foreground">
      <Icon className="size-10" />
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
