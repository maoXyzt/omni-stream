import { useRef, type RefObject } from 'react'
import { Download, ExternalLink } from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { useGlobalShortcut } from '@/hooks/use-global-shortcut'
import { getPreviewType } from '@/components/preview/registry'
import type { PreviewKind } from '@/components/preview/types'
import { Button } from '@/components/ui/button'
import { getPreviewReturnFocus } from '@/lib/accessibility'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type { PreviewKind } from '@/components/preview/types'

interface Props {
  fileKey: string
  kind: PreviewKind
  storage?: string
  /// Optional cache-buster — typically `entry.last_modified` from the
  /// listing. When the user clicks Refresh and the listing returns new
  /// mtimes, this changes and the browser refetches instead of serving the
  /// stale cached preview.
  version?: string | null
  onClose: () => void
  onNavigate?: (dir: 'prev' | 'next') => void
  fallbackFocusRef?: RefObject<HTMLElement | null>
}

export function PreviewModal({
  fileKey,
  kind,
  storage,
  version,
  onClose,
  onNavigate,
  fallbackFocusRef,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const src = proxyUrl(fileKey, storage, version)
  const type = getPreviewType(kind)
  const Previewer = type?.Component

  // Arrow-key navigation between files — active only when an `onNavigate`
  // callback is wired. Both axes work: up/down match the list view's vertical
  // flow; left/right match the grid's horizontal tile layout. Video/audio
  // elements use arrow keys for scrubbing/volume, so we skip when they're
  // focused (includeMedia guard).
  useGlobalShortcut(
    'arrowdown',
    (e) => { e.preventDefault(); onNavigate?.('next') },
    { active: !!onNavigate, includeMedia: true },
  )
  useGlobalShortcut(
    'arrowright',
    (e) => { e.preventDefault(); onNavigate?.('next') },
    { active: !!onNavigate, includeMedia: true },
  )
  useGlobalShortcut(
    'arrowup',
    (e) => { e.preventDefault(); onNavigate?.('prev') },
    { active: !!onNavigate, includeMedia: true },
  )
  useGlobalShortcut(
    'arrowleft',
    (e) => { e.preventDefault(); onNavigate?.('prev') },
    { active: !!onNavigate, includeMedia: true },
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        // Keep initial focus inside the modal without landing on TextPreview's
        // language select, where arrow keys change the option instead of
        // navigating files. Users can still Tab into every control.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          previousFocusRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
          contentRef.current?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(e) => {
          const focusTarget = getPreviewReturnFocus(
            previousFocusRef.current,
            fallbackFocusRef?.current ?? null,
          )
          if (!focusTarget) return
          e.preventDefault()
          focusTarget.focus({ preventScroll: true })
        }}
        className="flex h-[95vh] w-[95vw] max-w-[95vw] flex-col sm:max-w-[95vw]"
      >
        <DialogHeader>
          <DialogTitle className="break-all pr-8">{fileKey}</DialogTitle>
          <DialogDescription>
            Streamed via <code>/api/proxy</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {Previewer ? (
            <Previewer fileKey={fileKey} src={src} storage={storage} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              No previewer registered for this file.
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="outline" asChild>
            <a href={src} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              Open in new tab
            </a>
          </Button>
          <Button asChild>
            <a href={src} download>
              <Download className="size-4" />
              Download
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
