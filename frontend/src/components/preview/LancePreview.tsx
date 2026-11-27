import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, Navigate, useSearchParams } from 'react-router-dom'

import { apiClient, ApiError } from '@/api/client'
import { getSidebarEntryRoute } from '@/lib/route-path'
import { LanceRowTooLarge, readLancePage, type LanceCursor } from '@/lib/lance-page'
import { encodeKey } from '@/lib/path'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable, type DataTableColumn } from './DataTable'
import { PageControls } from './PageControls'
import type { PreviewerProps } from './types'

interface Page {
  version?: number
  file_format?: string
  total: number
  offset: number
  columns: DataTableColumn[]
  rows: Record<string, unknown>[]
}

export function LancePreview(props: PreviewerProps) {
  return <DatasetPage key={JSON.stringify([props.storage, props.fileKey, props.fileKey.endsWith('/') ? undefined : props.src])} {...props} />
}

function DatasetPage({ storage, fileKey, src }: PreviewerProps) {
  const [cursor, setCursor] = useState<LanceCursor & { total?: number }>({ offset: 0, limit: 10 })
  const physical = !fileKey.endsWith('/')
  const [searchParams] = useSearchParams()
  const directory = getSidebarEntryRoute(
    { storage: storage ?? '', key: fileKey, type: 'folder' },
    searchParams.get('view') ?? undefined,
  )
  const query = useQuery({
    queryKey: ['lance', storage, fileKey, physical ? src : undefined, cursor],
    queryFn: ({ signal }) => readLancePage(cursor, async (offset, limit) => {
      const { data } = await apiClient.get<Page>(`/api/lance/${encodeKey(fileKey)}`, {
        params: { storage, physical: physical || undefined, offset, limit, version: cursor.version },
        signal,
      })
      return data
    }),
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
  })
  if (query.isPending) {
    return (
      <div className="w-full space-y-2 p-3">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}
      </div>
    )
  }
  if (!physical && query.isError && query.error instanceof ApiError && query.error.isNotFound && !cursor.version) {
    return <Navigate replace to={directory} />
  }
  const browse = !physical && (
    <Button asChild variant="outline" size="sm">
      <Link to={directory}>Browse directory</Link>
    </Button>
  )
  const failedRow = query.error instanceof LanceRowTooLarge ? query.error.offset : undefined
  const data = query.data?.data
  const limit = failedRow !== undefined ? 1 : query.data?.limit ?? cursor.limit
  const offset = failedRow ?? data?.offset ?? cursor.offset
  const total = data?.total ?? cursor.total
  const pageIndex = offset / limit
  const jump = (page: number, backwards = false) =>
    setCursor({ offset: page * limit, limit, total, version: data?.version ?? cursor.version, backwards })
  const navigation = (total !== undefined ? total > 0 : failedRow !== undefined || offset > 0) && (
    <PageControls
      pageIndex={pageIndex}
      pageCount={total === undefined ? null : Math.ceil(total / limit)}
      hasMore={total === undefined || offset + limit < total}
      loading={query.isFetching}
      showLoadingStatus
      onPrev={() => jump(pageIndex - 1, true)}
      onNext={() => jump(pageIndex + 1)}
      onJump={jump}
    />
  )
  if (query.isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{query.error?.message}</AlertDescription>
        <Button onClick={() => query.refetch()}>Retry</Button>
        {browse}
        {navigation}
      </Alert>
    )
  }
  return (
    <div className="flex min-h-0 w-full flex-col gap-2 overflow-auto p-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{physical
          ? `Lance file · format ${data.file_format} · ${data.total.toLocaleString()} physical rows`
          : `Lance · v${data.version} · ${data.total.toLocaleString()} rows`}</span>
        {browse}
        {navigation}
      </div>
      <DataTable
        columns={data.columns}
        rows={data.rows}
        loading={false}
        pageIndex={pageIndex}
        pageSize={limit}
      />
    </div>
  )
}
