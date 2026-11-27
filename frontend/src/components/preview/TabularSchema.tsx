import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

export function Stat({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value}</dd>
    </div>
  )
}

export function SchemaTable({ columns, modeLabel = 'Repetition' }: {
  columns: { name: string; type: string; repetition: string; omitted?: boolean }[]
  modeLabel?: string
}) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader className="bg-muted/70 [&_tr]:border-b">
          <TableRow>
            <TableHead className="w-48 text-foreground">Name</TableHead>
            <TableHead className="text-foreground">Type</TableHead>
            <TableHead className="w-28 text-foreground">{modeLabel}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {columns.map((c) => (
            <TableRow key={c.name} className="odd:bg-muted/30">
              <TableCell className="font-mono text-xs align-top text-sky-700 dark:text-sky-300">
                {c.name}
              </TableCell>
              {/* Nested signatures (LIST<STRUCT<...>>) can get long; allow
                  wrapping at type-list boundaries so the table stays usable. */}
              <TableCell className="font-mono text-xs whitespace-normal break-words align-top text-rose-700 dark:text-rose-300">
                {c.type}
                {c.omitted && <span className="ml-2 text-muted-foreground">(value omitted)</span>}
              </TableCell>
              <TableCell
                className={cn(
                  'text-xs align-top',
                  c.repetition === 'REQUIRED' && 'text-emerald-700 dark:text-emerald-300',
                  c.repetition === 'OPTIONAL' && 'text-muted-foreground',
                  c.repetition === 'REPEATED' && 'text-violet-700 dark:text-violet-300',
                )}
              >
                {c.repetition}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
