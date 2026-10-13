import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HtmlPreview } from './HtmlPreview'

describe('HtmlPreview', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/s/other/' } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps scripts inside an opaque-origin frame, outside the app DOM', () => {
    const markup = renderToStaticMarkup(
      <HtmlPreview
        fileKey="reports/index.html"
        src="/api/proxy/reports/index.html?storage=local"
        storage="local"
        body="<script>parent.document.body.remove()</script><h1>Report</h1>"
      />,
    )
    expect(markup).toContain('sandbox="allow-scripts"')
    expect(markup).not.toContain('allow-same-origin')
    expect(markup).not.toContain('<script>')
    expect(markup).not.toContain('<h1>')
    expect(markup).toContain('title="HTML preview: index.html"')
    expect(markup).toContain('https://example.test/raw/local/reports/index.html')
    expect(markup).toContain('referrerPolicy="no-referrer"')
  })

  it('keeps the named storage and encoded file path in the resource base', () => {
    const markup = renderToStaticMarkup(
      <HtmlPreview fileKey="报告/a #1.htm" src="/unused" storage="S3 photos" body="<img src='photo.png'>" />,
    )
    expect(markup).toContain('/raw/S3%20photos/%E6%8A%A5%E5%91%8A/a%20%231.htm')
  })

  it('uses the supplied proxy URL when no storage is selected', () => {
    const markup = renderToStaticMarkup(
      <HtmlPreview fileKey="report.htm" src="/api/proxy/report.htm" body="<p>Report</p>" />,
    )
    expect(markup).toContain('https://example.test/api/proxy/report.htm')
  })
})
