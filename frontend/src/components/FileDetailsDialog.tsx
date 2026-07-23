/// File / folder details panel — shows metadata from /api/stat + the storage
/// descriptor. Opened via "Properties" in EntryContextMenu.
///
/// Each field row has a clipboard-copy button (same pattern as EntryContextMenu
/// and DataTable). The `absolutePathOf` helper comes from `lib/path` so it's
/// shared with other callers.

import { Check, Copy, Loader2, RotateCw } from 'lucide-react'
import { useState } from 'react'

import { useFileStat, useStorages } from '@/hooks/use-storage'
import { absolutePathOf } from '@/lib/path'
import { formatBytes, formatTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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
  const { data: meta, isPending, isError, refetch } = useFileStat(fileKey, storageName)
  const { data: storagesData } = useStorages()
  const storage = storagesData?.storages.find((s) => s.name === storageName)
  const absPath = storage ? absolutePathOf(storage, fileKey) : null

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isDir ? 'Folder details' : 'File details'}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {fileKey}
          </DialogDescription>
        </DialogHeader>

        {isPending ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-sm text-destructive">Failed to load file metadata.</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              <RotateCw className="size-3.5" />
              Retry
            </Button>
          </div>
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
            {meta?.last_modified && (
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
