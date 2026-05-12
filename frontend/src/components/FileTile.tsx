import { useState, type ComponentType } from 'react'
import { Folder, ImageOff } from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { iconForKey, previewableKind } from '@/components/preview/registry'
import { cn } from '@/lib/utils'
import type { FileEntry } from '@/types/storage'

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
            src={proxyUrl(entry.key, storageName || undefined)}
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

function ImageContent({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)

  if (errored) return <IconFill icon={ImageOff} />

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
      onError={() => setErrored(true)}
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
