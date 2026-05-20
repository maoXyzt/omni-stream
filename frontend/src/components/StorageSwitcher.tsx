import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy as CopyIcon,
  Database,
  FolderOpen,
} from 'lucide-react'
import { toast } from 'sonner'

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
  /// Bucket the user is currently navigated into. Only meaningful when the
  /// active storage is S3 in multi-bucket mode (`s3.bucket === null` in the
  /// config) — in that case the first path segment in the URL *is* the
  /// bucket, so the caller forwards it here. `null` / `undefined` in
  /// multi-bucket mode means "at the storage root, listing all buckets".
  currentBucket?: string | null
  className?: string
}

export function StorageSwitcher({
  storages,
  active,
  onChange,
  currentBucket,
  className,
}: Props) {
  const [open, setOpen] = useState(false)
  if (storages.length === 0) return null

  const activeEntry = storages.find((s) => s.name === active)
  const activeInvalid = activeEntry?.valid === false
  const detail = activeEntry ? describeStorage(activeEntry, currentBucket) : null

  // Single-storage deployments: previously a non-interactive label. Now it's
  // a button that opens a small "Storage details" dialog, mirroring the
  // multi-storage Dialog so operators have a consistent place to read /
  // copy the endpoint / bucket / region / root_path. Invalid storages stay
  // as a static label (nothing useful to show in the dialog — the error
  // message is already inline via `title`).
  if (storages.length === 1) {
    const only = storages[0]
    const onlyDetail = describeStorage(only, currentBucket)
    if (!only.valid) {
      return (
        <div
          title={only.error ?? 'storage failed to initialize'}
          className={cn(
            'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 text-xs text-destructive',
            className,
          )}
        >
          <AlertTriangle className="size-3.5" />
          <span>{only.name}</span>
          <TypeBadge type={only.type} />
          <InvalidBadge />
        </div>
      )
    }
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            title={onlyDetail?.tooltip ?? undefined}
            className={cn(
              'h-7 max-w-full gap-1.5 border-border bg-muted/40 px-2 text-xs text-muted-foreground',
              className,
            )}
            aria-label="Show storage details"
          >
            <Database className="size-3.5" />
            <span>{only.name}</span>
            <TypeBadge type={only.type} />
            {onlyDetail && <DetailInline detail={onlyDetail} />}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Storage details</DialogTitle>
            <DialogDescription>
              Click any value to copy it. To change which backend is exposed,
              edit the server config — only one storage is currently configured.
            </DialogDescription>
          </DialogHeader>
          <div className="py-1">
            <StorageCard storage={only} active onPick={() => setOpen(false)} />
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Trigger replaces the old <select>. Shows the active storage name +
            type + a compact identifier (current bucket / endpoint host, or
            local root path) so the operator can tell at a glance which
            backend and which slice of it they're browsing without opening
            the dialog. Destructive palette when the active storage is
            invalid (so a misconfigured deep-link doesn't render as
            "everything's fine"). */}
        <Button
          variant="outline"
          size="sm"
          title={!activeInvalid ? (detail?.tooltip ?? undefined) : undefined}
          className={cn(
            'h-7 max-w-full gap-1.5 px-2 text-xs',
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
          {!activeInvalid && detail && <DetailInline detail={detail} />}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
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

  // `<div role="button">` instead of `<button>` so the per-field copy buttons
  // inside aren't nested inside another `<button>` (invalid HTML and an a11y
  // hazard). Keyboard activation is added manually to keep parity with the
  // native button semantics screen readers expect.
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onPick}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick()
        }
      }}
      className={cn(
        'group flex flex-col gap-2 rounded-md border p-3 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
    </div>
  )
}

/// Compact identifier shown inline in the navbar trigger / single-storage
/// label, next to the storage name. Keeps the most useful "where am I
/// connected" piece visible without a click — for S3 that's the bucket,
/// for local FS the root path. Endpoint and region stay in the hover
/// tooltip so the navbar doesn't get crowded; the full breakdown is also
/// in the dialog. Returns `null` when the storage has no extra info worth
/// surfacing (shouldn't happen for valid S3 / local entries).
function describeStorage(
  storage: StorageDescriptor,
  currentBucket?: string | null,
): { primary: string; tooltip: string } | null {
  if (storage.type === 's3' && storage.s3) {
    const configured = storage.s3.bucket
    const isMulti = configured === null
    // In multi-bucket mode the URL's first segment IS the bucket; if the
    // user is at the storage root (no segment yet) we render "*" so the
    // multi-bucket nature stays obvious instead of looking like an empty /
    // unconfigured field.
    const bucket = isMulti ? (currentBucket || '*') : configured
    const endpoint = storage.s3.endpoint || 'AWS'
    const tooltipBucket = isMulti
      ? currentBucket
        ? `${currentBucket} (multi-bucket mode)`
        : '(all buckets — at storage root)'
      : configured
    const tooltipLines = [
      `bucket: ${tooltipBucket}`,
      `endpoint: ${endpoint}`,
      storage.s3.region ? `region: ${storage.s3.region}` : null,
    ].filter((line): line is string => line !== null)
    return {
      primary: bucket,
      tooltip: tooltipLines.join('\n'),
    }
  }
  if (storage.type === 'local' && storage.local) {
    const root = storage.local.root_path || '—'
    return {
      primary: root,
      tooltip: `root: ${root}`,
    }
  }
  return null
}

function DetailInline({ detail }: { detail: { primary: string } }) {
  return (
    <>
      <span aria-hidden className="text-muted-foreground/40">·</span>
      <span className="max-w-[14rem] truncate font-mono text-[11px]">
        {detail.primary}
      </span>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  async function copy(e: React.MouseEvent | React.KeyboardEvent) {
    // Stop the outer StorageCard's click handler from firing — copying a
    // field shouldn't double as "select this storage".
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`Copied ${label}`, { description: value })
    } catch {
      // Fallback for non-secure contexts / locked-down browsers where the
      // Clipboard API is unavailable.
      window.prompt(`Copy ${label}:`, value)
    }
  }
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <button
          type="button"
          onClick={copy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              void copy(e)
            }
          }}
          title={`Copy ${label}`}
          aria-label={`Copy ${label}: ${value}`}
          className="group/copy inline-flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
        >
          <span className="min-w-0 flex-1 break-all font-mono">{value}</span>
          <CopyIcon
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground/40 transition group-hover/copy:text-muted-foreground"
          />
        </button>
      </dd>
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
