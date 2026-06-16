// Shared markdown → sanitized HTML renderer. Extracted so the DOMPurify
// security config lives in one place and both the rows-view widget and the
// README panel produce HTML through the same sanitize boundary.
//
// Import cost: `marked` + `dompurify` are kept out of the main bundle — callers
// should be lazy-loaded modules so Vite can split them into their own chunk.

import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'
import { Marked } from 'marked'

export const MARKDOWN_PURIFY_OPTS: DOMPurifyConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
}

// Two pre-configured instances — one per GFM setting — so `renderMarkdown`
// never mutates global marked state across concurrent calls.
const _commonmark = new Marked({ gfm: false, breaks: false, async: false })
const _gfm = new Marked({ gfm: true, breaks: false, async: false })

/// Render `text` to sanitized HTML.
///
/// - `gfm: false` — spec-strict CommonMark, no tables / task-lists / strikethrough.
///   Use for rows-view widgets where the value comes from arbitrary data fields.
/// - `gfm: true`  — GitHub Flavoured Markdown; enables tables, task-lists,
///   strikethrough. Use for README files authored for GitHub.
export function renderMarkdown(text: string, opts: { gfm: boolean }): string {
  const parser = opts.gfm ? _gfm : _commonmark
  const raw = parser.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw, MARKDOWN_PURIFY_OPTS)
}
