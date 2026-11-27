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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatBytes } from '@/lib/format'
import { SchemaTable, Stat } from './TabularSchema'
import { PageControls } from './PageControls'
import type { PreviewerProps } from './types'

interface Page {
  version?: number
  file_format?: string
  total: number
  offset: number
  fragments?: number
  file_size?: number
  columns: (DataTableColumn & { nullable: boolean })[]
  rows: Record<string, unknown>[]
}

export function LancePreview(props: PreviewerProps) {
  return <DatasetPage key={JSON.stringify([props.storage, props.fileKey, props.fileKey.endsWith('/') ? undefined : props.src])} {...props} />
}

function DatasetPage({ storage, fileKey, src }: PreviewerProps) {
  const physical = !fileKey.endsWith('/')
  const [searchParams] = useSearchParams()
  const directory = getSidebarEntryRoute(
    { storage: storage ?? '', key: fileKey, type: 'folder' },
    searchParams.get('view') ?? undefined,
  )
  const query = useQuery({
    queryKey: ['lance-schema', storage, fileKey, physical ? src : undefined],
    queryFn: async ({ signal }) => (await apiClient.get<Page>(`/api/lance/${encodeKey(fileKey)}`, {
      params: { storage, physical: physical || undefined, schema_only: true }, signal,
    })).data,
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
  if (!physical && query.isError && query.error instanceof ApiError && query.error.isNotFound) {
    return <Navigate replace to={directory} />
  }
  const browse = !physical && (
    <Button asChild variant="outline" size="sm">
      <Link to={directory}>Browse directory</Link>
    </Button>
  )
  if (query.isError) {
    return <Alert variant="destructive">
      <AlertDescription>{query.error.message}</AlertDescription>
      <Button onClick={() => query.refetch()}>Retry</Button>
      {browse}
    </Alert>
  }
  const meta = query.data
  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-auto p-2">
      <div className="flex flex-wrap items-center gap-3">
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <Stat label={physical ? 'Physical rows' : 'Rows'} value={meta.total.toLocaleString()} />
          <Stat label="Columns" value={String(meta.columns.length)} />
          {meta.version !== undefined && <Stat label="Version" value={String(meta.version)} />}
          {meta.fragments !== undefined && <Stat label="Fragments" value={String(meta.fragments)} />}
          {meta.file_format && <Stat label="File format" value={meta.file_format} />}
          {meta.file_size !== undefined && <Stat label="Size" value={formatBytes(meta.file_size)} />}
        </dl>
        {browse}
      </div>
      <Tabs defaultValue="schema" className="min-h-0">
        <TabsList>
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>
        <TabsContent value="schema" className="overflow-auto">
          <SchemaTable modeLabel="Nullable" columns={meta.columns.map(c => ({
            ...c, repetition: c.nullable ? 'Yes' : 'No',
          }))} />
        </TabsContent>
        <TabsContent value="data" className="min-h-0 overflow-auto">
          <LanceDataPage key={meta.version} fileKey={fileKey} src={src} storage={storage} version={meta.version} totalRows={meta.total} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export function LanceDataPage({ storage, fileKey, src, version, totalRows }: PreviewerProps & { version?: number; totalRows: number }) {
  const [cursor, setCursor] = useState<LanceCursor>({ offset: 0, limit: 10, version })
  const physical = !fileKey.endsWith('/')
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
  if (query.isPending) return <Skeleton className="h-24 w-full" />
  const failedRow = query.error instanceof LanceRowTooLarge ? query.error.offset : undefined
  const data = query.data?.data
  const limit = failedRow !== undefined ? 1 : query.data?.limit ?? cursor.limit
  const offset = failedRow ?? data?.offset ?? cursor.offset
  const total = data?.total ?? totalRows
  const pageIndex = offset / limit
  const jump = (page: number, backwards = false) =>
    setCursor({ offset: page * limit, limit, version: data?.version ?? cursor.version, backwards })
  const navigation = (total > 0) && (
    <PageControls
      pageIndex={pageIndex}
      pageCount={Math.ceil(total / limit)}
      hasMore={offset + limit < total}
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
        {navigation}
      </Alert>
    )
  }
  return (
    <div className="flex min-h-0 w-full flex-col gap-2 overflow-auto p-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
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
