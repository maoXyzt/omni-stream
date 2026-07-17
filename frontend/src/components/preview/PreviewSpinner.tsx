import { Loader2 } from 'lucide-react'

// Centered loading overlay used by previewers while their underlying media
// fetches. Sits above the previewer surface but below floating toolbars.
export function PreviewSpinner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    >
      <Loader2
        aria-hidden="true"
        className="size-8 animate-spin text-muted-foreground"
      />
      <span className="sr-only">Loading preview…</span>
    </div>
  )
}
