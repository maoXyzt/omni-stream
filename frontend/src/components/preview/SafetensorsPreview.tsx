import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Binary, ChevronLeft, ChevronRight, Loader2, RotateCw, Search } from 'lucide-react'

import { getSafetensorsMetadata } from '@/api/storage'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDecimalBytes, formatDecimalInteger } from '@/lib/format'

import type { PreviewerProps } from './types'

const PAGE_SIZE = 100

export function SafetensorsPreview({ fileKey, storage }: PreviewerProps) {
  const [filter, setFilter] = useState('')
  const [pageIndex, setPageIndex] = useState(0)
  const query = useQuery({
    queryKey: ['safetensors-metadata', fileKey, storage] as const,
    queryFn: () => getSafetensorsMetadata(fileKey, storage),
    staleTime: 0,
    retry: false,
  })

  useEffect(() => {
    setFilter('')
    setPageIndex(0)
  }, [fileKey, storage])

  const filteredTensors = useMemo(() => {
    const tensors = query.data?.tensors ?? []
    const needle = filter.trim().toLowerCase()
    if (!needle) return tensors
    return tensors.filter(
      (tensor) => tensor.name.toLowerCase().includes(needle) || tensor.dtype.toLowerCase().includes(needle),
    )
  }, [filter, query.data?.tensors])
  const pageCount = Math.max(1, Math.ceil(filteredTensors.length / PAGE_SIZE))
  const currentPage = Math.min(pageIndex, pageCount - 1)
  const page = filteredTensors.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  if (query.isPending) return <SafetensorsSkeleton />

  if (query.isError) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Alert variant="destructive" className="max-w-xl">
          <AlertCircle />
          <AlertTitle>Failed to read Safetensors header</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>{errorMessage(query.error)}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              className="self-start"
            >
              {query.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!query.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
        <Binary className="size-8" />
        <p>No metadata was returned for this Safetensors file.</p>
      </div>
    )
  }

  const report = query.data
  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <Summary label="Tensors" value={formatDecimalInteger(String(report.tensor_count))} />
        <Summary label="Stored elements" value={formatDecimalInteger(report.total_elements)} />
        <Summary label="Weights" value={formatDecimalBytes(report.weight_bytes)} />
        <Summary label="File" value={formatDecimalBytes(report.file_bytes)} />
        <Summary label="Header" value={formatDecimalBytes(String(report.header_bytes))} />
      </div>

      <p className="text-xs text-muted-foreground">Weight storage only; runtime memory also includes caches and activations.</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {report.dtypes.map((summary) => (
          <span key={summary.dtype} className="rounded-md bg-muted px-2 py-1">
            {summary.dtype}: {summary.tensor_count} tensors · {formatDecimalBytes(summary.bytes)}
          </span>
        ))}

      </div>
      {Object.keys(report.metadata).length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
          {Object.entries(report.metadata).map(([key, value]) => (
            <span key={key} className="rounded-md bg-muted px-2 py-1">
              {key}: {value}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
              setPageIndex(0)
            }}
            placeholder="Filter tensor name or dtype"
            aria-label="Filter tensor name or dtype"
            className="pl-8"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {formatDecimalInteger(String(filteredTensors.length))} of {formatDecimalInteger(String(report.tensor_count))} tensors
        </span>
      </div>

      {filteredTensors.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {filter.trim() ? 'No tensors match this filter.' : 'No tensors were found in this Safetensors file.'}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Tensor</TableHead>
                  <TableHead>Shape</TableHead>
                  <TableHead>Precision</TableHead>
                  <TableHead className="text-right">Elements</TableHead>
                  <TableHead className="text-right">Weight size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.map((tensor) => (
                  <TableRow key={tensor.name}>
                    <TableCell className="max-w-[28rem] truncate font-mono text-xs" title={tensor.name}>
                      {tensor.name}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {tensor.shape.length === 0 ? 'scalar' : `[${tensor.shape.join(', ')}]`}
                    </TableCell>
                    <TableCell>{tensor.dtype}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatDecimalInteger(tensor.elements)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatDecimalBytes(tensor.bytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Page {currentPage + 1} of {pageCount}</span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPageIndex(currentPage - 1)}
                disabled={currentPage === 0}
                aria-label="Previous tensor page"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPageIndex(currentPage + 1)}
                disabled={currentPage >= pageCount - 1}
                aria-label="Next tensor page"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-muted-foreground">{label}</span>{' '}
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  )
}

function SafetensorsSkeleton() {
  return (
    <div className="flex h-full w-full flex-col gap-3 p-4">
      <div className="flex flex-wrap gap-6">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="h-8 w-full max-w-sm" />
      <div className="flex flex-1 flex-col gap-2 overflow-hidden">
        {Array.from({ length: 10 }).map((_, index) => <Skeleton key={index} className="h-7 w-full" />)}
      </div>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The server returned an unknown error.'
}
