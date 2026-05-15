// Highlight widget — moved into its own module so vite can split the
// highlight.js core (~110KB) out of the main bundle. Only loaded when a
// highlight widget is actually rendered. The lib/highlight helper's own
// lazy-loaders for individual languages still apply on top of this.

import { useEffect, useMemo, useState } from 'react'

import {
  ensureLanguage,
  highlight,
  isLanguageBundled,
} from '@/lib/highlight'
import { formatCellExpanded } from '@/lib/parquet'

import { EmptyHint } from './widget-shared'

import 'highlight.js/styles/github-dark.css'

interface HighlightProps {
  value: unknown
  lang: string
  maxHeight?: string
}

export function WidgetHighlight({
  value,
  lang,
  maxHeight = '24rem',
}: HighlightProps) {
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

export default WidgetHighlight
