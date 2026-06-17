import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, FileUp, Loader2, Upload, XCircle } from 'lucide-react'

import { ApiError } from '@/api/client'
import { putFile } from '@/api/files'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TokenPrompt } from '@/components/TokenPrompt'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MAX_PUT_BYTES } from '@/lib/upload-limits'
import { cn } from '@/lib/utils'

type UploadStatus =
  | 'pending'
  | 'uploading'
  | 'done'
  | 'error'
  | 'too-large'

interface UploadItem {
  file: File
  key: string
  status: UploadStatus
  progress: number
  error?: string
}

interface UploadDialogProps {
  storage: string
  prefix: string
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function UploadDialog({ storage, prefix, onClose }: UploadDialogProps) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const [items, setItems] = useState<UploadItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)

  // --- Auth state ---
  const [authPending, setAuthPending] = useState(false)
  // Queue of items waiting to resume after 401.
  const pendingQueueRef = useRef<UploadItem[]>([])

  // --- Overwrite confirm ---
  const [overwriteItem, setOverwriteItem] = useState<UploadItem | null>(null)
  // Items still waiting after the overwrite confirmation.
  const afterOverwriteRef = useRef<UploadItem[]>([])

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files)
    const newItems: UploadItem[] = arr.map((f) => ({
      file: f,
      key: `${prefix}${f.name}`,
      status: f.size > MAX_PUT_BYTES ? 'too-large' : 'pending',
      progress: 0,
    }))
    setItems((prev) => {
      // Deduplicate by key — re-adding the same filename replaces the old row.
      const existing = new Map(prev.map((i) => [i.key, i]))
      for (const item of newItems) existing.set(item.key, item)
      return Array.from(existing.values())
    })
  }

  function updateItem(key: string, patch: Partial<UploadItem>) {
    setItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, ...patch } : i)),
    )
  }

  // --- Upload logic ---

  // `overwriteKey` limits overwrite=true to exactly that one file; all others
  // in the queue still go through 409 detection so they get per-file prompts.
  const runUploads = useCallback(
    async (queue: UploadItem[], overwriteKey?: string) => {
      if (queue.length === 0) return
      setUploading(true)
      let succeeded = 0

      for (let i = 0; i < queue.length; i++) {
        const item = queue[i]
        const overwrite = item.key === overwriteKey
        updateItem(item.key, { status: 'uploading', progress: 0 })
        try {
          await putFile(storage, item.key, item.file, overwrite, (pct) => {
            updateItem(item.key, { progress: pct })
          })
          updateItem(item.key, { status: 'done', progress: 100 })
          succeeded++
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            updateItem(item.key, { status: 'pending', progress: 0 })
            pendingQueueRef.current = queue.slice(i)
            setAuthPending(true)
            setUploading(false)
            if (succeeded > 0)
              toast.info(`Uploaded ${succeeded} file${succeeded !== 1 ? 's' : ''} before auth expired`)
            return
          }
          if (err instanceof ApiError && err.status === 409) {
            updateItem(item.key, { status: 'pending', progress: 0 })
            afterOverwriteRef.current = queue.slice(i + 1)
            setOverwriteItem(item)
            setUploading(false)
            if (succeeded > 0)
              toast.info(`Uploaded ${succeeded} file${succeeded !== 1 ? 's' : ''} so far`)
            return
          }
          updateItem(item.key, {
            status: 'error',
            error: err instanceof ApiError ? err.message : String(err),
          })
        }
      }

      setUploading(false)
      void queryClient.invalidateQueries({
        queryKey: ['list', storage, prefix],
      })
      if (succeeded > 0) {
        toast.success(
          `Uploaded ${succeeded} file${succeeded !== 1 ? 's' : ''}`,
        )
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storage, prefix],
  )

  const handleUpload = useCallback(() => {
    const queue = items.filter(
      (i) => i.status === 'pending' || i.status === 'error',
    )
    void runUploads(queue)
  }, [items, runUploads])

  const handleAuthSubmit = useCallback(() => {
    setAuthPending(false)
    const q = pendingQueueRef.current
    pendingQueueRef.current = []
    void runUploads(q)
  }, [runUploads])

  const handleAuthCancel = useCallback(() => {
    setAuthPending(false)
    pendingQueueRef.current = []
  }, [])

  const handleOverwriteConfirm = useCallback(() => {
    const item = overwriteItem
    const rest = afterOverwriteRef.current
    setOverwriteItem(null)
    afterOverwriteRef.current = []
    if (!item) return
    // Only the user-confirmed item gets overwrite=true; `rest` still goes
    // through 409 detection so subsequent conflicts each prompt individually.
    void runUploads([item, ...rest], item.key)
  }, [overwriteItem, runUploads])

  const handleOverwriteSkip = useCallback(() => {
    const rest = afterOverwriteRef.current
    setOverwriteItem(null)
    afterOverwriteRef.current = []
    void runUploads(rest)
  }, [runUploads])

  // --- Drag-and-drop ---

  useEffect(() => {
    const el = dropRef.current
    if (!el) return

    function onDragOver(e: DragEvent) {
      e.preventDefault()
      setDragOver(true)
    }
    function onDragLeave() {
      setDragOver(false)
    }
    function onDrop(e: DragEvent) {
      e.preventDefault()
      setDragOver(false)
      if (!e.dataTransfer) return
      const files: File[] = []
      let hadFolder = false
      for (const item of Array.from(e.dataTransfer.items)) {
        if (item.kind !== 'file') continue
        const entry = item.webkitGetAsEntry?.()
        if (entry?.isDirectory) {
          hadFolder = true
          continue
        }
        const f = item.getAsFile()
        if (f) files.push(f)
      }
      if (hadFolder) {
        toast.warning('Folder upload is not supported — only files were added.')
      }
      if (files.length > 0) addFiles(files)
    }

    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pendingCount = items.filter(
    (i) => i.status === 'pending' || i.status === 'error',
  ).length
  const doneCount = items.filter((i) => i.status === 'done').length

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o && !uploading) onClose()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload files</DialogTitle>
            <DialogDescription>
              Files are uploaded to{' '}
              <span className="font-mono text-foreground">
                {prefix || '(root)'}
              </span>
              . Maximum {formatBytes(MAX_PUT_BYTES)} per file.
            </DialogDescription>
          </DialogHeader>

          {/* Drop zone */}
          <div
            ref={dropRef}
            role="button"
            tabIndex={0}
            aria-label="Add files to upload"
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              dragOver
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border hover:border-primary/50 hover:bg-muted/30',
            )}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                inputRef.current?.click()
              }
            }}
          >
            <FileUp className="size-8 opacity-60" />
            <span>Drag files here or click to browse</span>
            <span className="text-xs opacity-70">Folders are not supported</span>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          {/* File list */}
          {items.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
              {items.map((item) => (
                <div
                  key={item.key}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <StatusIcon status={item.status} progress={item.progress} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{item.file.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.status === 'too-large'
                        ? `Too large (${formatBytes(item.file.size)} > ${formatBytes(MAX_PUT_BYTES)})`
                        : item.status === 'error'
                          ? item.error
                          : item.status === 'uploading'
                            ? `${item.progress}%`
                            : formatBytes(item.file.size)}
                    </div>
                    {item.status === 'uploading' && (
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-150"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" disabled={uploading} onClick={onClose}>
              {doneCount > 0 && pendingCount === 0 ? 'Close' : 'Cancel'}
            </Button>
            <Button
              disabled={uploading || pendingCount === 0}
              onClick={handleUpload}
            >
              {uploading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {uploading
                ? 'Uploading…'
                : `Upload${pendingCount > 0 ? ` ${pendingCount} file${pendingCount !== 1 ? 's' : ''}` : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {overwriteItem && (
        <ConfirmDialog
          open
          title="File already exists"
          description={
            <>
              <span className="font-mono break-all text-foreground">
                {overwriteItem.key}
              </span>{' '}
              already exists. Overwrite it?
            </>
          }
          confirmLabel="Overwrite"
          destructive
          busy={uploading}
          onConfirm={handleOverwriteConfirm}
          onCancel={handleOverwriteSkip}
        />
      )}

      {authPending && (
        <TokenPrompt onSubmit={handleAuthSubmit} onCancel={handleAuthCancel} />
      )}
    </>
  )
}

function StatusIcon({
  status,
  progress,
}: {
  status: UploadStatus
  progress: number
}) {
  if (status === 'done')
    return <CheckCircle2 className="size-4 shrink-0 text-green-500" />
  if (status === 'error' || status === 'too-large')
    return <XCircle className="size-4 shrink-0 text-destructive" />
  if (status === 'uploading')
    return (
      <Loader2
        className="size-4 shrink-0 animate-spin text-primary"
        aria-label={`${progress}%`}
      />
    )
  return <div className="size-4 shrink-0 rounded-full border-2 border-muted-foreground/30" />
}
