import { Info } from 'lucide-react'

const FORMAT_LABELS = {
  csv: 'CSV',
  jsonl: 'JSONL',
  json: 'JSON',
} as const

interface PartialInfoNoticeProps {
  format: keyof typeof FORMAT_LABELS
}

/// Banner displayed atop the structured views of schemaless formats (CSV,
/// JSONL, JSON). Sets expectations: column types are inferred from values,
/// the row count only resolves after the whole file has been parsed, and
/// the numbers in the header / pager may keep changing while data streams
/// in. Parquet carries a real schema + footer counts, so it doesn't need
/// this caveat.
export function PartialInfoNotice({ format }: PartialInfoNoticeProps) {
  const label = FORMAT_LABELS[format]
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-100"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">Limited metadata for {label}</p>
        <p className="text-xs leading-relaxed text-amber-900/80 dark:text-amber-100/80">
          This format carries no embedded schema — column types are inferred
          from the data, and the total row count is only known after the
          file has been fully parsed. Figures shown here may keep updating
          as more rows stream in.
        </p>
        <p className="text-xs leading-relaxed text-amber-900/80 dark:text-amber-100/80">
          Avoid forcing a full load on very large files (e.g. jumping to
          the last page of a multi-GB file): every parsed row stays in
          the browser's memory, and a runaway scan can freeze or crash
          the tab.
        </p>
      </div>
    </div>
  )
}
