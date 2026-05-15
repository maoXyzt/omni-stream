import { describe, expect, it } from 'vitest'

import {
  detectFormat,
  inferJsonlColumns,
  parseJsonlText,
} from '@/lib/rows-source'

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
