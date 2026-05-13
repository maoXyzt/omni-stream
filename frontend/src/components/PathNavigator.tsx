import { useState, type FormEvent } from 'react'
import { FolderInput } from 'lucide-react'

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
  onNavigate: (prefix: string) => void
}

export function PathNavigator({ prefix, onNavigate }: PathNavigatorProps) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(prefix)

  // Reset the input to the live `prefix` whenever the dialog opens, so the
  // user always starts from "current path" rather than whatever they typed
  // last time. Tracking this in onOpenChange avoids a useEffect.
  function handleOpenChange(next: boolean) {
    if (next) setValue(prefix)
    setOpen(next)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    // `normalizePrefix` in the parent will strip leading slashes and ensure
    // trailing-slash convention, so we just trim whitespace here.
    onNavigate(value.trim())
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="size-7 shrink-0 p-0"
            aria-label="Go to path"
            onClick={() => handleOpenChange(true)}
          >
            <FolderInput className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Go to path</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Go to path</DialogTitle>
          <DialogDescription>
            Relative to the current storage root. Use a trailing slash for
            directories; leave empty to jump to root.
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
            >
              Cancel
            </Button>
            <Button type="submit">Go</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
