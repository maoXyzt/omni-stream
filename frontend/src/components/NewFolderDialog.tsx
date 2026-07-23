import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FolderPlus, Loader2 } from 'lucide-react'

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
import { Input } from '@/components/ui/input'

interface Props {
  storage: string
  /// Current directory prefix — trailing slash, or '' for the root. The new
  /// folder placeholder lands at `prefix + name + '/.keep'`.
  prefix: string
  onClose: () => void
}

/// Validate a bare folder name (not a path). Returns an error string, or null
/// when valid. Mirrors the same guards as NewFileDialog.
function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (trimmed.includes('/')) return 'Name cannot contain "/"'
  if (trimmed === '.' || trimmed === '..') return 'Invalid folder name'
  return null
}

/// Create a new folder in the current directory using a `.keep` placeholder
/// file. This is a pure-frontend approach that works on both local and S3
/// backends without a dedicated mkdir endpoint. The placeholder is a zero-byte
/// file at `<prefix><name>/.keep`; the listing query will surface `<name>/` as
/// a virtual directory once the file exists.
///
/// Error handling follows NewFileDialog: 409 → overwrite confirm (rare but the
/// .keep file might already exist), 401 → token prompt → retry.
export function NewFolderDialog({ storage, prefix, onClose }: Props) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [overwriteConfirm, setOverwriteConfirm] = useState(false)
  const [authRetryOverwrite, setAuthRetryOverwrite] = useState<boolean | null>(
    null,
  )

  const trimmed = name.trim()
  const nameError = validateName(name)
  const folderKey = `${prefix}${trimmed}/`
  const keepKey = `${folderKey}.keep`

  const create = useCallback(
    async (overwrite: boolean) => {
      setSaving(true)
      try {
        await putFile(storage, keepKey, '', overwrite)
        toast.success(`Created folder ${trimmed}`)
        // Invalidate the current prefix so the new folder appears in the listing.
        queryClient.invalidateQueries({ queryKey: ['list', storage, prefix] })
        onClose()
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setAuthRetryOverwrite(overwrite)
        } else if (err instanceof ApiError && err.status === 409) {
          setOverwriteConfirm(true)
        } else if (err instanceof ApiError) {
          toast.error(err.message)
        } else {
          toast.error(String(err))
        }
      } finally {
        setSaving(false)
      }
    },
    [storage, keepKey, trimmed, prefix, queryClient, onClose],
  )

  const canSubmit = trimmed.length > 0 && !nameError && !saving

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o && !saving) onClose()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder in{' '}
              <span className="font-mono text-foreground">
                {prefix || '(root)'}
              </span>
              .
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <label htmlFor="new-folder-name" className="text-sm font-medium">
              Folder name
            </label>
            <Input
              id="new-folder-name"
              autoFocus
              placeholder="folder-name"
              value={name}
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? 'new-folder-name-error' : undefined}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  void create(false)
                }
              }}
            />
            {nameError && (
              <p
                id="new-folder-name-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {nameError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!canSubmit} onClick={() => void create(false)}>
              {saving ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <FolderPlus className="size-3.5" />
                  Create
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={overwriteConfirm}
        title="Folder already exists?"
        description={
          <>
            <span className="font-mono break-all text-foreground">
              {folderKey}
            </span>{' '}
            already has a{' '}
            <span className="font-mono text-foreground">.keep</span> file.
            Overwrite it?
          </>
        }
        confirmLabel="Overwrite"
        destructive
        busy={saving}
        onConfirm={() => void create(true)}
        onCancel={() => setOverwriteConfirm(false)}
      />
      {authRetryOverwrite !== null && (
        <TokenPrompt
          onSubmit={() => {
            const ow = authRetryOverwrite
            setAuthRetryOverwrite(null)
            void create(ow)
          }}
          onCancel={() => setAuthRetryOverwrite(null)}
        />
      )}
    </>
  )
}
