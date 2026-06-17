import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatCell, formatCellExpanded } from '@/lib/parquet'
import { cn } from '@/lib/utils'

// Accept any column descriptor that provides a name and a display type. Both
// ParquetColumnInfo ({ name, type, repetition }) and QueryColumn ({ name, type
// }) satisfy this — the extra `repetition` field on Parquet columns is simply
// ignored here.
export interface DataTableColumn {
  name: string
  type: string
}

export interface DataTableProps {
  columns: DataTableColumn[]
  rows: Record<string, unknown>[]
  loading: boolean
  /// Zero-based page index. Combined with `pageSize` so the row counter,
  /// React keys, and the cell-expansion dialog all reference the row's
  /// position in the full dataset rather than its position within this page.
  pageIndex: number
  pageSize: number
}

interface SortState {
  column: string
  dir: 'asc' | 'desc'
}

interface ExpandedCell {
  rowIndex: number
  column: string
  text: string
}

// ---------------------------------------------------------------------------
// Type-aware row comparator (current page only)
// ---------------------------------------------------------------------------
//
// Columns have a runtime type tracked by `cellTone`. We sort using the same
// signal so numeric columns sort numerically, dates chronologically, booleans
// by truthiness, and everything else lexicographically. Null/undefined values
// always sink to the bottom regardless of direction.

function compareValues(a: unknown, b: unknown): number {
  // Nullish → always last
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1

  // Numbers and BigInts — JS relational operators work across number↔bigint at
  // runtime, so we cast through `unknown` to satisfy TypeScript without any
  // conversion that could lose precision (Number(bigint)) or throw (BigInt(NaN)).
  if (
    (typeof a === 'number' || typeof a === 'bigint') &&
    (typeof b === 'number' || typeof b === 'bigint')
  ) {
    const av = a as unknown as number
    const bv = b as unknown as number
    return av < bv ? -1 : av > bv ? 1 : 0
  }

  // Dates — compare epoch ms.
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()

  // Booleans — true before false (asc order)
  if (typeof a === 'boolean' && typeof b === 'boolean')
    return a === b ? 0 : a ? -1 : 1

  // Uint8Array and objects — not meaningfully orderable; fall through to string.
  return collator.compare(
    typeof a === 'object' ? formatCellForSort(a) : String(a),
    typeof b === 'object' ? formatCellForSort(b) : String(b),
  )
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/// Lightweight serialisation for sort purposes (not display). Uses the same
/// `formatCell` helper the cells use for display to stay consistent.
function formatCellForSort(v: unknown): string {
  if (v instanceof Uint8Array) return `<binary ${v.byteLength}B>`
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DataTable({ columns, rows, loading, pageIndex, pageSize }: DataTableProps) {
  // Single dialog instance for the whole table — beats wiring up Dialog +
  // state inside every cell (which would be hundreds of unmounted dialogs).
  const [expanded, setExpanded] = useState<ExpandedCell | null>(null)

  // Column sort state — null means "no sort" (insertion order).
  const [sortState, setSortState] = useState<SortState | null>(null)

  // Reset sort when the page changes. Use the "adjust state during render"
  // pattern (like ImagePreview tracks `src`) to avoid a flash: track the last
  // pageIndex we saw, and if it changed, clear sort synchronously.
  const [trackedPage, setTrackedPage] = useState(pageIndex)
  if (pageIndex !== trackedPage) {
    setTrackedPage(pageIndex)
    setSortState(null)
  }

  // Derive display rows from `rows` + `sortState`. Memoized so we only
  // re-sort when either input actually changes, not on every render.
  const displayRows = useMemo(() => {
    if (!sortState) return rows
    const { column, dir } = sortState
    const factor = dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[column]
      const bv = b[column]
      // Nullish values always sink to the bottom regardless of sort direction.
      // Applying `factor` to the null guard would flip them to the top in desc.
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return factor * compareValues(av, bv)
    })
  }, [rows, sortState])

  function handleHeaderClick(column: string) {
    setSortState((prev) => {
      if (!prev || prev.column !== column) return { column, dir: 'asc' }
      if (prev.dir === 'asc') return { column, dir: 'desc' }
      // Third click clears the sort
      return null
    })
  }

  if (loading) {
    return (
      <div className="flex-1 space-y-2 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    )
  }
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border">
        <Table className="font-mono text-xs">
          {/* `[&_tr]:border-0` removes the inherited bottom border on the
              header row so it doesn't double up with the box-shadow line we
              use to keep a divider visible while the header is sticky. */}
          <TableHeader className="sticky top-0 z-10 bg-muted/70 backdrop-blur-sm shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-0">
            <TableRow>
              <TableHead className="w-12 text-right align-bottom text-muted-foreground">
                #
              </TableHead>
              {columns.map((c) => {
                const isSorted = sortState?.column === c.name
                const dir = isSorted ? sortState!.dir : null
                return (
                  <TableHead
                    key={c.name}
                    // `h-auto` lifts the 40px row-height cap that the base
                    // TableHead style sets — needed so the two-line
                    // (name + type) header doesn't crunch its second line.
                    className="h-auto max-w-xs py-2 align-bottom text-foreground"
                  >
                    {/* Clickable sort button. Cycles: unsorted → asc → desc → unsorted.
                        A tooltip surfaces the "sorts this page only" caveat so
                        users are never misled about cross-page behaviour. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleHeaderClick(c.name)}
                          className={cn(
                            'flex w-full flex-col gap-0.5 leading-tight text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm transition-colors',
                            isSorted ? 'text-foreground' : 'text-muted-foreground',
                          )}
                          aria-label={
                            dir === 'asc'
                              ? `Sorted ascending by ${c.name} — click to sort descending`
                              : dir === 'desc'
                                ? `Sorted descending by ${c.name} — click to clear`
                                : `Sort by ${c.name}`
                          }
                        >
                          <span className="flex items-center gap-1">
                            <span>{c.name}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {dir === 'asc' ? (
                                <ArrowDown className="size-3" />
                              ) : dir === 'desc' ? (
                                <ArrowUp className="size-3" />
                              ) : (
                                <ArrowUpDown className="size-3 opacity-40" />
                              )}
                            </span>
                          </span>
                          {/* `title` surfaces the full type when the column is
                              narrow and the signature gets truncated; the Schema
                              tab has the canonical view either way. */}
                          <span
                            className="truncate text-[10px] font-normal text-rose-700/90 dark:text-rose-300/90"
                            title={c.type}
                          >
                            {c.type}
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        {dir === 'asc'
                          ? `Sorted ascending (click for descending) · this page only`
                          : dir === 'desc'
                            ? `Sorted descending (click to clear) · this page only`
                            : `Sort by ${c.name} · this page only`}
                      </TooltipContent>
                    </Tooltip>
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayRows.map((row, i) => {
              // Absolute index keeps row numbering ("row 101" on page 2,
              // not restarting at 1), gives stable React keys across
              // paginations, and lets the cell-expansion dialog report
              // the row's actual position in the dataset.
              const absoluteIndex = pageIndex * pageSize + i
              return (
              // Zebra striping (odd rows tinted) makes long-row scanning
              // dramatically easier. `hover:` wins thanks to pseudo-class
              // precedence in browsers; explicit class kept on cells.
              <TableRow key={absoluteIndex} className="odd:bg-muted/30">
                <TableCell className="bg-muted/40 text-right align-top text-muted-foreground tabular-nums">
                  {absoluteIndex + 1}
                </TableCell>
                {columns.map((c) => {
                  const value = row[c.name]
                  const text = formatCell(value)
                  return (
                    <DataCell
                      key={c.name}
                      value={value}
                      text={text}
                      onExpand={() =>
                        setExpanded({
                          rowIndex: absoluteIndex,
                          column: c.name,
                          // Dialog gets the pretty-printed JSON for composites
                          // so users see the full nested structure instead of
                          // the cell's collapsed `{n fields}` summary.
                          text: formatCellExpanded(value),
                        })
                      }
                    />
                  )
                })}
              </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <CellValueDialog
        cell={expanded}
        onClose={() => setExpanded(null)}
      />
    </>
  )
}

// Every cell is exactly one line tall — keeps rows dense and scannable like
// a spreadsheet. Short values render plain (no extra DOM); anything that
// might overflow the column (>30 chars or contains newlines) becomes a
// clickable button with a hover-preview tooltip, and the full value lives in
// the dialog reached on click. The dialog is what handles arbitrarily long
// strings: tooltips can't be scrolled with the mouse (Radix closes them
// when the cursor leaves the trigger), so we cap the tooltip preview and
// nudge users toward the click action.
const LONG_VALUE_CHARS = 30
const TOOLTIP_PREVIEW_CAP = 2000

// Cell text tone keyed off the raw value's runtime type. Light/dark mode
// variants picked at 600/300 — strong enough to read against the zebra-tint
// background, soft enough to not feel like a syntax-highlight rave.
type CellTone =
  | 'default'
  | 'number'
  | 'boolean'
  | 'null'
  | 'binary'
  | 'date'
  | 'json'

function cellTone(value: unknown): CellTone {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'bigint') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (value instanceof Uint8Array) return 'binary'
  if (value instanceof Date) return 'date'
  if (typeof value === 'object') return 'json'
  return 'default'
}

const TONE_CLASS: Record<CellTone, string> = {
  default: 'text-foreground',
  number: 'text-sky-700 tabular-nums dark:text-sky-300',
  boolean: 'text-violet-700 dark:text-violet-300',
  null: 'italic text-muted-foreground',
  binary: 'italic text-amber-700 dark:text-amber-300',
  date: 'text-emerald-700 dark:text-emerald-300',
  json: 'text-rose-700 dark:text-rose-300',
}

interface DataCellProps {
  value: unknown
  text: string
  onExpand: () => void
}

function DataCell({ value, text, onExpand }: DataCellProps) {
  const tone = TONE_CLASS[cellTone(value)]
  const isLong = text.length > LONG_VALUE_CHARS || text.includes('\n')
  if (!isLong) {
    // line-clamp-5 caps the visual height even for unexpectedly long short
    // values (e.g. a 28-char id that wraps in a squeezed column); the wrap
    // classes let natural strings break instead of overflowing the cell.
    return (
      <TableCell className="max-w-xs align-top">
        <span
          className={cn(
            'block whitespace-pre-wrap break-words line-clamp-5',
            tone,
          )}
        >
          {text}
        </span>
      </TableCell>
    )
  }
  const tooltipText =
    text.length > TOOLTIP_PREVIEW_CAP
      ? `${text.slice(0, TOOLTIP_PREVIEW_CAP)}\n…(click cell to see all ${text.length.toLocaleString()} chars)`
      : text
  return (
    // p-0 so the inner button can own padding and the hover background paints
    // edge-to-edge inside the cell.
    <TableCell className="max-w-xs p-0 align-top">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={onExpand}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onExpand()
              }
            }}
            className={cn(
              'block w-full cursor-pointer whitespace-pre-wrap break-words line-clamp-5 px-2 py-2 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
              tone,
            )}
          >
            {text}
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="bg-popover text-popover-foreground max-h-[60vh] max-w-2xl overflow-hidden whitespace-pre-wrap break-words border font-mono text-xs"
        >
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TableCell>
  )
}

interface CellValueDialogProps {
  cell: ExpandedCell | null
  onClose: () => void
}

function CellValueDialog({ cell, onClose }: CellValueDialogProps) {
  const [copied, setCopied] = useState(false)

  // Reset the "Copied" pill whenever the dialog reopens on a new cell.
  useEffect(() => {
    if (!cell) setCopied(false)
  }, [cell])

  const handleCopy = async () => {
    if (!cell) return
    try {
      await navigator.clipboard.writeText(cell.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can fail (insecure context, permission denied);
      // silently no-op rather than crash the dialog.
    }
  }

  return (
    <Dialog open={cell !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-3xl gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            <span className="font-mono text-sm">{cell?.column}</span>
            {cell && (
              <span className="text-xs font-normal text-muted-foreground">
                row {cell.rowIndex + 1} · {cell.text.length.toLocaleString()} chars
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words selection:bg-primary/20">
          {cell?.text}
        </pre>
        <DialogFooter showCloseButton>
          <Button variant="outline" onClick={handleCopy}>
            {copied ? (
              <>
                <Check className="size-4" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-4" />
                Copy
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
