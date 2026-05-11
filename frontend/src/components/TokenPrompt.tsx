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
}

export function TokenPrompt({ onSubmit }: Props) {
  const [token, setToken] = useState('')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) return
    setStoredToken(trimmed)
    onSubmit()
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
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
            <Button type="submit" disabled={!token.trim()}>
              Save & retry
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
