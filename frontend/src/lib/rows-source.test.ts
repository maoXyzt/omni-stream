import { describe, expect, it } from 'vitest'

import {
  JsonlStream,
  detectFormat,
  inferJsonlColumns,
  parseJsonlText,
} from '@/lib/rows-source'

// Helper: build a ReadableStream that emits the provided UTF-8 chunks.
function makeByteStream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const bytes = chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : c))
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < bytes.length) {
        controller.enqueue(bytes[i++]!)
      } else {
        controller.close()
      }
    },
  })
}

describe('detectFormat', () => {
  it('recognises parquet extensions', () => {
    expect(detectFormat('a/b/data.parquet')).toBe('parquet')
    expect(detectFormat('train.parq')).toBe('parquet')
    expect(detectFormat('TRAIN.PQ')).toBe('parquet')
  })

  it('recognises jsonl + ndjson', () => {
    expect(detectFormat('logs.jsonl')).toBe('jsonl')
    expect(detectFormat('events.NDJSON')).toBe('jsonl')
  })

  it('returns null for unsupported and bare files', () => {
    expect(detectFormat('logs.csv')).toBeNull()
    expect(detectFormat('README')).toBeNull()
    expect(detectFormat('archive.tar.gz')).toBeNull()
  })
})

describe('parseJsonlText', () => {
  it('parses each line as an object', () => {
    const text = '{"a":1}\n{"a":2}\n{"a":3}\n'
    expect(parseJsonlText(text)).toEqual({
      rows: [{ a: 1 }, { a: 2 }, { a: 3 }],
      errors: 0,
    })
  })

  it('reads the final line without trailing newline', () => {
    expect(parseJsonlText('{"a":1}\n{"a":2}')).toEqual({
      rows: [{ a: 1 }, { a: 2 }],
      errors: 0,
    })
  })

  it('skips blank and whitespace-only lines silently', () => {
    const text = '{"a":1}\n\n   \n\t\n{"a":2}\n'
    expect(parseJsonlText(text)).toEqual({
      rows: [{ a: 1 }, { a: 2 }],
      errors: 0,
    })
  })

  it('handles CRLF line endings', () => {
    expect(parseJsonlText('{"a":1}\r\n{"a":2}\r\n')).toEqual({
      rows: [{ a: 1 }, { a: 2 }],
      errors: 0,
    })
  })

  it('strips UTF-8 BOM at start', () => {
    expect(parseJsonlText('﻿{"a":1}\n{"a":2}')).toEqual({
      rows: [{ a: 1 }, { a: 2 }],
      errors: 0,
    })
  })

  it('counts malformed lines but keeps parsing', () => {
    const text = '{"a":1}\nnot json\n{"b":2}\n'
    expect(parseJsonlText(text)).toEqual({
      rows: [{ a: 1 }, { b: 2 }],
      errors: 1,
    })
  })

  it('counts top-level non-objects as errors', () => {
    const text = '{"a":1}\n42\n"hello"\n[1,2,3]\nnull\n{"b":2}\n'
    expect(parseJsonlText(text)).toEqual({
      rows: [{ a: 1 }, { b: 2 }],
      errors: 4,
    })
  })

  it('empty input → empty rows, zero errors', () => {
    expect(parseJsonlText('')).toEqual({ rows: [], errors: 0 })
    expect(parseJsonlText('\n\n\n')).toEqual({ rows: [], errors: 0 })
  })
})

describe('inferJsonlColumns', () => {
  it('preserves first-occurrence order across rows', () => {
    const rows: Record<string, unknown>[] = [
      { a: 1, b: 'x' },
      { b: 'y', c: true },
      { d: null },
    ]
    expect(inferJsonlColumns(rows, 100).map((c) => c.name)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('infers a single type when uniform', () => {
    const rows = [{ a: 'x' }, { a: 'y' }]
    expect(inferJsonlColumns(rows, 100)).toEqual([{ name: 'a', type: 'STRING' }])
  })

  it('joins multiple observed types with " | " (sorted)', () => {
    const rows = [{ a: 'x' }, { a: 42 }, { a: null }]
    expect(inferJsonlColumns(rows, 100)).toEqual([
      { name: 'a', type: 'INT | STRING | null' },
    ])
  })

  it('distinguishes INT and FLOAT', () => {
    expect(inferJsonlColumns([{ x: 1 }, { x: 1.5 }], 100)).toEqual([
      { name: 'x', type: 'FLOAT | INT' },
    ])
  })

  it('recognises LIST and STRUCT', () => {
    const rows = [{ tags: ['a'], meta: { k: 1 } }]
    expect(inferJsonlColumns(rows, 100)).toEqual([
      { name: 'tags', type: 'LIST' },
      { name: 'meta', type: 'STRUCT' },
    ])
  })

  it('limits inference to first sampleSize rows', () => {
    const rows = [
      { a: 1 },
      { a: 2 },
      { b: 'x' }, // outside sample of 2 → b not picked up
    ]
    expect(inferJsonlColumns(rows, 2).map((c) => c.name)).toEqual(['a'])
  })

  it('handles empty input gracefully', () => {
    expect(inferJsonlColumns([], 100)).toEqual([])
  })
})

describe('JsonlStream', () => {
  it('streams a single-chunk input to completion', async () => {
    const s = new JsonlStream(makeByteStream(['{"a":1}\n{"a":2}\n{"a":3}\n']))
    await s.ensureRowCount(100)
    expect(s.done).toBe(true)
    expect(s.rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
    expect(s.errors).toBe(0)
  })

  it('reassembles records split across chunk boundaries', async () => {
    // Boundary lands mid-line for record #1 and mid-value for record #2.
    const s = new JsonlStream(
      makeByteStream(['{"a":', '1}\n{"a":2', ',"b":3}\n{"c":4}']),
    )
    await s.ensureRowCount(100)
    expect(s.rows).toEqual([{ a: 1 }, { a: 2, b: 3 }, { c: 4 }])
    expect(s.done).toBe(true)
  })

  it('stops after target is met without draining the rest', async () => {
    let pulls = 0
    const enc = new TextEncoder()
    const chunks = [
      enc.encode('{"a":1}\n{"a":2}\n'),
      enc.encode('{"a":3}\n{"a":4}\n'),
      enc.encode('{"a":5}\n'),
    ]
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (pulls <= chunks.length) {
          controller.enqueue(chunks[pulls - 1]!)
        } else {
          controller.close()
        }
      },
    })
    const s = new JsonlStream(stream)
    await s.ensureRowCount(2)
    // First chunk yields rows 1 + 2; loop exits before pulling chunk 2.
    expect(s.rows.length).toBe(2)
    expect(s.done).toBe(false)
    // Next call resumes from the same reader; doesn't re-read chunk 1.
    // After consuming rows 3,4,5 we exit at rows.length===5; the close
    // event arrives on the *next* read, which the next ensureRowCount or
    // a final probe will trigger.
    await s.ensureRowCount(5)
    expect(s.rows.length).toBe(5)
    await s.ensureRowCount(6)
    expect(s.done).toBe(true)
  })

  it('handles file with no trailing newline', async () => {
    const s = new JsonlStream(makeByteStream(['{"a":1}\n{"a":2}']))
    await s.ensureRowCount(100)
    expect(s.done).toBe(true)
    expect(s.rows).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('counts malformed lines and keeps streaming', async () => {
    const s = new JsonlStream(
      makeByteStream(['{"a":1}\nnot json\n{"b":2}\n42\n[1,2]\n']),
    )
    await s.ensureRowCount(100)
    expect(s.rows).toEqual([{ a: 1 }, { b: 2 }])
    expect(s.errors).toBe(3)
  })

  it('strips UTF-8 BOM split across chunks', async () => {
    const enc = new TextEncoder()
    const bom = enc.encode('﻿')
    const s = new JsonlStream(
      makeByteStream([
        bom.slice(0, 2), // partial BOM (will buffer in decoder)
        new Uint8Array([...bom.slice(2), ...enc.encode('{"a":1}\n')]),
        enc.encode('{"a":2}\n'),
      ]),
    )
    await s.ensureRowCount(100)
    expect(s.rows).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('skips blank lines without counting them as errors', async () => {
    const s = new JsonlStream(
      makeByteStream(['{"a":1}\n\n  \n\t\n{"a":2}\n']),
    )
    await s.ensureRowCount(100)
    expect(s.rows).toEqual([{ a: 1 }, { a: 2 }])
    expect(s.errors).toBe(0)
  })

  it('serializes concurrent ensureRowCount calls', async () => {
    const s = new JsonlStream(makeByteStream(['{"a":1}\n{"a":2}\n{"a":3}\n']))
    // Fire two requests at the same time. Both should resolve consistently
    // — no duplicated chunk processing, no interleaved buffer state.
    await Promise.all([s.ensureRowCount(2), s.ensureRowCount(3)])
    expect(s.rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it('ensureRowCount is a no-op when target already met', async () => {
    const s = new JsonlStream(makeByteStream(['{"a":1}\n{"a":2}\n']))
    await s.ensureRowCount(100)
    expect(s.rows.length).toBe(2)
    // Should resolve synchronously-ish without reading anything more.
    await s.ensureRowCount(1)
    expect(s.rows.length).toBe(2)
  })
})
