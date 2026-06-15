import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  title: string
  /// Body text or richer content (e.g. the affected file path). Rendered
  /// inside the dialog description region.
  description?: ReactNode
  /// Confirm button label. Defaults to "Confirm".
  confirmLabel?: string
  cancelLabel?: string
  /// Style the confirm button as a destructive action (delete / overwrite).
  destructive?: boolean
  /// While true the buttons are disabled and the confirm button shows a
  /// spinner — for the window between confirming and the request resolving.
  busy?: boolean
  onConfirm: () => void
  /// Called on Cancel, Escape, and click-outside. The parent owns `open`.
  onCancel: () => void
}

/// Shared two-button confirmation dialog for the write actions (save /
/// overwrite / delete / rename) — every mutation passes through one of these
/// so "confirm before any change" is enforced in a single place. Built on the
/// existing Radix `Dialog`; no new dependency.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block dismissal mid-request so the action can't be half-cancelled.
        if (!next && !busy) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && (
            <DialogDescription className="break-words">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
