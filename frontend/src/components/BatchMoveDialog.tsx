import { useState } from 'react'
import { FolderInput, Loader2 } from 'lucide-react'

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

interface BatchMoveDialogProps {
  count: number
  /// Default target prefix (usually the current directory).
  defaultPrefix: string
  busy: boolean
  onConfirm: (targetPrefix: string) => void
  onCancel: () => void
}

/// Normalise a user-typed prefix: trim whitespace, and ensure a trailing
/// slash unless the input is empty (root directory = '').
function normalisePrefix(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/// Dialog for selecting the target directory prefix for a batch move. The
/// user types a path prefix; each selected file lands at
/// `<targetPrefix><basename(file)>`.
export function BatchMoveDialog({
  count,
  defaultPrefix,
  busy,
  onConfirm,
  onCancel,
}: BatchMoveDialogProps) {
  const [value, setValue] = useState(defaultPrefix)

  const handleConfirm = () => {
    onConfirm(normalisePrefix(value))
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onCancel() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {count} file{count !== 1 ? 's' : ''}</DialogTitle>
          <DialogDescription>
            Enter the destination directory. Each file will be placed at{' '}
            <span className="font-mono text-foreground">
              &lt;destination&gt;/&lt;filename&gt;
            </span>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <label htmlFor="batch-move-destination" className="text-sm font-medium">
            Destination
          </label>
          <Input
            id="batch-move-destination"
            autoFocus
            placeholder="path/to/destination/"
            value={value}
            aria-describedby="batch-move-destination-help"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) {
                e.preventDefault()
                handleConfirm()
              }
            }}
          />
          <p
            id="batch-move-destination-help"
            className="text-xs text-muted-foreground"
          >
            Leave empty to move to the root directory.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={handleConfirm}>
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FolderInput className="size-3.5" />
            )}
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
