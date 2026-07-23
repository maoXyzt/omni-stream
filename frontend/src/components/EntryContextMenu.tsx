import { useCallback, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Copy,
  Download,
  ExternalLink,
  FolderTree,
  Globe,
  Info,
  Link as LinkIcon,
  Pencil,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react'

import { ApiError } from '@/api/client'
import { deleteFile, moveFile } from '@/api/files'
import { proxyUrl, rawUrl } from '@/api/storage'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TokenPrompt } from '@/components/TokenPrompt'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { FileDetailsDialog } from '@/components/FileDetailsDialog'
import { useFavorites } from '@/hooks/use-favorites'
import { useStorages } from '@/hooks/use-storage'
import { absolutePathOf, basenameOf } from '@/lib/path'
import type { FileEntry } from '@/types/storage'

interface EntryContextMenuProps {
  entry: FileEntry
  storageName: string
  children: ReactNode
}

/// Right-click menu for any directory entry. Shared across grid tiles, list
/// rows, and the sidebar's folder list so users see the same actions
/// regardless of view. Folder entries get only the name/URL pair; files add
/// open-in-new-tab and download, plus rename/delete on writeable storages.
export function EntryContextMenu({
  entry,
  storageName,
  children,
}: EntryContextMenuProps) {
  const name = basenameOf(entry.key)
  // HTML files can be opened as a *live* page via the /raw mount (storage in
  // the path) so their relative fetches / `?ls` listings reach sibling files —
  // distinct from "Open in new tab", which streams raw bytes via /api/proxy.
  // Guard on storageName: rawUrl puts the storage in the path, so an empty
  // name would yield a broken `/raw//…` URL.
  const isHtml = !entry.is_dir && !!storageName && /\.x?html?$/i.test(name)
  // Cached forever (see useStorages) — cheap to read from any tile / row.
  const { data: storagesData } = useStorages()
  const storage = storagesData?.storages.find((s) => s.name === storageName)
  const absPath = storage ? absolutePathOf(storage, entry.key) : null
  // Write actions appear only for files on a writeable storage. A storage's
  // `writeable` already implies the server's write gate is on, so no extra
  // check is needed; the token itself is verified lazily (401 → prompt).
  const canWrite = !entry.is_dir && Boolean(storage?.writeable) && !!storageName

  const { favorites, add: addFavorite, remove: removeFavorite } = useFavorites()
  // Derive directly from the `favorites` array so the toggle reflects the
  // latest state immediately (avoids the one-render lag of a ref-backed read).
  const favorited = favorites.some(
    (f) => f.storage === storageName && f.key === entry.key,
  )

  const queryClient = useQueryClient()
  // Directory prefix of this entry, in the trailing-slash form the listing
  // cache is keyed by. Used to build the rename target and to invalidate the
  // right listing after a write.
  const dir = entry.key.includes('/')
    ? entry.key.slice(0, entry.key.lastIndexOf('/') + 1)
    : ''

  const [showDetails, setShowDetails] = useState(false)
  const [busy, setBusy] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(name)
  const [overwriteOpen, setOverwriteOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // 401 retry intents: rename carries the overwrite flag; delete is a plain bool.
  const [renameAuth, setRenameAuth] = useState<boolean | null>(null)
  const [deleteAuth, setDeleteAuth] = useState(false)

  const renameTarget = renameValue.trim()
  const canRename =
    renameTarget.length > 0 &&
    !renameTarget.includes('/') &&
    renameTarget !== '.' &&
    renameTarget !== '..' &&
    renameTarget !== name &&
    !busy

  const doRename = useCallback(
    async (overwrite: boolean) => {
      const target = renameValue.trim()
      if (!target) return
      const newKey = `${dir}${target}`
      setBusy(true)
      try {
        await moveFile(storageName, entry.key, newKey, overwrite)
        toast.success(`Renamed to ${target}`)
        queryClient.invalidateQueries({ queryKey: ['list', storageName, dir] })
        setOverwriteOpen(false)
        setRenameOpen(false)
      } catch (err) {
        setOverwriteOpen(false)
        if (err instanceof ApiError && err.status === 401) {
          setRenameAuth(overwrite)
        } else if (err instanceof ApiError && err.status === 409) {
          setOverwriteOpen(true)
        } else if (err instanceof ApiError) {
          toast.error(err.message)
        } else {
          toast.error(String(err))
        }
      } finally {
        setBusy(false)
      }
    },
    [renameValue, dir, storageName, entry.key, queryClient],
  )

  const doDelete = useCallback(async () => {
    setBusy(true)
    try {
      await deleteFile(storageName, entry.key)
      toast.success(`Deleted ${name}`)
      queryClient.invalidateQueries({ queryKey: ['list', storageName, dir] })
      setDeleteOpen(false)
    } catch (err) {
      setDeleteOpen(false)
      if (err instanceof ApiError && err.status === 401) {
        setDeleteAuth(true)
      } else if (err instanceof ApiError) {
        toast.error(err.message)
      } else {
        toast.error(String(err))
      }
    } finally {
      setBusy(false)
    }
  }, [storageName, entry.key, name, dir, queryClient])

  function copyText(text: string) {
    void navigator.clipboard?.writeText(text)
  }

  function entryUrl(): string {
    // Folders → the route URL that takes the user into that directory in the
    // UI (shareable). Files → the proxy endpoint that streams the raw bytes
    // (useful for direct-preview / download links).
    if (entry.is_dir) {
      return `${window.location.origin}/s/${encodeURIComponent(
        storageName,
      )}/${entry.key}`
    }
    return (
      window.location.origin + proxyUrl(entry.key, storageName || undefined)
    )
  }

  function openInNewTab() {
    window.open(
      proxyUrl(entry.key, storageName || undefined),
      '_blank',
      'noreferrer',
    )
  }

  function openRendered() {
    // /raw keeps storage in the path so the page's relative data fetches and
    // `?ls` directory listings resolve to the right backend keys.
    window.open(rawUrl(entry.key, storageName), '_blank', 'noopener')
  }

  function downloadFile() {
    // The `download` attribute on a same-origin anchor triggers a download
    // dialog instead of rendering inline. The backend doesn't set
    // Content-Disposition so this client-side trick is the simplest cross-
    // browser approach.
    const link = document.createElement('a')
    link.href = proxyUrl(entry.key, storageName || undefined)
    link.download = name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => copyText(name)}>
            <Copy />
            Copy name
          </ContextMenuItem>
          {absPath && (
            <ContextMenuItem onClick={() => copyText(absPath)}>
              <FolderTree />
              Copy path
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => copyText(entryUrl())}>
            <LinkIcon />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              if (favorited) {
                removeFavorite(storageName, entry.key)
              } else {
                addFavorite(storageName, entry.key, entry.is_dir ? 'folder' : 'file')
              }
            }}
          >
            {favorited ? <StarOff /> : <Star />}
            {favorited ? 'Remove from Favorites' : 'Add to Favorites'}
          </ContextMenuItem>
          {!entry.is_dir && (
            <>
              {isHtml && (
                <ContextMenuItem onClick={openRendered}>
                  <Globe />
                  Render in new tab
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={openInNewTab}>
                <ExternalLink />
                Open in new tab
              </ContextMenuItem>
              <ContextMenuItem onClick={downloadFile}>
                <Download />
                Download
              </ContextMenuItem>
            </>
          )}
          {canWrite && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => {
                  setRenameValue(name)
                  setRenameOpen(true)
                }}
              >
                <Pencil />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                className="text-destructive focus:text-destructive focus:bg-destructive/10"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
                Delete
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setShowDetails(true)}>
            <Info />
            Properties
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {showDetails && (
        <FileDetailsDialog
          fileKey={entry.key}
          storageName={storageName}
          isDir={entry.is_dir}
          onClose={() => setShowDetails(false)}
        />
      )}

      {/* Rename — the dialog (old → new) is itself the deliberate confirmation;
          a 409 escalates to an explicit overwrite confirm. */}
      <Dialog
        open={renameOpen}
        onOpenChange={(o) => {
          if (!o && !busy) setRenameOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription className="break-all">
              {name}
            </DialogDescription>
          </DialogHeader>
          <label htmlFor="rename-file-name" className="text-sm font-medium">
            New file name
          </label>
          <Input
            id="rename-file-name"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canRename) {
                e.preventDefault()
                void doRename(false)
              }
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRenameOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={!canRename} onClick={() => void doRename(false)}>
              <Pencil className="size-3.5" />
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={overwriteOpen}
        title="Overwrite existing file?"
        description={
          <>
            <span className="font-mono break-all text-foreground">
              {dir}
              {renameTarget}
            </span>{' '}
            already exists. Overwrite it?
          </>
        }
        confirmLabel="Overwrite"
        destructive
        busy={busy}
        onConfirm={() => void doRename(true)}
        onCancel={() => setOverwriteOpen(false)}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete file?"
        description={
          <>
            <span className="font-mono break-all text-foreground">
              {entry.key}
            </span>{' '}
            will be permanently deleted.
          </>
        }
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleteOpen(false)}
      />

      {renameAuth !== null && (
        <TokenPrompt
          onSubmit={() => {
            const ow = renameAuth
            setRenameAuth(null)
            void doRename(ow)
          }}
          onCancel={() => setRenameAuth(null)}
        />
      )}
      {deleteAuth && (
        <TokenPrompt
          onSubmit={() => {
            setDeleteAuth(false)
            void doDelete()
          }}
          onCancel={() => setDeleteAuth(false)}
        />
      )}
    </>
  )
}
