import { describe, expect, it } from 'vitest'

import { evalSelector } from '@/lib/rows-selector-eval'
import { parseSelector } from '@/lib/rows-selector'

// Helper: parse a selector source string and evaluate against a row.
function ev(src: string, row: Record<string, unknown>): unknown[] {
  const { ast } = parseSelector(src)
  return evalSelector(ast, row)
}

describe('evalSelector — root', () => {
  it('returns the value at the column name', () => {
    expect(ev('prompt', { prompt: 'hello' })).toEqual(['hello'])
  })

  it('returns [undefined] for missing column', () => {
    expect(ev('missing', {})).toEqual([undefined])
  })

  it('returns [null] for explicit null', () => {
    expect(ev('x', { x: null })).toEqual([null])
  })

  it('returns the raw object/list value when no further step', () => {
    expect(ev('meta', { meta: { a: 1 } })).toEqual([{ a: 1 }])
    expect(ev('arr', { arr: [1, 2, 3] })).toEqual([[1, 2, 3]])
  })

  it('quoted root column name', () => {
    expect(ev('`weird.col`', { 'weird.col': 42 })).toEqual([42])
  })
})

describe('evalSelector — field', () => {
  it('extracts an object key', () => {
    expect(ev('image.path', { image: { path: 'a.png' } })).toEqual(['a.png'])
  })

  it('returns undefined for missing key', () => {
    expect(ev('image.missing', { image: { path: 'a.png' } })).toEqual([
      undefined,
    ])
  })

  it('returns undefined when applied to a non-object', () => {
    expect(ev('s.x', { s: 'string' })).toEqual([undefined])
    expect(ev('n.x', { n: 42 })).toEqual([undefined])
    expect(ev('arr.x', { arr: [1, 2] })).toEqual([undefined])
  })

  it('rejects Date instance as a field-access target', () => {
    expect(ev('d.toISOString', { d: new Date() })).toEqual([undefined])
  })

  it('rejects Uint8Array as a field-access target', () => {
    expect(ev('b.byteLength', { b: new Uint8Array(4) })).toEqual([undefined])
  })

  it('chained field access', () => {
    expect(ev('m.a.b', { m: { a: { b: 'leaf' } } })).toEqual(['leaf'])
  })

  it('returns undefined when an intermediate field is missing', () => {
    expect(ev('m.a.b', { m: {} })).toEqual([undefined])
  })

  it('bracket-quoted field with special chars', () => {
    expect(ev('m.[`a.b`]', { m: { 'a.b': 'dotted' } })).toEqual(['dotted'])
  })
})

describe('evalSelector — index', () => {
  it('positive index on array', () => {
    expect(ev('xs.[1]', { xs: ['a', 'b', 'c'] })).toEqual(['b'])
  })

  it('negative index on array (last element)', () => {
    expect(ev('xs.[-1]', { xs: ['a', 'b', 'c'] })).toEqual(['c'])
  })

  it('out-of-range index → undefined', () => {
    expect(ev('xs.[10]', { xs: ['a', 'b'] })).toEqual([undefined])
    expect(ev('xs.[-10]', { xs: ['a', 'b'] })).toEqual([undefined])
  })

  it('index on string', () => {
    expect(ev('s.[0]', { s: 'hello' })).toEqual(['h'])
    expect(ev('s.[-1]', { s: 'hello' })).toEqual(['o'])
  })

  it('index on non-list/non-string → undefined', () => {
    expect(ev('m.[0]', { m: { a: 1 } })).toEqual([undefined])
    expect(ev('n.[0]', { n: 42 })).toEqual([undefined])
    expect(ev('miss.[0]', {})).toEqual([undefined])
  })
})

describe('evalSelector — slice', () => {
  it('two-bound slice on array', () => {
    expect(ev('xs.[1:3]', { xs: [10, 20, 30, 40] })).toEqual([[20, 30]])
  })

  it('left-only slice on array', () => {
    expect(ev('xs.[2:]', { xs: [10, 20, 30, 40] })).toEqual([[30, 40]])
  })

  it('right-only slice on array', () => {
    expect(ev('xs.[:2]', { xs: [10, 20, 30, 40] })).toEqual([[10, 20]])
  })

  it('negative slice bounds on array', () => {
    expect(ev('xs.[-2:]', { xs: [10, 20, 30, 40] })).toEqual([[30, 40]])
    expect(ev('xs.[-3:-1]', { xs: [10, 20, 30, 40] })).toEqual([[20, 30]])
  })

  it('slice on string', () => {
    expect(ev('s.[0:5]', { s: 'hello world' })).toEqual(['hello'])
    expect(ev('s.[-5:]', { s: 'hello world' })).toEqual(['world'])
  })

  it('slice on non-list/non-string → undefined', () => {
    expect(ev('m.[0:3]', { m: { a: 1 } })).toEqual([undefined])
    expect(ev('miss.[0:3]', {})).toEqual([undefined])
  })
})

describe('evalSelector — fanout (.[*])', () => {
  it('fans out a list column', () => {
    expect(ev('xs.[*]', { xs: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c'])
  })

  it('empty list → empty result', () => {
    expect(ev('xs.[*]', { xs: [] })).toEqual([])
  })

  it('missing column → empty result (renders empty placeholder)', () => {
    expect(ev('miss.[*]', {})).toEqual([])
  })

  it('null column → empty result', () => {
    expect(ev('xs.[*]', { xs: null })).toEqual([])
  })

  it('string column → empty result (no implicit char splitting)', () => {
    expect(ev('s.[*]', { s: 'hello' })).toEqual([])
  })

  it('object column → empty result', () => {
    expect(ev('m.[*]', { m: { a: 1 } })).toEqual([])
  })

  it('fanout then field — picks .path from each element', () => {
    const row = { xs: [{ path: 'a.png' }, { path: 'b.png' }] }
    expect(ev('xs.[*].path', row)).toEqual(['a.png', 'b.png'])
  })

  it('fanout then bracket-field with special char', () => {
    const row = { xs: [{ 'a.b': 1 }, { 'a.b': 2 }] }
    expect(ev('xs.[*].[`a.b`]', row)).toEqual([1, 2])
  })

  it('slice then fanout — first N then iterate', () => {
    expect(ev('xs.[0:2].[*]', { xs: ['a', 'b', 'c', 'd'] })).toEqual(['a', 'b'])
  })

  it('nested object then fanout', () => {
    const row = { meta: { tags: ['x', 'y', 'z'] } }
    expect(ev('meta.tags.[*]', row)).toEqual(['x', 'y', 'z'])
  })

  it('fanout then mixed missing fields surfaces undefined per element', () => {
    const row = { xs: [{ path: 'a.png' }, {}, { path: 'c.png' }] }
    expect(ev('xs.[*].path', row)).toEqual(['a.png', undefined, 'c.png'])
  })
})

describe('evalSelector — primitive value passthrough', () => {
  it('boolean, number, bigint pass through unchanged at root', () => {
    expect(ev('x', { x: true })).toEqual([true])
    expect(ev('x', { x: 0 })).toEqual([0])
    expect(ev('x', { x: 42n })).toEqual([42n])
  })

  it('Date passes through at root', () => {
    const d = new Date('2026-01-01')
    expect(ev('x', { x: d })).toEqual([d])
  })

  it('Uint8Array passes through at root', () => {
    const b = new Uint8Array([1, 2, 3])
    expect(ev('x', { x: b })).toEqual([b])
  })
})
