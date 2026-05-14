// Widget components for the Rows View renderer. Each widget renders a single
// cell value into UI; the renderer wraps them based on the schema node.
//
// All seven widgets share a small set of placeholder/error UIs so the visual
// language stays consistent: missing data → dashed muted box; broken media →
// icon card; failed render → destructive-tinted hint.

import { useEffect, useMemo, useState } from 'react'
import { ImageOff, LinkIcon, MicOff, VideoOff } from 'lucide-react'
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'
import { marked } from 'marked'

import {
  ensureLanguage,
  highlight,
  isLanguageBundled,
} from '@/lib/highlight'
import { formatCell, formatCellExpanded } from '@/lib/parquet'
import { resolveSrc, type SrcResolution } from '@/lib/rows-paths'
import { cn } from '@/lib/utils'

import 'highlight.js/styles/github-dark.css'

export interface RenderContext {
  fileKey: string
  storage: string | undefined
}

// Marked is configured once at module load. We turn off GFM so tables /
// strikethrough / task-lists stay out (spec §2). DOMPurify sanitizes the
// produced HTML before injection — that's the actual security boundary;
// marked's deprecated `sanitize` option is not used.
marked.use({ gfm: false, breaks: false, async: false })

const PURIFY_OPTS: DOMPurifyConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
}

// -----------------------------------------------------------------------
// Default widget
// -----------------------------------------------------------------------

interface DefaultProps {
  value: unknown
  maxHeight?: string
}

export function WidgetDefault({ value, maxHeight = '18rem' }: DefaultProps) {
  if (value === null || value === undefined || value === '') {
    return <EmptyHint />
  }
  // Primitives stay inline (single-line, no frame) so they don't visually
  // dominate a row with multiple atoms. Composites use the multi-line frame.
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value instanceof Date
  ) {
    return (
      <pre
        className="overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words selection:bg-primary/20"
        style={{ maxHeight }}
      >
        {formatCell(value)}
      </pre>
    )
  }
  return (
    <pre
      className="overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words selection:bg-primary/20"
      style={{ maxHeight }}
    >
      {formatCellExpanded(value)}
    </pre>
  )
}

// -----------------------------------------------------------------------
// Highlight widget
// -----------------------------------------------------------------------

interface HighlightProps {
  value: unknown
  lang: string
  maxHeight?: string
}

export function WidgetHighlight({ value, lang, maxHeight = '24rem' }: HighlightProps) {
  const text = useMemo(() => stringifyForHighlight(value), [value])
  // Grammars beyond the four bundled ones are loaded async. While loading the
  // first paint shows the same frame but with plain (escaped) text — that's
  // what `highlight()` falls back to when the language isn't registered yet.
  const [ready, setReady] = useState(() => isLanguageBundled(lang))

  useEffect(() => {
    if (ready) return
    let cancelled = false
    void ensureLanguage(lang).then((success) => {
      if (!cancelled && success) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [lang, ready])

  if (text === '') return <EmptyHint />
  const html = highlight(text, ready ? lang : 'plaintext')
  return (
    <pre
      className="hljs overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed"
      style={{ maxHeight }}
    >
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

function stringifyForHighlight(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<binary ${value.byteLength}B>`
  return formatCellExpanded(value)
}

// -----------------------------------------------------------------------
// Image / video / audio / link — all share the resolveSrc pipeline
// -----------------------------------------------------------------------

interface MediaProps {
  value: unknown
  src: string
  ctx: RenderContext
}

export function WidgetImage({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  const url = r.ok ? r.url : ''
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])

  if (!r.ok) return <MediaError icon={ImageOff} reason={r.reason} />
  if (failed) {
    return (
      <MediaError
        icon={ImageOff}
        reason="failed to load"
        detail={resolutionDetail(r)}
      />
    )
  }
  return (
    <div className="overflow-hidden rounded-md border bg-muted/30">
      <img
        src={r.url}
        alt={resolutionDetail(r)}
        onError={() => setFailed(true)}
        loading="lazy"
        className="max-h-96 w-auto max-w-full object-contain"
      />
    </div>
  )
}

export function WidgetVideo({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  const url = r.ok ? r.url : ''
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])

  if (!r.ok) return <MediaError icon={VideoOff} reason={r.reason} />
  if (failed) {
    return (
      <MediaError
        icon={VideoOff}
        reason="failed to load"
        detail={resolutionDetail(r)}
      />
    )
  }
  return (
    <video
      src={r.url}
      controls
      onError={() => setFailed(true)}
      className="max-h-96 w-full rounded-md border bg-black"
    />
  )
}

export function WidgetAudio({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  const url = r.ok ? r.url : ''
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])

  if (!r.ok) return <MediaError icon={MicOff} reason={r.reason} />
  if (failed) {
    return (
      <MediaError
        icon={MicOff}
        reason="failed to load"
        detail={resolutionDetail(r)}
      />
    )
  }
  return (
    <audio
      src={r.url}
      controls
      onError={() => setFailed(true)}
      className="w-full"
    />
  )
}

export function WidgetLink({ value, src, ctx }: MediaProps) {
  const r = useMemo(
    () => resolveSrc(src, value, ctx.fileKey, ctx.storage),
    [src, value, ctx.fileKey, ctx.storage],
  )
  if (!r.ok) return <MediaError icon={LinkIcon} reason={r.reason} />
  return (
    <a
      href={r.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs underline-offset-2 hover:underline"
    >
      <LinkIcon className="size-3.5 shrink-0" />
      <span className="truncate">{r.url}</span>
    </a>
  )
}

// -----------------------------------------------------------------------
// Markdown widget
// -----------------------------------------------------------------------

interface MarkdownProps {
  value: unknown
  maxHeight?: string
}

export function WidgetMarkdown({ value, maxHeight = '24rem' }: MarkdownProps) {
  const text = typeof value === 'string' ? value : ''
  const html = useMemo(() => {
    if (text === '') return ''
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw, PURIFY_OPTS)
  }, [text])
  if (text === '') return <EmptyHint />
  return (
    <div
      className={cn(
        'overflow-auto rounded-md border bg-muted/30 p-3 text-sm leading-relaxed',
        // Lightweight markdown styling — we don't pull in
        // @tailwindcss/typography for a single widget. These selectors target
        // the sanitized output marked produces.
        '[&_a]:text-primary [&_a]:underline-offset-2 [&_a:hover]:underline',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
        '[&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/50 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs',
        '[&_ul]:ml-5 [&_ul]:list-disc [&_ol]:ml-5 [&_ol]:list-decimal',
        '[&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold',
        '[&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold',
        '[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-medium',
        '[&_p]:my-1',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
      )}
      style={{ maxHeight }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// -----------------------------------------------------------------------
// Shared placeholders
// -----------------------------------------------------------------------

export function EmptyHint({ text }: { text?: string } = {}) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
      {text ?? '(empty)'}
    </div>
  )
}

interface MediaErrorProps {
  icon: typeof ImageOff
  reason: string
  detail?: string
}

function MediaError({ icon: Icon, reason, detail }: MediaErrorProps) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-xs italic text-destructive">
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-all">
        {reason}
        {detail && (
          <>
            : <span className="font-mono not-italic">{detail}</span>
          </>
        )}
      </span>
    </div>
  )
}

function resolutionDetail(r: SrcResolution): string {
  return r.ok ? r.url : ''
}
