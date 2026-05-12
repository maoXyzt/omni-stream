import { Loader2 } from 'lucide-react'

// Centered loading overlay used by previewers while their underlying media
// fetches. Sits above the previewer surface but below floating toolbars.
export function PreviewSpinner() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  )
}
