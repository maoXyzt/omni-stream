import { FileTile } from '@/components/FileTile'
import type { GridFit } from '@/hooks/use-grid-fit'
import type { FileEntry } from '@/types/storage'

interface FileGridProps {
  entries: FileEntry[]
  prefix: string
  storageName: string
  fit: GridFit
  onSelect: (entry: FileEntry) => void
}

export function FileGrid({ entries, prefix, storageName, fit, onSelect }: FileGridProps) {
  if (entries.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground">
        Empty directory.
      </div>
    )
  }

  return (
    // `minmax(min(180px, 100%), 1fr)` is the canonical "min size N, but shrink
    // to fit when N > viewport" pattern. The inner `min()` resolves to 180px
    // on any container at least that wide, and to 100% on a narrower one —
    // collapsing the grid to a single full-width column so we never trigger
    // horizontal scroll. No breakpoints needed.
    //
    // `auto-fill` (vs `auto-fit`) keeps empty tracks reserved at their min
    // size, so a folder containing two files renders two ~180px tiles with
    // empty space to their right instead of stretching each to half the row.
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(180px,100%),1fr))] gap-3">
      {entries.map((entry) => (
        <FileTile
          key={entry.key}
          entry={entry}
          prefix={prefix}
          storageName={storageName}
          fit={fit}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
