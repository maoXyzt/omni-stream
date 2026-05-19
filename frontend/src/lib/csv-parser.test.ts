import { describe, expect, it } from 'vitest'

import { CsvStream, csvSeparatorFor, parseCsvText } from '@/lib/csv-parser'

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

describe('parseCsvText — quoting and escapes', () => {
  it('splits a plain CSV body', () => {
    expect(parseCsvText('a,b,c\n1,2,3\n')).toEqual({
      rows: [
        ['a', 'b', 'c'],
        ['1', '2', '3'],
      ],
      errors: 0,
    })
  })

  it('reads the final row without trailing newline', () => {
    expect(parseCsvText('a,b\n1,2').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('handles CRLF line endings', () => {
    expect(parseCsvText('a,b\r\n1,2\r\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('preserves the separator and newlines inside quoted fields', () => {
    expect(parseCsvText('a,b\n"x,y","line1\nline2"\n').rows).toEqual([
      ['a', 'b'],
      ['x,y', 'line1\nline2'],
    ])
  })

  it('decodes "" as a literal quote inside quoted fields', () => {
    expect(parseCsvText('a\n"she said ""hi"""\n').rows).toEqual([
      ['a'],
      ['she said "hi"'],
    ])
  })

  it('treats empty fields as empty strings', () => {
    expect(parseCsvText('a,b,c\n,,\n1,,3\n').rows).toEqual([
      ['a', 'b', 'c'],
      ['', '', ''],
      ['1', '', '3'],
    ])
  })

  it('skips blank lines between rows', () => {
    expect(parseCsvText('a\n1\n\n\n2\n').rows).toEqual([['a'], ['1'], ['2']])
  })

  it('strips a leading BOM', () => {
    expect(parseCsvText('﻿a,b\n1,2\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('counts junk-after-quote as an error but keeps parsing', () => {
    // RFC 4180 forbids `"a"bc,d` — we tolerate it by appending the junk to
    // the field. Increments the error counter so callers can surface it.
    const result = parseCsvText('a,b\n"x"y,z\n')
    expect(result.rows).toEqual([
      ['a', 'b'],
      ['xy', 'z'],
    ])
    expect(result.errors).toBe(1)
  })

  it('counts an unclosed quote as an error at EOF', () => {
    const result = parseCsvText('a\n"unterminated\n')
    expect(result.rows).toEqual([['a'], ['unterminated\n']])
    expect(result.errors).toBe(1)
  })

  it('returns no rows for an empty or whitespace-only file', () => {
    expect(parseCsvText('').rows).toEqual([])
    expect(parseCsvText('\n\n\n').rows).toEqual([])
  })

  it('accepts a custom separator (TSV)', () => {
    expect(parseCsvText('a\tb\n1\t2\n', '\t').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('CsvStream', () => {
  it('captures the header from the first row and keys data rows by it', async () => {
    const body = makeByteStream(['a,b,c\n1,2,3\n4,5,6\n'])
    const s = new CsvStream(body)
    await s.ensureRowCount(2)
    expect(s.header).toEqual(['a', 'b', 'c'])
    expect(s.rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ])
  })

  it('respects chunk boundaries inside quoted fields', async () => {
    // Split the bytes mid-quote so the parser has to remember `in-quoted`
    // across reads. Without correct state handling the comma inside the
    // quoted field would split the row.
    const body = makeByteStream(['a,b\n"hello, ', 'world",ok\n'])
    const s = new CsvStream(body)
    await s.ensureRowCount(1)
    expect(s.rows).toEqual([{ a: 'hello, world', b: 'ok' }])
  })

  it('resolves done with whatever rows arrived once the stream closes', async () => {
    const body = makeByteStream(['a,b\n1,2\n'])
    const s = new CsvStream(body)
    // Ask for more rows than the stream contains — should still resolve.
    await s.ensureRowCount(50)
    expect(s.done).toBe(true)
    expect(s.rows).toEqual([{ a: '1', b: '2' }])
  })

  it('renames empty / duplicate header columns to stay non-empty and unique', async () => {
    // First col blank → column_1; duplicate "a" → a_2; this keeps lookup
    // by header key well-defined.
    const body = makeByteStream([',a,a\n1,2,3\n'])
    const s = new CsvStream(body)
    await s.ensureRowCount(1)
    expect(s.header).toEqual(['column_1', 'a', 'a_2'])
    expect(s.rows).toEqual([{ column_1: '1', a: '2', a_2: '3' }])
  })

  it('preserves over-wide rows under __extra_N keys', async () => {
    const body = makeByteStream(['a,b\n1,2,3,4\n'])
    const s = new CsvStream(body)
    await s.ensureRowCount(1)
    expect(s.rows).toEqual([{ a: '1', b: '2', __extra_3: '3', __extra_4: '4' }])
  })

  it('pads short rows with empty strings', async () => {
    const body = makeByteStream(['a,b,c\n1\n'])
    const s = new CsvStream(body)
    await s.ensureRowCount(1)
    expect(s.rows).toEqual([{ a: '1', b: '', c: '' }])
  })

  it('strips BOM from the first chunk only', async () => {
    const body = makeByteStream(['﻿a,b\n1,2\n'])
    const s = new CsvStream(body)
    await s.ensureRowCount(1)
    expect(s.header).toEqual(['a', 'b'])
    expect(s.rows).toEqual([{ a: '1', b: '2' }])
  })

  it('accepts a tab separator for TSV', async () => {
    const body = makeByteStream(['a\tb\n1\t2\n'])
    const s = new CsvStream(body, '\t')
    await s.ensureRowCount(1)
    expect(s.header).toEqual(['a', 'b'])
    expect(s.rows).toEqual([{ a: '1', b: '2' }])
  })
})

describe('csvSeparatorFor', () => {
  it('picks tab for .tsv', () => {
    expect(csvSeparatorFor('data.tsv')).toBe('\t')
    expect(csvSeparatorFor('NESTED/dir/file.TSV')).toBe('\t')
  })

  it('defaults to comma for .csv and anything else', () => {
    expect(csvSeparatorFor('data.csv')).toBe(',')
    expect(csvSeparatorFor('weird.txt')).toBe(',')
    expect(csvSeparatorFor('no-extension')).toBe(',')
  })
})
