// Prev / page-jump / Next button cluster. Shared by previewers and views
// that page through a RowsSource (CSV, Rows view, future tabular formats).
// Consumers can opt into the loading status when this control is the
// region's single indicator; `loading` always disables interaction.

import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface PageControlsProps {
  /// Zero-based; the input renders it as 1-based for display.
  pageIndex: number
  /// `null` when the total is unknown (streaming source not yet exhausted).
  /// The jump input loses its upper bound in that case but still works.
  pageCount: number | null
  /// True when more rows exist past the current page. Drives the Next
  /// button — the consumer computes this from its readRows result or
  /// derived totalRows.
  hasMore: boolean
  loading: boolean
  showLoadingStatus?: boolean
  onPrev: () => void
  onNext: () => void
  onJump: (pageIndex: number) => void
}

export function PageControls({
  pageIndex,
  pageCount,
  hasMore,
  loading,
  showLoadingStatus = false,
  onPrev,
  onNext,
  onJump,
}: PageControlsProps) {
  return (
    <div
      className="flex items-center gap-1"
      aria-busy={loading || undefined}
    >
      <Button
        variant="outline"
        size="sm"
        onClick={onPrev}
        disabled={pageIndex === 0 || loading}
      >
        <ChevronLeft className="size-4" />
        Prev
      </Button>
      <PageJumpInput
        pageIndex={pageIndex}
        pageCount={pageCount}
        // Single-page (known total of 1) means jumping is meaningless;
        // streaming sources always allow the input even if pageCount is
        // unknown so the user can jump ahead.
        disabled={loading || (pageCount !== null && pageCount <= 1)}
        onJump={onJump}
      />
      {loading && showLoadingStatus && (
        <span
          role="status"
          aria-live="polite"
          className="flex items-center gap-1 text-xs text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading page {pageIndex + 1}…
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onNext}
        disabled={!hasMore || loading}
      >
        Next
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )
}

interface PageJumpInputProps {
  pageIndex: number
  pageCount: number | null
  disabled: boolean
  onJump: (pageIndex: number) => void
}

// Editable page number — commits on Enter or blur. Tracks its own draft
// state so partial input ("12" while typing "120") doesn't fire jumps on
// every keystroke. Escape reverts the draft.
function PageJumpInput({
  pageIndex,
  pageCount,
  disabled,
  onJump,
}: PageJumpInputProps) {
  const [draft, setDraft] = useState(String(pageIndex + 1))

  useEffect(() => {
    setDraft(String(pageIndex + 1))
  }, [pageIndex])

  const commit = () => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed)) {
      setDraft(String(pageIndex + 1))
      return
    }
    // Surface a toast when we clamp a user-typed value past the known
    // total — silently snapping the input would leave them wondering
    // why "Enter" didn't take them where they asked. Streaming sources
    // (pageCount null) skip this branch and rely on the consumer's
    // post-load fallback, since "out of range" can't be known until the
    // stream resolves.
    if (pageCount !== null && parsed > pageCount) {
      toast.info(
        `Page ${parsed.toLocaleString()} doesn't exist — only ${pageCount.toLocaleString()} page${pageCount === 1 ? '' : 's'} available.`,
      )
    }
    const upper = pageCount ?? Number.MAX_SAFE_INTEGER
    const target = Math.min(upper, Math.max(1, parsed)) - 1
    if (target !== pageIndex) onJump(target)
    else setDraft(String(pageIndex + 1))
  }

  return (
    <div className="flex items-center gap-1 px-1 text-sm tabular-nums">
      <Input
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(String(pageIndex + 1))
            e.currentTarget.blur()
          }
        }}
        onBlur={commit}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Page number"
        className="h-7 w-14 text-center text-sm"
      />
      <span className="text-muted-foreground">/ {pageCount ?? '?'}</span>
    </div>
  )
}
