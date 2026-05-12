import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Folder,
  LogOut,
  Share2,
} from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { ApiError, getStoredToken, setStoredToken } from '@/api/client'
import { useListFiles, useStorages } from '@/hooks/use-storage'
import { useViewMode } from '@/hooks/use-view-mode'
import { FileGrid } from '@/components/FileGrid'
import { PathBreadcrumb } from '@/components/PathBreadcrumb'
import { PreviewModal } from '@/components/PreviewModal'
import { iconForKey, previewableKind } from '@/components/preview/registry'
import { StorageSwitcher } from '@/components/StorageSwitcher'
import { TokenPrompt } from '@/components/TokenPrompt'
import { ViewToggle } from '@/components/ViewToggle'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { FileEntry } from '@/types/storage'

const PREVIEW_PARAM = 'preview'

export function FileList() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams()

  const storageName = params.storage ?? ''
  // React Router exposes the catch-all match under the `*` key. Normalize so
  // every non-empty prefix ends with `/` to match the backend's directory
  // convention (e.g. `videos/` not `videos`).
  const rawSplat = params['*'] ?? ''
  const prefix = useMemo(() => normalizePrefix(rawSplat), [rawSplat])

  const storagesQuery = useStorages()
  const [viewMode, setViewMode] = useViewMode()
  const [tokenStack, setTokenStack] = useState<Array<string | undefined>>([
    undefined,
  ])
  const currentToken = tokenStack[tokenStack.length - 1]
  const listQuery = useListFiles(prefix, currentToken, storageName || undefined)

  const previewName = searchParams.get(PREVIEW_PARAM)
  const previewState = useMemo(() => {
    if (!previewName) return null
    const kind = previewableKind(previewName)
    if (!kind) return null
    return { key: prefix + previewName, kind }
  }, [previewName, prefix])

  const goToPath = useCallback(
    (nextPrefix: string) => {
      // Clearing page state when switching directories is intentional: the
      // page_token cursor returned by S3 is scoped to a specific prefix.
      setTokenStack([undefined])
      const clean = normalizePrefix(nextPrefix)
      const trail = clean ? clean : ''
      navigate({
        pathname: `/s/${encodeURIComponent(storageName)}/${trail}`,
        search: '',
      })
    },
    [navigate, storageName],
  )

  const switchStorage = useCallback(
    (name: string) => {
      if (name === storageName) return
      setTokenStack([undefined])
      navigate({
        pathname: `/s/${encodeURIComponent(name)}/`,
        search: '',
      })
    },
    [navigate, storageName],
  )

  const openPreview = useCallback(
    (entry: FileEntry) => {
      const rel = stripPrefix(entry.key, prefix)
      setSearchParams(
        (sp) => {
          const next = new URLSearchParams(sp)
          next.set(PREVIEW_PARAM, rel)
          return next
        },
        { replace: false },
      )
    },
    [prefix, setSearchParams],
  )

  const closePreview = useCallback(() => {
    setSearchParams(
      (sp) => {
        const next = new URLSearchParams(sp)
        next.delete(PREVIEW_PARAM)
        return next
      },
      { replace: false },
    )
  }, [setSearchParams])

  // Keyboard navigation only steps through the previewable subset of the
  // current page — pagination boundaries are deliberate stops since the next
  // page hasn't been fetched yet.
  const previewableEntries = useMemo(
    () =>
      listQuery.data?.entries.filter(
        (e) => !e.is_dir && previewableKind(e.key),
      ) ?? [],
    [listQuery.data?.entries],
  )

  const navigatePreview = useCallback(
    (dir: 'prev' | 'next') => {
      if (!previewState || previewableEntries.length === 0) return
      const idx = previewableEntries.findIndex(
        (e) => e.key === previewState.key,
      )
      if (idx < 0) return
      const nextIdx = dir === 'next' ? idx + 1 : idx - 1
      if (nextIdx < 0 || nextIdx >= previewableEntries.length) return
      openPreview(previewableEntries[nextIdx])
    },
    [previewState, previewableEntries, openPreview],
  )

  // Once we know the storages roster, validate the URL's storage name. If it
  // doesn't exist, bounce to the server's default rather than rendering a
  // perpetual 404 for a typo'd / removed backend.
  if (
    storagesQuery.data &&
    !storagesQuery.data.storages.some((s) => s.name === storageName)
  ) {
    return (
      <Navigate
        to={`/s/${encodeURIComponent(storagesQuery.data.default)}/`}
        replace
      />
    )
  }

  const isAuthError =
    (listQuery.isError &&
      listQuery.error instanceof ApiError &&
      listQuery.error.status === 401) ||
    (storagesQuery.isError &&
      storagesQuery.error instanceof ApiError &&
      storagesQuery.error.status === 401)

  if (isAuthError) {
    return (
      <TokenPrompt
        onSubmit={() => {
          queryClient.invalidateQueries()
        }}
      />
    )
  }

  const hasToken = getStoredToken() !== null

  function nextPage() {
    if (listQuery.data?.next_token) {
      setTokenStack((stack) => [...stack, listQuery.data!.next_token!])
    }
  }

  function prevPage() {
    setTokenStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack))
  }

  function handleEntry(entry: FileEntry) {
    if (entry.is_dir) {
      goToPath(entry.key)
      return
    }
    if (previewableKind(entry.key)) {
      openPreview(entry)
      return
    }
    window.open(
      proxyUrl(entry.key, storageName || undefined),
      '_blank',
      'noreferrer',
    )
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">OmniStream</h1>
            {storagesQuery.data && (
              <StorageSwitcher
                storages={storagesQuery.data.storages}
                active={storageName}
                onChange={switchStorage}
              />
            )}
          </div>
          <PathBreadcrumb prefix={prefix} onNavigate={goToPath} />
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle mode={viewMode} onChange={setViewMode} />
          <ShareLinkButton />
          {hasToken && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStoredToken(null)
                queryClient.invalidateQueries()
              }}
            >
              <LogOut className="size-4" />
              Sign out
            </Button>
          )}
        </div>
      </header>

      {listQuery.isError && <ErrorState error={listQuery.error} />}

      {listQuery.isPending ? (
        viewMode === 'grid' ? <GridSkeleton /> : <ListSkeleton />
      ) : listQuery.data ? (
        <>
          {viewMode === 'grid' ? (
            <FileGrid
              entries={listQuery.data.entries}
              prefix={prefix}
              storageName={storageName}
              onSelect={handleEntry}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/2">Name</TableHead>
                  <TableHead className="w-32 text-right">Size</TableHead>
                  <TableHead>Modified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQuery.data.entries.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="text-center text-muted-foreground py-10"
                    >
                      Empty directory.
                    </TableCell>
                  </TableRow>
                )}
                {listQuery.data.entries.map((entry) => (
                  <FileRow
                    key={entry.key}
                    entry={entry}
                    prefix={prefix}
                    onSelect={handleEntry}
                  />
                ))}
              </TableBody>
            </Table>
          )}

          <Pager
            hasPrev={tokenStack.length > 1}
            hasNext={Boolean(listQuery.data.next_token)}
            isFetching={listQuery.isFetching}
            onPrev={prevPage}
            onNext={nextPage}
          />
        </>
      ) : null}

      {previewState && (
        <PreviewModal
          fileKey={previewState.key}
          kind={previewState.kind}
          storage={storageName || undefined}
          onClose={closePreview}
          onNavigate={navigatePreview}
        />
      )}
    </div>
  )
}

function ShareLinkButton() {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(t)
  }, [copied])

  async function onClick() {
    const url = window.location.href
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        return
      }
    } catch {
      // fall through to prompt
    }
    window.prompt('Copy this link:', url)
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      title="Copy a shareable link to this view"
    >
      {copied ? (
        <>
          <Check className="size-4" />
          Copied
        </>
      ) : (
        <>
          <Share2 className="size-4" />
          Share link
        </>
      )}
    </Button>
  )
}

interface FileRowProps {
  entry: FileEntry
  prefix: string
  onSelect: (entry: FileEntry) => void
}

function FileRow({ entry, prefix, onSelect }: FileRowProps) {
  const Icon = entry.is_dir
    ? Folder
    : iconForKey(entry.key)
  const name = displayName(entry.key, prefix)

  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50"
      onClick={() => onSelect(entry)}
    >
      <TableCell className="flex items-center gap-2 truncate">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {entry.is_dir ? '—' : formatBytes(entry.size)}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatTime(entry.last_modified)}
      </TableCell>
    </TableRow>
  )
}

interface PagerProps {
  hasPrev: boolean
  hasNext: boolean
  isFetching: boolean
  onPrev: () => void
  onNext: () => void
}

function Pager({ hasPrev, hasNext, isFetching, onPrev, onNext }: PagerProps) {
  if (!hasPrev && !hasNext) return null
  return (
    <div className="flex justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={!hasPrev || isFetching}
        onClick={onPrev}
      >
        <ChevronLeft className="size-4" />
        Prev
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!hasNext || isFetching}
        onClick={onNext}
      >
        Next
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: 12 }).map((_, i) => (
        <Skeleton key={i} className="aspect-square w-full rounded-md" />
      ))}
    </div>
  )
}

function ErrorState({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError
      ? `${error.status} — ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Unknown error.'
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" />
      <AlertTitle>Failed to load directory</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function normalizePrefix(value: string): string {
  const trimmed = value.replace(/^\/+/, '')
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

function stripPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

function displayName(key: string, prefix: string): string {
  const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key
  return rel.replace(/\/+$/, '') || key
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  // Backend may emit either an HTTP-date (S3) or unix seconds (local FS).
  const asNumber = Number(value)
  const date = Number.isFinite(asNumber) && /^\d+$/.test(value)
    ? new Date(asNumber * 1000)
    : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}
