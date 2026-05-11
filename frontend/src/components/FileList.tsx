import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  File as FileIcon,
  FileImage,
  FileVideo,
  Folder,
  LogOut,
} from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import { ApiError, getStoredToken, setStoredToken } from '@/api/client'
import { useListFiles } from '@/hooks/use-storage'
import { PathBreadcrumb } from '@/components/PathBreadcrumb'
import { PreviewModal, type PreviewKind } from '@/components/PreviewModal'
import { TokenPrompt } from '@/components/TokenPrompt'
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

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'svg',
])
const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mov',
  'mkv',
  'm4v',
  'ogv',
])

export function FileList() {
  const queryClient = useQueryClient()
  const [prefix, setPrefix] = useState('')
  const [tokenStack, setTokenStack] = useState<Array<string | undefined>>([
    undefined,
  ])
  const [preview, setPreview] = useState<{
    key: string
    kind: PreviewKind
  } | null>(null)

  const currentToken = tokenStack[tokenStack.length - 1]
  const query = useListFiles(prefix, currentToken)

  const isAuthError =
    query.isError &&
    query.error instanceof ApiError &&
    query.error.status === 401

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

  function navigate(next: string) {
    setPrefix(next)
    setTokenStack([undefined])
  }

  function nextPage() {
    if (query.data?.next_token) {
      setTokenStack((stack) => [...stack, query.data!.next_token!])
    }
  }

  function prevPage() {
    setTokenStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack))
  }

  function handleEntry(entry: FileEntry) {
    if (entry.is_dir) {
      navigate(entry.key)
      return
    }
    const kind = previewableKind(entry.key)
    if (kind) {
      setPreview({ key: entry.key, kind })
    } else {
      window.open(proxyUrl(entry.key), '_blank', 'noreferrer')
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">OmniStream</h1>
          <PathBreadcrumb prefix={prefix} onNavigate={navigate} />
        </div>
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
      </header>

      {query.isError && <ErrorState error={query.error} />}

      {query.isPending ? (
        <ListSkeleton />
      ) : query.data ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/2">Name</TableHead>
                <TableHead className="w-32 text-right">Size</TableHead>
                <TableHead>Modified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.entries.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center text-muted-foreground py-10"
                  >
                    Empty directory.
                  </TableCell>
                </TableRow>
              )}
              {query.data.entries.map((entry) => (
                <FileRow
                  key={entry.key}
                  entry={entry}
                  prefix={prefix}
                  onSelect={handleEntry}
                />
              ))}
            </TableBody>
          </Table>

          <Pager
            hasPrev={tokenStack.length > 1}
            hasNext={Boolean(query.data.next_token)}
            isFetching={query.isFetching}
            onPrev={prevPage}
            onNext={nextPage}
          />
        </>
      ) : null}

      {preview && (
        <PreviewModal
          fileKey={preview.key}
          kind={preview.kind}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
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

function previewableKind(key: string): PreviewKind | null {
  const ext = extensionOf(key)
  if (!ext) return null
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return null
}

function iconForKey(key: string) {
  const kind = previewableKind(key)
  if (kind === 'image') return FileImage
  if (kind === 'video') return FileVideo
  return FileIcon
}

function extensionOf(key: string): string | null {
  const stripped = key.replace(/\/+$/, '')
  const dot = stripped.lastIndexOf('.')
  if (dot < 0 || dot === stripped.length - 1) return null
  return stripped.slice(dot + 1).toLowerCase()
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
