import type { PreviewerProps } from './types'

export function VideoPreview({ src }: PreviewerProps) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-muted/30 p-2">
      {/* <video> issues HTTP Range requests automatically; the backend returns
          206 with Content-Range, so seeking works without buffering the whole
          file (design.md §6.1). */}
      <video
        src={src}
        controls
        preload="metadata"
        className="h-full w-full rounded-md object-contain"
      />
    </div>
  )
}
