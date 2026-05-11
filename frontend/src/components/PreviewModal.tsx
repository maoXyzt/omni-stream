import { useEffect } from 'react'
import { Download, ExternalLink } from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { getPreviewType } from '@/components/preview/registry'
import type { PreviewKind } from '@/components/preview/types'
import { Button } from '@/components/ui/button'
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
  onClose: () => void
  onNavigate?: (dir: 'prev' | 'next') => void
}

export function PreviewModal({
  fileKey,
  kind,
  storage,
  onClose,
  onNavigate,
}: Props) {
  const src = proxyUrl(fileKey, storage)
  const type = getPreviewType(kind)
  const Previewer = type?.Component

  useEffect(() => {
    if (!onNavigate) return
    const handler = (e: KeyboardEvent) => {
      // Don't hijack arrow keys when the user is typing or interacting with a
      // form field; video controls also handle ArrowUp/Down for volume so skip
      // when the focused element is a media element.
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          tag === 'VIDEO' ||
          tag === 'AUDIO' ||
          target.isContentEditable
        ) {
          return
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        onNavigate('next')
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        onNavigate('prev')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onNavigate])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[95vh] w-[95vw] max-w-[95vw] flex-col sm:max-w-[95vw]">
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
