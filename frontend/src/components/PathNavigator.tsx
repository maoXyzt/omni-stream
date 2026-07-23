import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowRight, CircleX, FolderInput, Loader2, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { cleanPathInput, resolveStorageUri } from '@/lib/resolve-uri'
import type { StorageDescriptor } from '@/types/storage'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface PathNavigatorProps {
  prefix: string
  activeStorage?: StorageDescriptor
  // May be async: a file path is resolved via a stat round-trip in the parent
  // before navigating, so we await it and show a pending state meanwhile.
  // Resolving to `false` means navigation didn't happen and the input should
  // be corrected in place, so we keep the dialog open; anything else closes it.
  onNavigate: (prefix: string) => void | Promise<boolean | void>
}

export function PathNavigator({ prefix, onNavigate, activeStorage }: PathNavigatorProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
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

  // Strip stray newlines (from paste) and whitespace. Computed once and reused
  // in both the preview and handleSubmit so the two are always in sync.
  const cleaned = cleanPathInput(value)

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // e.isComposing guards against IME Enter (e.g. Chinese/Japanese candidate
    // selection) being misinterpreted as a form submission.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.currentTarget.form?.requestSubmit()
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      // Keep the dialog open on an explicit `false` (bad/foreign path) so the
      // user can fix their input; close on success or a void return.
      const result = await onNavigate(cleaned)
      if (result !== false) setOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  // Resolved path preview — mirrors what goToPathOrFile will derive from the
  // input. Updated on every keystroke so the user sees the final key before
  // hitting Go.
  const resolved = resolveStorageUri(cleaned, activeStorage)
  const resolvedKey = resolved.ok ? resolved.path.replace(/^\/+/, '') : null

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
      <DialogContent
        className="sm:max-w-2xl"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>Go to path</DialogTitle>
          <DialogDescription>
            A path relative to the current storage root, or a full s3:// URI
            for this storage. Paste a folder to browse or a file to open it;
            leave empty to jump to root.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="path-navigator-input" className="text-sm font-medium">
            Storage path
          </label>
          <div className="relative">
            <textarea
              ref={inputRef}
              id="path-navigator-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="foo/bar/"
              spellCheck={false}
              autoComplete="off"
              rows={3}
              disabled={submitting}
              aria-invalid={cleaned ? !resolved.ok : undefined}
              aria-describedby={cleaned ? 'path-navigator-result' : undefined}
              className={cn(
                'w-full min-w-0 resize-y rounded-lg border border-input bg-transparent py-1.5 pl-2.5 pr-12',
                'font-mono text-sm leading-relaxed transition-colors outline-none',
                'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20',
                'dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
              )}
            />
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-1.5 top-1.5 text-muted-foreground"
                aria-label="Clear path and jump to root"
                title="Clear path"
                disabled={submitting}
                onClick={() => {
                  setValue('')
                  inputRef.current?.focus()
                }}
              >
                <X />
              </Button>
            )}
          </div>
          {cleaned && (
            <div
              id="path-navigator-result"
              aria-live="polite"
              className={cn(
                'flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-mono',
                resolved.ok
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-destructive/10 text-destructive dark:bg-destructive/20',
              )}
            >
              {resolved.ok ? (
                <ArrowRight className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <CircleX className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="break-all">
                {resolved.ok
                  ? resolvedKey === ''
                    ? '(root)'
                    : resolvedKey
                  : resolved.reason}
              </span>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !resolved.ok}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Go
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
