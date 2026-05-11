import { Download, ExternalLink } from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type PreviewKind = 'image' | 'video'

interface Props {
  fileKey: string
  kind: PreviewKind
  storage?: string
  onClose: () => void
}

export function PreviewModal({ fileKey, kind, storage, onClose }: Props) {
  const src = proxyUrl(fileKey, storage)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="break-all">{fileKey}</DialogTitle>
          <DialogDescription>
            Streamed via <code>/api/proxy</code>. Video previews use the browser&apos;s
            native <code>Range</code> support.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center bg-muted/30 rounded-md p-2">
          {kind === 'image' && (
            <img
              src={src}
              alt={fileKey}
              className="max-h-[70vh] w-auto rounded-md object-contain"
            />
          )}
          {kind === 'video' && (
            // <video> issues HTTP Range requests automatically; the backend
            // returns 206 with Content-Range, so seeking works without buffering
            // the whole file (design.md §6.1).
            <video
              src={src}
              controls
              preload="metadata"
              className="max-h-[70vh] w-full rounded-md"
            />
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
