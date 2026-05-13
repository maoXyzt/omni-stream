import { AlertTriangle, Database } from 'lucide-react'

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
  // label so users still see *which* backend they're browsing. We surface the
  // invalid state inline so an operator who only configured one (broken)
  // storage sees why traffic is failing.
  if (storages.length === 1) {
    const only = storages[0]
    return (
      <div
        title={!only.valid ? only.error ?? 'storage failed to initialize' : undefined}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs',
          only.valid
            ? 'border-border bg-muted/40 text-muted-foreground'
            // Destructive palette is intentional: this is the only storage
            // and it can't serve traffic — failing loud beats failing quiet.
            : 'border-destructive/40 bg-destructive/10 text-destructive',
          className,
        )}
      >
        {only.valid ? (
          <Database className="size-3.5" />
        ) : (
          <AlertTriangle className="size-3.5" />
        )}
        <span>{only.name}</span>
        <span className="rounded bg-background px-1 py-0.5 text-[10px] uppercase tracking-wide">
          {only.type}
        </span>
        {!only.valid && (
          <span className="rounded bg-destructive/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            invalid
          </span>
        )}
      </div>
    )
  }

  // Find the descriptor for the currently-selected storage so we can colour
  // the chrome (red border + warning icon) when the user has navigated to
  // an invalid backend.
  const activeEntry = storages.find((s) => s.name === active)
  const activeInvalid = activeEntry?.valid === false

  return (
    <label
      title={activeInvalid ? activeEntry?.error ?? 'storage failed to initialize' : undefined}
      className={cn(
        'group inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs focus-within:ring-3',
        activeInvalid
          ? 'border-destructive/60 bg-destructive/10 text-destructive focus-within:border-destructive focus-within:ring-destructive/40'
          : 'border-border bg-background text-foreground focus-within:border-ring focus-within:ring-ring/50',
        className,
      )}
    >
      {activeInvalid ? (
        <AlertTriangle className="size-3.5 text-destructive" />
      ) : (
        <Database className="size-3.5 text-muted-foreground" />
      )}
      <span className={activeInvalid ? 'text-destructive' : 'text-muted-foreground'}>
        Storage
      </span>
      <select
        value={active}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent outline-none"
        aria-label="Switch storage backend"
      >
        {storages.map((s) => (
          // Invalid entries are kept in the list (so the operator can see the
          // whole roster) but `disabled` prevents accidentally selecting one.
          // The label suffix is informational; the actual 503 lives behind
          // the backend.
          <option key={s.name} value={s.name} disabled={!s.valid}>
            {s.name} ({s.type}){!s.valid ? ' — invalid' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
