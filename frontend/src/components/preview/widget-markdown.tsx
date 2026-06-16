// Markdown widget — moved into its own module so vite can split `marked`
// and `dompurify` out of the main bundle. Only loaded when a markdown
// widget is actually rendered.

import { useMemo } from 'react'

import { cn } from '@/lib/utils'
import { renderMarkdown } from '@/lib/markdown'

import { EmptyHint } from './widget-shared'

interface MarkdownProps {
  value: unknown
  maxHeight?: string
}

export function WidgetMarkdown({ value, maxHeight = '24rem' }: MarkdownProps) {
  const text = typeof value === 'string' ? value : ''
  const html = useMemo(() => {
    if (text === '') return ''
    // GFM off: spec-strict CommonMark for arbitrary data-field values.
    return renderMarkdown(text, { gfm: false })
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

export default WidgetMarkdown
