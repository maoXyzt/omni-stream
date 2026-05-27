import { useState, type FormEvent } from 'react'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface PathNavigatorProps {
  prefix: string
  // May be async: a file path is resolved via a stat round-trip in the parent
  // before navigating, so we await it and show a pending state meanwhile.
  // Resolving to `false` means navigation didn't happen and the input should
  // be corrected in place, so we keep the dialog open; anything else closes it.
  onNavigate: (prefix: string) => void | Promise<boolean | void>
}

export function PathNavigator({ prefix, onNavigate }: PathNavigatorProps) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(prefix)
  const [submitting, setSubmitting] = useState(false)

  // Reset the input to the live `prefix` whenever the dialog opens, so the
  // user always starts from "current path" rather than whatever they typed
  // last time. Tracking this in onOpenChange avoids a useEffect.
  function handleOpenChange(next: boolean) {
    if (next) setValue(prefix)
    setOpen(next)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    // The parent normalizes the path (strips leading slashes, applies the
    // trailing-slash convention, and resolves file vs. directory), so we just
    // trim whitespace here.
    setSubmitting(true)
    try {
      // Keep the dialog open on an explicit `false` (bad/foreign path) so the
      // user can fix their input; close on success or a void return.
      const result = await onNavigate(value.trim())
      if (result !== false) setOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Labeled outline button rather than a bare ghost icon — the text
              + border give it enough weight to read as an action next to the
              breadcrumb, instead of blending in as decoration. The label
              collapses to icon-only on very narrow screens; `aria-label`
              keeps the accessible name in that case. */}
          <Button
            variant="outline"
            size="sm"
            className="ml-1 shrink-0"
            aria-label="Go to path"
            onClick={() => handleOpenChange(true)}
          >
            <FolderInput />
            <span className="hidden sm:inline">Go to path</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Jump to a folder or file path</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Go to path</DialogTitle>
          <DialogDescription>
            A path relative to the current storage root, or a full s3:// URI
            for this storage. Paste a folder to browse or a file to open it;
            leave empty to jump to root.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="foo/bar/"
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Go
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
