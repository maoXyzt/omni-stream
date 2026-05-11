import type { PreviewerProps } from './types'

export function ImagePreview({ fileKey, src }: PreviewerProps) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-muted/30 p-2">
      <img
        src={src}
        alt={fileKey}
        className="h-full w-full rounded-md object-contain"
      />
    </div>
  )
}
