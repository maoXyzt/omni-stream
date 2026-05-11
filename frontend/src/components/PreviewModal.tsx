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
}

export function PreviewModal({ fileKey, kind, storage, onClose }: Props) {
  const src = proxyUrl(fileKey, storage)
  const type = getPreviewType(kind)
  const Previewer = type?.Component

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
