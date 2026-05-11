import { Database } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { StorageDescriptor } from '@/types/storage'

interface Props {
  storages: StorageDescriptor[]
  active: string
  onChange: (name: string) => void
  className?: string
}

export function StorageSwitcher({ storages, active, onChange, className }: Props) {
  if (storages.length === 0) return null
  // Single-storage deployments don't need a picker; render a non-interactive
  // label so users still see *which* backend they're browsing.
  if (storages.length === 1) {
    return (
      <div
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 text-xs text-muted-foreground',
          className,
        )}
      >
        <Database className="size-3.5" />
        <span>{storages[0].name}</span>
        <span className="rounded bg-background px-1 py-0.5 text-[10px] uppercase tracking-wide">
          {storages[0].type}
        </span>
      </div>
    )
  }

  return (
    <label
      className={cn(
        'group inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        className,
      )}
    >
      <Database className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">Storage</span>
      <select
        value={active}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-foreground outline-none"
        aria-label="Switch storage backend"
      >
        {storages.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name} ({s.type})
          </option>
        ))}
      </select>
    </label>
  )
}
