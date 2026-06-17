import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, FolderInput, Trash2, X } from 'lucide-react'

import { ApiError } from '@/api/client'
import { deleteFile, moveFile } from '@/api/files'
import { proxyUrl } from '@/api/storage'
import { basenameOf } from '@/lib/path'
import { BatchMoveDialog } from '@/components/BatchMoveDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TokenPrompt } from '@/components/TokenPrompt'
import { Button } from '@/components/ui/button'
import type { FileEntry } from '@/types/storage'

interface BatchActionBarProps {
  selectedKeys: ReadonlySet<string>
  /// Current page's entries — used to resolve metadata (is_dir, etc.) and to
  /// build the "select all" key list.
  filteredEntries: FileEntry[]
  storage: string
  prefix: string
  canWrite: boolean
  onSelectAll: () => void
  onClear: () => void
}

/// Returns the keys from `selectedKeys` that correspond to file entries (not
/// directories) in the current listing. Preserves the listing order.
function fileKeysInOrder(
  selectedKeys: ReadonlySet<string>,
  filteredEntries: FileEntry[],
): string[] {
  return filteredEntries
    .filter((e) => !e.is_dir && selectedKeys.has(e.key))
    .map((e) => e.key)
}

export function BatchActionBar({
  selectedKeys,
  filteredEntries,
  storage,
  prefix,
  canWrite,
  onSelectAll,
  onClear,
}: BatchActionBarProps) {
  const queryClient = useQueryClient()

  // --- Delete state ---------------------------------------------------------

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Remaining keys to delete after a 401 interruption (resume on re-auth).
  const [deleteQueue, setDeleteQueue] = useState<string[] | null>(null)

  // --- Move state -----------------------------------------------------------

  const [moveDialogOpen, setMoveDialogOpen] = useState(false)
  const [moving, setMoving] = useState(false)
  const [moveQueue, setMoveQueue] = useState<
    Array<{ from: string; to: string }> | null
  >(null)

  // --- Auth state (shared between delete and move) --------------------------

  const [authPending, setAuthPending] = useState(false)

  // Which operation triggered the 401 so we know what to resume.
  const [pendingOp, setPendingOp] = useState<'delete' | 'move' | null>(null)

  // --- Overwrite confirm (batch move, per-file 409) -------------------------

  const [overwriteTarget, setOverwriteTarget] = useState<{
    from: string
    to: string
    remaining: Array<{ from: string; to: string }>
  } | null>(null)

  // -------------------------------------------------------------------------

  function invalidateList() {
    void queryClient.invalidateQueries({ queryKey: ['list', storage, prefix] })
  }

  // --- Batch download -------------------------------------------------------

  const handleDownload = useCallback(() => {
    const keys = fileKeysInOrder(selectedKeys, filteredEntries)
    if (keys.length === 0) return
    let i = 0
    function downloadNext() {
      if (i >= keys.length) return
      const key = keys[i++]
      const link = document.createElement('a')
      link.href = proxyUrl(key, storage || undefined)
      link.download = basenameOf(key)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      // Delay subsequent triggers so browsers don't block them as pop-ups.
      if (i < keys.length) window.setTimeout(downloadNext, 280)
    }
    downloadNext()
  }, [selectedKeys, filteredEntries, storage])

  // --- Batch delete ---------------------------------------------------------

  const runDeletes = useCallback(
    async (keys: string[]) => {
      setDeleting(true)
      let succeeded = 0
      let failed = 0
      for (let i = 0; i < keys.length; i++) {
        try {
          await deleteFile(storage, keys[i])
          succeeded++
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            setDeleteQueue(keys.slice(i))
            setPendingOp('delete')
            setAuthPending(true)
            setDeleting(false)
            if (succeeded > 0)
              toast.info(`Deleted ${succeeded} file${succeeded !== 1 ? 's' : ''} before auth expired`)
            return
          }
          failed++
          toast.error(
            `Failed to delete ${basenameOf(keys[i])}: ${
              err instanceof ApiError ? err.message : String(err)
            }`,
          )
        }
      }
      setDeleting(false)
      invalidateList()
      onClear()
      if (failed === 0)
        toast.success(`Deleted ${succeeded} file${succeeded !== 1 ? 's' : ''}`)
      else
        toast.warning(`Deleted ${succeeded} file${succeeded !== 1 ? 's' : ''}, ${failed} failed`)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storage, prefix],
  )

  const handleDeleteConfirm = useCallback(() => {
    setDeleteConfirmOpen(false)
    const keys = fileKeysInOrder(selectedKeys, filteredEntries)
    void runDeletes(keys)
  }, [selectedKeys, filteredEntries, runDeletes])

  // --- Batch move -----------------------------------------------------------

  const runMoves = useCallback(
    async (pairs: Array<{ from: string; to: string }>) => {
      setMoving(true)
      let succeeded = 0
      let failed = 0
      for (let i = 0; i < pairs.length; i++) {
        const { from, to } = pairs[i]
        try {
          await moveFile(storage, from, to, false)
          succeeded++
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            setMoveQueue(pairs.slice(i))
            setPendingOp('move')
            setAuthPending(true)
            setMoving(false)
            if (succeeded > 0)
              toast.info(`Moved ${succeeded} file${succeeded !== 1 ? 's' : ''} before auth expired`)
            return
          }
          if (err instanceof ApiError && err.status === 409) {
            // Offer per-file overwrite confirmation; remaining queue saved.
            setOverwriteTarget({ from, to, remaining: pairs.slice(i + 1) })
            setMoving(false)
            if (succeeded > 0)
              toast.info(`Moved ${succeeded} file${succeeded !== 1 ? 's' : ''} so far`)
            return
          }
          failed++
          toast.error(
            `Failed to move ${basenameOf(from)}: ${
              err instanceof ApiError ? err.message : String(err)
            }`,
          )
        }
      }
      setMoving(false)
      invalidateList()
      onClear()
      if (failed === 0)
        toast.success(`Moved ${succeeded} file${succeeded !== 1 ? 's' : ''}`)
      else
        toast.warning(`Moved ${succeeded} file${succeeded !== 1 ? 's' : ''}, ${failed} failed`)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storage, prefix],
  )

  const handleMoveConfirm = useCallback(
    (targetPrefix: string) => {
      setMoveDialogOpen(false)
      const pairs = fileKeysInOrder(selectedKeys, filteredEntries).map(
        (key) => ({ from: key, to: `${targetPrefix}${basenameOf(key)}` }),
      )
      void runMoves(pairs)
    },
    [selectedKeys, filteredEntries, runMoves],
  )

  // --- Auth resume ----------------------------------------------------------

  const handleAuthSubmit = useCallback(() => {
    setAuthPending(false)
    if (pendingOp === 'delete' && deleteQueue) {
      const q = deleteQueue
      setDeleteQueue(null)
      setPendingOp(null)
      void runDeletes(q)
    } else if (pendingOp === 'move' && moveQueue) {
      const q = moveQueue
      setMoveQueue(null)
      setPendingOp(null)
      void runMoves(q)
    }
  }, [pendingOp, deleteQueue, moveQueue, runDeletes, runMoves])

  const handleAuthCancel = useCallback(() => {
    setAuthPending(false)
    setDeleteQueue(null)
    setMoveQueue(null)
    setPendingOp(null)
  }, [])

  // --- Overwrite confirm resume ---------------------------------------------

  const handleOverwriteConfirm = useCallback(() => {
    if (!overwriteTarget) return
    const { from, to, remaining } = overwriteTarget
    setOverwriteTarget(null)
    // Overwrite the conflicting file then continue.
    async function overwriteThenContinue() {
      setMoving(true)
      try {
        await moveFile(storage, from, to, true)
      } catch (err) {
        toast.error(`Failed to overwrite ${basenameOf(to)}: ${err instanceof ApiError ? err.message : String(err)}`)
      }
      void runMoves(remaining)
    }
    void overwriteThenContinue()
  }, [overwriteTarget, storage, runMoves])

  const handleOverwriteSkip = useCallback(() => {
    if (!overwriteTarget) return
    const { remaining } = overwriteTarget
    setOverwriteTarget(null)
    void runMoves(remaining)
  }, [overwriteTarget, runMoves])

  // -------------------------------------------------------------------------

  const busy = deleting || moving
  const fileCount = fileKeysInOrder(selectedKeys, filteredEntries).length
  const allFileKeys = filteredEntries.filter((e) => !e.is_dir).map((e) => e.key)
  const allSelected =
    allFileKeys.length > 0 &&
    allFileKeys.every((k) => selectedKeys.has(k))

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm">
        <span className="font-medium text-foreground">
          {selectedKeys.size} selected
        </span>
        {!allSelected && allFileKeys.length > 0 && (
          <button
            className="text-xs text-primary underline-offset-2 hover:underline"
            onClick={onSelectAll}
          >
            Select all {allFileKeys.length} on this page
          </button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          onClick={onClear}
          disabled={busy}
        >
          <X className="size-3.5" />
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={busy || fileCount === 0}
            onClick={handleDownload}
          >
            <Download className="size-3.5" />
            Download {fileCount > 1 ? `${fileCount} files` : ''}
          </Button>
          {canWrite && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                disabled={busy || fileCount === 0}
                onClick={() => setMoveDialogOpen(true)}
              >
                <FolderInput className="size-3.5" />
                Move
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7"
                disabled={busy || fileCount === 0}
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={`Delete ${fileCount} file${fileCount !== 1 ? 's' : ''}?`}
        description={`This will permanently delete ${fileCount} file${fileCount !== 1 ? 's' : ''}. This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteConfirmOpen(false)}
      />

      {moveDialogOpen && (
        <BatchMoveDialog
          count={fileCount}
          defaultPrefix={prefix}
          busy={moving}
          onConfirm={handleMoveConfirm}
          onCancel={() => setMoveDialogOpen(false)}
        />
      )}

      {overwriteTarget && (
        <ConfirmDialog
          open
          title="File already exists"
          description={
            <>
              <span className="font-mono break-all text-foreground">
                {overwriteTarget.to}
              </span>{' '}
              already exists. Overwrite it?
            </>
          }
          confirmLabel="Overwrite"
          destructive
          busy={moving}
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
