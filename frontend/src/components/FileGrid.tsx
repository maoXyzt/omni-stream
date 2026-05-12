import { FileTile } from '@/components/FileTile'
import type { FileEntry } from '@/types/storage'

interface FileGridProps {
  entries: FileEntry[]
  prefix: string
  storageName: string
  onSelect: (entry: FileEntry) => void
}

export function FileGrid({ entries, prefix, storageName, onSelect }: FileGridProps) {
  if (entries.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground">
        Empty directory.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
      {entries.map((entry) => (
        <FileTile
          key={entry.key}
          entry={entry}
          prefix={prefix}
          storageName={storageName}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
