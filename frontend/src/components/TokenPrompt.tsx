import { useState, type FormEvent } from 'react'
import { Lock } from 'lucide-react'

import { setStoredToken } from '@/api/client'
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
  onSubmit: () => void
  /// When provided, the dialog is dismissable: a Cancel button, Escape, and
  /// click-outside all close it via this callback. Used for the proactive
  /// "Auth Token" entry point. Omitted for the mandatory 401-triggered prompt,
  /// which stays locked until a token is supplied.
  onCancel?: () => void
}

export function TokenPrompt({ onSubmit, onCancel }: Props) {
  const [token, setToken] = useState('')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) return
    setStoredToken(trimmed)
    onSubmit()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel?.()
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onInteractOutside={(e) => {
          if (!onCancel) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (!onCancel) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="size-4" />
            Authentication required
          </DialogTitle>
          <DialogDescription>
            This OmniStream instance is configured with{' '}
            <code>auth.enabled = true</code>. Paste the bearer token from the
            server&apos;s <code>config.toml</code> (or the value of{' '}
            <code>OMNI_AUTH_TOKEN</code>).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            type="password"
            autoFocus
            placeholder="Bearer token"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <DialogFooter>
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={!token.trim()}>
              {onCancel ? 'Save' : 'Save & retry'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
