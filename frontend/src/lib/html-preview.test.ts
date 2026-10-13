import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import { htmlPreviewDocument } from './html-preview'

describe('htmlPreviewDocument', () => {
  it.each([
    ['#100%', ['100%'], '100%'],
    ['#%E0%A4%A', ['%E0%A4%A'], '%E0%A4%A'],
    ['#a%20b', ['a%20b', 'a b'], 'a%20b'],
    ['#a%20b', ['a b'], 'a b'],
    ['#100%', [], null],
    ['#', [], null],
    ['#missing', [], null],
  ] as const)('handles fragment %s with IDs %j', (href, ids, expected) => {
    const scrolls = new Map<string, ReturnType<typeof vi.fn>>(ids.map(id => [id, vi.fn()]))
    let click: (event: unknown) => void = () => { throw new Error('Missing click handler') }
    class Element {
      closest() { return this }
      getAttribute() { return href }
    }
    const html = htmlPreviewDocument('', 'https://example.test/report.html')
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeDefined()
    const location = { hash: 'initial' }
    runInNewContext(script!, {
      Element,
      document: {
        addEventListener: (_: string, handler: typeof click) => { click = handler },
        getElementById: (id: string) => scrolls.has(id)
          ? { scrollIntoView: scrolls.get(id) } : null,
      },
      location,
    })
    const preventDefault = vi.fn()
    expect(() => click({ target: new Element(), preventDefault })).not.toThrow()
    expect(preventDefault).toHaveBeenCalledTimes(1)
    const expectedHash = href === '#' ? '' : `#${encodeURIComponent(expected ?? href.slice(1))}`
    expect(location.hash).toBe(expectedHash)
    for (const [id, scroll] of scrolls) {
      expect(scroll).toHaveBeenCalledTimes(id === expected ? 1 : 0)
    }
  })

  it('sets the resource base before authored markup without modifying scripts', () => {
    const body = '<!DOCTYPE html><html lang="zh"><body><script>const label = "你好"</script></body></html>'
    const document = htmlPreviewDocument(body, 'https://example.test/raw/local/reports/index.html')
    expect(document).toContain(
      '<!doctype html>\n<base href="https://example.test/raw/local/reports/index.html">\n',
    )
    expect(document).toContain('a[href^="#"]')
    expect(document).toContain(body)
  })

  it('escapes the base URL so it cannot inject attributes or markup', () => {
    const document = htmlPreviewDocument('<h1>Report</h1>', 'https://example.test/a?x="<script>&y=1')
    expect(document).toContain('href="https://example.test/a?x=&quot;&lt;script&gt;&amp;y=1"')
    expect(document).not.toContain('href="https://example.test/a?x="<script>')
  })
})
