/// File / folder details panel — shows metadata from /api/stat + the storage
/// descriptor. Opened via "Properties" in EntryContextMenu.
///
/// Each field row has a clipboard-copy button (same pattern as EntryContextMenu
/// and DataTable). The `absolutePathOf` helper comes from `lib/path` so it's
/// shared with other callers.

import { AlertCircle, Check, Copy, Loader2, RotateCw } from 'lucide-react'
import { useState } from 'react'

import { useFileStat, useStorages } from '@/hooks/use-storage'
import { absolutePathOf, findInvisibleChars } from '@/lib/path'
import { formatBytes, formatTime } from '@/lib/format'
import { InvisiblePathLabel } from '@/components/InvisiblePathLabel'
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

interface Props {
  fileKey: string
  storageName: string
  isDir: boolean
  onClose: () => void
}

export function FileDetailsDialog({
  fileKey,
  storageName,
  isDir,
  onClose,
}: Props) {
  const { data: storagesData } = useStorages()
  const storage = storagesData?.storages.find((s) => s.name === storageName)
  // S3 folders are virtual prefixes, not stat-able objects. Wait for the
  // descriptor before deciding so LocalFS directories keep their metadata.
  const statEnabled = !isDir || (storage !== undefined && storage.type !== 's3')
  const { data: meta, isPending, isError, isFetching, refetch } = useFileStat(
    fileKey,
    storageName,
    statEnabled,
  )
  const absPath = storage ? absolutePathOf(storage, fileKey) : null
  const hasInvisibleChars = findInvisibleChars(fileKey).length > 0

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isDir ? 'Folder details' : 'File details'}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {fileKey}
          </DialogDescription>
          {hasInvisibleChars && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-900 dark:text-amber-200">
              <div className="mb-1 font-medium">Visible path</div>
              <InvisiblePathLabel
                value={fileKey}
                showInvisible
                className="font-mono"
              />
            </div>
          )}
        </DialogHeader>

        {statEnabled && isPending ? (
          <div
            role="status"
            aria-label="Loading file metadata"
            className="space-y-2 py-1"
          >
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-2 px-1 py-1.5">
                <Skeleton className="h-3 w-20 shrink-0" />
                <Skeleton className="h-3 flex-1" />
              </div>
            ))}
          </div>
        ) : statEnabled && isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Failed to load file metadata</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <span>The file metadata request failed.</span>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={isFetching}
                onClick={() => void refetch()}
              >
                {isFetching ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RotateCw className="size-4" />
                )}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-0.5">
            {absPath && (
              <DetailRow label="Location" value={absPath} copyable />
            )}
            {!isDir && meta && (
              <>
                <DetailRow
                  label="Size"
                  value={`${formatBytes(meta.size)} (${meta.size.toLocaleString()} bytes)`}
                  copyValue={String(meta.size)}
                />
                {meta.content_type && (
                  <DetailRow label="Type" value={meta.content_type} copyable />
                )}
              </>
            )}
            {statEnabled && meta?.last_modified && (
              <DetailRow
                label="Modified"
                value={formatTime(meta.last_modified)}
                copyValue={meta.last_modified}
              />
            )}
            {!isDir && meta?.etag && (
              <DetailRow label="ETag" value={meta.etag} copyable />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Detail row — label + value + optional clipboard copy
// ---------------------------------------------------------------------------

interface DetailRowProps {
  label: string
  value: string
  /** Use `value` as clipboard text. */
  copyable?: boolean
  /** Override clipboard text (e.g. raw bytes for "Size"). */
  copyValue?: string
}

function DetailRow({ label, value, copyable, copyValue }: DetailRowProps) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    if (!navigator.clipboard) return
    void navigator.clipboard
      .writeText(copyValue ?? value)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <div className="group flex items-start gap-2 rounded-sm px-1 py-1.5 hover:bg-muted/40">
      <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <span className="flex-1 break-all text-xs text-foreground">{value}</span>
      {(copyable || copyValue !== undefined) && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-live="polite"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="size-3 text-green-500" />
          ) : (
            <Copy className="size-3" />
          )}
          <span className="sr-only">
            {copied ? `${label} copied` : `Copy ${label}`}
          </span>
        </Button>
      )}
    </div>
  )
}
