// Shared Markdown rendering component. Extracted so the prose Tailwind styles
// and the `renderMarkdown` call live in one place — consumed by ReadmePanel
// (directory README) and TextPreview (Rendered tab for .md/.markdown files).
//
// This module imports `marked` + `dompurify` via lib/markdown.ts, so callers
// should lazy-load it (Vite splits it into a separate chunk, keeping the main
// bundle lean).

import { useMemo } from 'react'

import { renderMarkdown } from '@/lib/markdown'
import { markdownProseClass } from './markdown-prose-class'

interface MarkdownProseProps {
  /// Raw Markdown text to render. HTML is sanitized via DOMPurify before
  /// injection (see lib/markdown.ts for the sanitize config).
  body: string
}

/// Renders Markdown text as sanitized HTML with GitHub-style prose styling.
/// Uses GFM mode (tables, task-lists, strikethrough) — appropriate for README
/// files and user-authored `.md` files. Relative image links will not resolve
/// to backend keys (acceptable; same behaviour as ReadmePanel).
export function MarkdownProse({ body }: MarkdownProseProps) {
  const html = useMemo(() => renderMarkdown(body, { gfm: true }), [body])

  return (
    <div
      className={markdownProseClass}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default MarkdownProse
