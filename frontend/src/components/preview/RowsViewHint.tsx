import { LayoutList, Sparkles, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useRowsViewHint } from '@/hooks/use-rows-view-hint'

interface RowsViewHintProps {
  /// Same handler the previews wire into their "Browse as cards" button —
  /// the hint's primary CTA just calls this so the navigation logic stays
  /// in one place.
  onOpen: () => void
  /// Mirrors the "Browse as cards" button's `disabled` — true when no
  /// storage is bound (e.g. the previewer is rendered standalone outside
  /// the storage routes).
  disabled?: boolean
}

/// First-time-only banner pitching the Rows / cards view to users who land
/// on a parquet / csv / jsonl / json file. Clicking the CTA or the dismiss
/// "×" persists the dismissal globally via `useRowsViewHint` so it doesn't
/// reappear file-to-file. Once the user has explored the feature there's
/// no need to keep pestering them.
export function RowsViewHint({ onOpen, disabled }: RowsViewHintProps) {
  const { dismissed, dismiss } = useRowsViewHint()
  if (dismissed) return null

  const handleOpen = () => {
    if (disabled) return
    // Clicking through counts as discovery — drop the banner so it doesn't
    // come back when they navigate to the next file.
    dismiss()
    onOpen()
  }

  return (
    <div className="relative flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm dark:border-primary/40 dark:bg-primary/10">
      <Sparkles
        className="mt-0.5 size-4 shrink-0 text-primary"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium text-foreground">
          Try the cards view for this file
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Render each row as a custom card — images, video, markdown,
          highlighted code, side-by-side comparisons. Configure the
          layout once; the rules live in the URL so a link reproduces
          the exact view on someone else's screen.
        </p>
        <div className="mt-1">
          <Button
            type="button"
            size="sm"
            onClick={handleOpen}
            disabled={disabled}
            className="shadow-sm"
          >
            <LayoutList className="size-3.5" />
            Open cards view
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss hint"
        title="Dismiss"
        className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
