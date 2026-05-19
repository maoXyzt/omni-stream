// Text-file widget — like image/video/audio/link the cell value points to a
// file in storage, but the file is read and its body rendered inline. Reuses
// the Range-based chunked reader so large files load progressively (same
// semantics as TextPreview): first request returns up to one MiB, "Load
// more" advances another MiB, the header shows a Partial badge while bytes
// remain.
//
// Lives in its own module so vite can split highlight.js out of the main
// bundle — only fetched when a `text` widget is actually rendered.

import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { AlertCircle, Download, FileX, Loader2, RotateCw } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  detectLanguage,
  ensureLanguage,
  highlight,
  isLanguageBundled,
} from '@/lib/highlight'
import { resolveSrc, type SrcResolution } from '@/lib/rows-paths'
import {
  CHUNK_BYTES,
  INITIAL_STATE,
  type LoadState,
  describeFetchError,
  fetchRange,
  formatBytes,
  mergeChunk,
  splitLines,
} from '@/lib/text-chunks'

import 'highlight.js/styles/github-dark.css'

import type { RenderContext } from './rows-widgets'
import { EmptyHint } from './widget-shared'

interface TextFileProps {
  value: unknown
  src: string
  /// Optional language hint. When omitted, derived from the resolved
  /// filename's extension (the same `detectLanguage` TextPreview uses);
  /// unrecognised extensions fall back to plaintext.
  lang?: string
  maxHeight?: string
  ctx: RenderContext
}

export function WidgetText({
  value,
  src,
  lang,
  maxHeight = '24rem',
  ctx,
}: TextFileProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )

  if (!r.ok) return <ResolutionError reason={r.reason} />
  if (value === null || value === undefined || value === '') {
    return <EmptyHint />
  }
  return (
    <TextFileBody
      url={r.url}
      // Resolved storage key (when applicable) drives auto-detection of the
      // language. External http(s) URLs may have a sensible filename too, so
      // when there's no `key` we feed `url` instead — `detectLanguage` only
      // cares about the trailing extension.
      pathForLang={r.key ?? r.url}
      lang={lang}
      maxHeight={maxHeight}
      detail={resolutionDetail(r)}
    />
  )
}

function TextFileBody({
  url,
  pathForLang,
  lang,
  maxHeight,
  detail,
}: {
  url: string
  pathForLang: string
  lang: string | undefined
  maxHeight: string
  detail: string
}) {
  // useInfiniteQuery keys on the resolved URL so the same widget rendered in
  // multiple rows for distinct files each get their own cache slot. Within a
  // single file, pages are immutable so we never refetch.
  const textQuery = useInfiniteQuery({
    queryKey: ['rows-text-widget', url] as const,
    queryFn: ({ pageParam }) =>
      fetchRange(url, pageParam, pageParam + CHUNK_BYTES - 1),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.isFull ? undefined : lastPage.endByte + 1,
    staleTime: Infinity,
    retry: 1,
  })

  const state = useMemo<LoadState>(() => {
    const pages = textQuery.data?.pages ?? []
    return pages.reduce(mergeChunk, INITIAL_STATE)
  }, [textQuery.data])

  const firstLoading = textQuery.isPending && textQuery.isFetching
  const loadingNext = textQuery.isFetchingNextPage
  const errorMessage = textQuery.error ? describeFetchError(textQuery.error) : null

  // Effective language: explicit `lang` from schema wins, otherwise sniff
  // the filename. Plaintext skips highlight.js entirely.
  const effectiveLang = useMemo(() => {
    if (lang && lang.length > 0) return lang
    return detectLanguage(pathForLang)
  }, [lang, pathForLang])

  // Grammars beyond the four bundled ones load async — track readiness so
  // the first paint stays plain rather than rendering with a wrong grammar.
  const [grammarReady, setGrammarReady] = useState(
    () => isLanguageBundled(effectiveLang) || effectiveLang === 'plaintext',
  )
  useEffect(() => {
    if (effectiveLang === 'plaintext' || isLanguageBundled(effectiveLang)) {
      setGrammarReady(true)
      return
    }
    setGrammarReady(false)
    let cancelled = false
    void ensureLanguage(effectiveLang).then((ok) => {
      if (!cancelled && ok) setGrammarReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [effectiveLang])

  // Same trailing-partial trick TextPreview uses: while more bytes are
  // pending, hide the last line if it doesn't end with a newline — those
  // are usually mid-token and look broken under syntax highlighting.
  const lines = useMemo(() => {
    const all = splitLines(state.text)
    if (!state.done && !state.text.endsWith('\n') && all.length > 0) {
      all.pop()
    }
    return all
  }, [state.text, state.done])

  const highlightedLines = useMemo<string[] | null>(() => {
    if (!grammarReady || lines.length === 0 || effectiveLang === 'plaintext') {
      return null
    }
    return lines.map((line) => highlight(line, effectiveLang))
  }, [lines, effectiveLang, grammarReady])

  const isPartial = !state.done && state.text.length > 0
  const progressPercent =
    state.totalBytes !== null && state.totalBytes > 0
      ? Math.min(100, Math.round((state.bytesLoaded / state.totalBytes) * 100))
      : null

  if (firstLoading && state.text.length === 0) {
    return (
      <div className="flex w-full flex-col gap-1.5 rounded-md border bg-muted/30 p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
    )
  }

  if (errorMessage && state.text.length === 0) {
    return (
      <Alert variant="destructive" className="py-2">
        <AlertCircle className="size-4" />
        <AlertTitle className="text-xs">Failed to read text file</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span className="font-mono text-[11px] break-all">{detail}</span>
          <span className="text-xs">{errorMessage}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void textQuery.refetch()}
            disabled={textQuery.isFetching}
            className="self-start"
          >
            {textQuery.isFetching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCw className="size-4" />
            )}
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (state.text.length === 0 && state.done) {
    return <EmptyHint text="(empty file)" />
  }

  return (
    <div className="flex w-full flex-col overflow-hidden rounded-md border bg-muted/30">
      <div className="flex items-center justify-between gap-2 border-b bg-background/50 px-2 py-1 text-[11px]">
        <div className="flex min-w-0 items-center gap-1.5">
          {isPartial && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1 py-0.5 font-medium text-amber-700 dark:text-amber-400"
              title="Only part of the file has been loaded — click 'Load more' for the rest."
            >
              <AlertCircle className="size-3" />
              Partial{progressPercent !== null ? ` · ${progressPercent}%` : ''}
            </span>
          )}
          <span className="truncate font-mono text-muted-foreground" title={detail}>
            {shortenPath(detail)}
          </span>
        </div>
        <span className="shrink-0 text-muted-foreground">
          {lines.length} line{lines.length === 1 ? '' : 's'} ·{' '}
          {formatBytes(state.bytesLoaded)}
          {state.totalBytes !== null && ` / ${formatBytes(state.totalBytes)}`}
        </span>
      </div>
      <div
        className="hljs overflow-auto p-2 font-mono text-[11px] leading-relaxed"
        style={{ maxHeight }}
      >
        {lines.map((line, i) => {
          const html = highlightedLines?.[i] ?? null
          return (
            <div key={i} className="whitespace-pre-wrap break-words">
              {html !== null ? (
                <span dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                line
              )}
            </div>
          )
        })}
      </div>
      {!state.done && state.text.length > 0 && (
        <div className="flex items-center justify-end gap-2 border-t bg-background/50 px-2 py-1">
          {errorMessage && (
            <span className="mr-auto truncate text-[11px] text-destructive" title={errorMessage}>
              {errorMessage}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            disabled={loadingNext}
            onClick={() => void textQuery.fetchNextPage()}
          >
            {loadingNext ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}

function ResolutionError({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-xs italic text-destructive">
      <FileX className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-all">{reason}</span>
    </div>
  )
}

function resolutionDetail(r: SrcResolution): string {
  return r.ok ? r.key ?? r.url : ''
}

// Path strings get long quickly; for the header label show just the last two
// segments so the more-useful filename stays readable. Full path lives in
// the `title` attribute for hover.
function shortenPath(path: string): string {
  const segs = path.split('/').filter((s) => s.length > 0)
  if (segs.length <= 2) return path
  return '…/' + segs.slice(-2).join('/')
}

export default WidgetText
