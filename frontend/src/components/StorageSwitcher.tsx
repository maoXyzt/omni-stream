import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Database, FolderOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { StorageDescriptor } from '@/types/storage'

interface Props {
  storages: StorageDescriptor[]
  active: string
  onChange: (name: string) => void
  className?: string
}

export function StorageSwitcher({ storages, active, onChange, className }: Props) {
  const [open, setOpen] = useState(false)
  if (storages.length === 0) return null

  const activeEntry = storages.find((s) => s.name === active)
  const activeInvalid = activeEntry?.valid === false

  // Single-storage deployments: render a non-interactive label, same as
  // before. No dialog — there's nothing to switch to.
  if (storages.length === 1) {
    const only = storages[0]
    return (
      <div
        title={!only.valid ? only.error ?? 'storage failed to initialize' : undefined}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs',
          only.valid
            ? 'border-border bg-muted/40 text-muted-foreground'
            : 'border-destructive/40 bg-destructive/10 text-destructive',
          className,
        )}
      >
        {only.valid ? <Database className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
        <span>{only.name}</span>
        <TypeBadge type={only.type} />
        {!only.valid && <InvalidBadge />}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Trigger replaces the old <select>. Shows the active storage name +
            type so the user can see what's currently selected without opening
            the dialog. Destructive palette when the active storage is invalid
            (so a misconfigured deep-link doesn't render as "everything's
            fine"). */}
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-7 gap-1.5 px-2 text-xs',
            activeInvalid && 'border-destructive/60 bg-destructive/10 text-destructive',
            className,
          )}
          aria-label="Switch storage backend"
        >
          {activeInvalid ? (
            <AlertTriangle className="size-3.5" />
          ) : (
            <Database className="size-3.5 text-muted-foreground" />
          )}
          <span className="font-medium">{activeEntry?.name ?? active}</span>
          {activeEntry && <TypeBadge type={activeEntry.type} />}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg sm:max-w-2xl lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Switch storage</DialogTitle>
          <DialogDescription>
            Pick a backend to browse. Invalid storages are listed for context but
            can't be selected — fix the underlying configuration to use them.
          </DialogDescription>
        </DialogHeader>
        {/* Scroll the list, not the whole modal, so the header stays anchored
            when many storages are configured. The `max-h` clamp gives ~6 cards
            of visible space before scrolling kicks in. */}
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto py-1">
          {storages.map((s) => (
            <StorageCard
              key={s.name}
              storage={s}
              active={s.name === active}
              onPick={() => {
                if (!s.valid) return
                onChange(s.name)
                setOpen(false)
              }}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface CardProps {
  storage: StorageDescriptor
  active: boolean
  onPick: () => void
}

function StorageCard({ storage, active, onPick }: CardProps) {
  const disabled = !storage.valid
  const Icon = storage.type === 'local' ? FolderOpen : Database

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className={cn(
        'group flex flex-col gap-2 rounded-md border p-3 text-left transition',
        // Three visual states: active (highlighted), invalid (destructive,
        // not clickable), and idle (hover-able).
        active
          ? 'border-primary bg-primary/5'
          : disabled
            ? 'cursor-not-allowed border-destructive/30 bg-destructive/5'
            : 'cursor-pointer hover:border-primary/40 hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'size-4 shrink-0',
            active
              ? 'text-primary'
              : disabled
                ? 'text-destructive'
                : 'text-muted-foreground',
          )}
        />
        <span className="truncate font-medium">{storage.name}</span>
        <TypeBadge type={storage.type} />
        {active && (
          <span className="ml-auto inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            <Check className="size-3" />
            active
          </span>
        )}
        {disabled && !active && <InvalidBadge className="ml-auto" />}
      </div>

      {/* Type-specific details — monospaced so the bucket / endpoint /
          root-path read as identifiers, not prose. */}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        {storage.type === 's3' && storage.s3 && (
          <>
            {/* Server emits `bucket: null` when the storage is in multi-bucket
                mode (omitted or `"*"` in config). Render that explicitly as
                "(all buckets)" so the operator can tell at a glance it's a
                ListBuckets-backed root rather than a misconfigured empty
                bucket name. */}
            <Field label="bucket" value={storage.s3.bucket ?? '(all buckets)'} />
            <Field label="endpoint" value={storage.s3.endpoint ?? '(AWS default)'} />
            {storage.s3.region && <Field label="region" value={storage.s3.region} />}
          </>
        )}
        {storage.type === 'local' && storage.local && (
          <Field label="root" value={storage.local.root_path || '—'} />
        )}
      </dl>

      {/* Error reason for invalid storages. Wraps long messages onto multiple
          lines so the full path / OS error stays readable. */}
      {disabled && storage.error && (
        <div className="flex items-start gap-1.5 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="break-all">{storage.error}</span>
        </div>
      )}
    </button>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </>
  )
}

function TypeBadge({ type }: { type: StorageDescriptor['type'] }) {
  return (
    <span className="rounded bg-background px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {type}
    </span>
  )
}

function InvalidBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'rounded bg-destructive/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive',
        className,
      )}
    >
      invalid
    </span>
  )
}
