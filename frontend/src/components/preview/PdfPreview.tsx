import type { PreviewerProps } from './types'

// Browsers (Chrome / Edge / Firefox / Safari) all ship a built-in PDF viewer
// that renders inside an iframe — toolbar, page navigation, zoom, and Range
// requests for progressive loading are all handled natively. The proxy serves
// `application/pdf` via mime_guess so the iframe never offers download instead
// of preview.
export function PdfPreview({ src, fileKey }: PreviewerProps) {
  return (
    <div className="flex h-full w-full overflow-hidden rounded-md bg-muted/30 p-2">
      <iframe
        src={src}
        title={fileKey}
        className="h-full w-full rounded-md border-0 bg-background"
      />
    </div>
  )
}
