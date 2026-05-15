import { describe, expect, it } from 'vitest'

import { parseSelector, SelectorError, type Selector } from '@/lib/rows-selector'

function ast(s: string): Selector {
  return parseSelector(s).ast
}
function fanout(s: string): boolean {
  return parseSelector(s).hasFanout
}
function err(s: string): { msg: string; offset: number } {
  try {
    parseSelector(s)
  } catch (e) {
    if (e instanceof SelectorError) return { msg: e.message, offset: e.offset }
    throw e
  }
  throw new Error(`expected parse error for ${JSON.stringify(s)}`)
}

describe('parseSelector — spec §1.3 examples', () => {
  it('root column', () => {
    expect(ast('prompt')).toEqual({ op: 'root', column: 'prompt' })
    expect(fanout('prompt')).toBe(false)
  })

  it('field via bracket form', () => {
    expect(ast('image.[path]')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'image' },
      key: 'path',
    })
  })

  it('field shortcut without brackets', () => {
    expect(ast('image.path')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'image' },
      key: 'path',
    })
  })

  it('index', () => {
    expect(ast('images.[0]')).toEqual({
      op: 'index',
      from: { op: 'root', column: 'images' },
      index: 0,
    })
  })

  it('negative index', () => {
    expect(ast('images.[-1]')).toEqual({
      op: 'index',
      from: { op: 'root', column: 'images' },
      index: -1,
    })
  })

  it('fan-out', () => {
    expect(ast('images.[*]')).toEqual({
      op: 'fanout',
      from: { op: 'root', column: 'images' },
    })
    expect(fanout('images.[*]')).toBe(true)
  })

  it('slice with two bounds', () => {
    expect(ast('images.[0:3]')).toEqual({
      op: 'slice',
      from: { op: 'root', column: 'images' },
      start: 0,
      end: 3,
    })
  })

  it('slice with only end', () => {
    expect(ast('prompt.[:200]')).toEqual({
      op: 'slice',
      from: { op: 'root', column: 'prompt' },
      start: null,
      end: 200,
    })
  })

  it('slice with only start', () => {
    expect(ast('images.[5:]')).toEqual({
      op: 'slice',
      from: { op: 'root', column: 'images' },
      start: 5,
      end: null,
    })
  })

  it('slice with negative bounds', () => {
    expect(ast('images.[-3:]')).toEqual({
      op: 'slice',
      from: { op: 'root', column: 'images' },
      start: -3,
      end: null,
    })
    expect(ast('items.[-5:-1]')).toEqual({
      op: 'slice',
      from: { op: 'root', column: 'items' },
      start: -5,
      end: -1,
    })
  })

  it('chained fan-out then field', () => {
    expect(ast('images.[*].[path]')).toEqual({
      op: 'field',
      from: { op: 'fanout', from: { op: 'root', column: 'images' } },
      key: 'path',
    })
  })

  it('chained slice then fan-out', () => {
    expect(ast('images.[0:3].[*]')).toEqual({
      op: 'fanout',
      from: {
        op: 'slice',
        from: { op: 'root', column: 'images' },
        start: 0,
        end: 3,
      },
    })
    expect(fanout('images.[0:3].[*]')).toBe(true)
  })

  it('nested object then list', () => {
    expect(ast('metadata.tags.[*]')).toEqual({
      op: 'fanout',
      from: {
        op: 'field',
        from: { op: 'root', column: 'metadata' },
        key: 'tags',
      },
    })
  })
})

describe('parseSelector — quoted field names', () => {
  it('quoted key with dot inside', () => {
    expect(ast('meta.["x.y"]')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'meta' },
      key: 'x.y',
    })
  })

  it('backtick key with dot inside (no JSON escape needed)', () => {
    expect(ast('meta.[`x.y`]')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'meta' },
      key: 'x.y',
    })
  })

  it('escape sequences in double-quoted', () => {
    expect(ast('meta.["a\\"b"]')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'meta' },
      key: 'a"b',
    })
    expect(ast('meta.["a\\nb"]')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'meta' },
      key: 'a\nb',
    })
  })

  it('backtick is raw — backslashes are literal, no escapes', () => {
    expect(ast('meta.[`a\\nb`]')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'meta' },
      key: 'a\\nb',
    })
  })

  it('unterminated string is an error with offset at the opening quote', () => {
    const e = err('meta.["abc')
    expect(e.msg).toMatch(/unterminated string/)
    expect(e.offset).toBe(6)
  })

  it('unterminated backtick string', () => {
    const e = err('meta.[`abc')
    expect(e.msg).toMatch(/unterminated string/)
    expect(e.offset).toBe(6)
  })
})

describe('parseSelector — quoted column names at root', () => {
  it('double-quoted root column with dot', () => {
    expect(ast('"weird.col"')).toEqual({ op: 'root', column: 'weird.col' })
  })

  it('backtick root column with dot', () => {
    expect(ast('`weird.col`')).toEqual({ op: 'root', column: 'weird.col' })
  })

  it('root column with space', () => {
    expect(ast('`col with space`')).toEqual({
      op: 'root',
      column: 'col with space',
    })
  })

  it('quoted root chained with field shortcut', () => {
    expect(ast('`weird.col`.sub')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'weird.col' },
      key: 'sub',
    })
  })

  it('quoted root chained with bracket step', () => {
    expect(ast('`col with space`.[0]')).toEqual({
      op: 'index',
      from: { op: 'root', column: 'col with space' },
      index: 0,
    })
  })

  it('quoted root + bracket-quoted field', () => {
    expect(ast('`a.b`.[`c.d`]')).toEqual({
      op: 'field',
      from: { op: 'root', column: 'a.b' },
      key: 'c.d',
    })
  })

  it('quoted root with fan-out', () => {
    expect(ast('"image list".[*]')).toEqual({
      op: 'fanout',
      from: { op: 'root', column: 'image list' },
    })
  })

  it('empty quoted root is rejected', () => {
    expect(err('""').msg).toMatch(/empty column name/)
    expect(err('``').msg).toMatch(/empty column name/)
  })

  it('escape sequences in double-quoted root', () => {
    expect(ast('"a\\"b"')).toEqual({ op: 'root', column: 'a"b' })
  })

  it('column name containing backtick: use double-quote form', () => {
    expect(ast('"name`with`tick"')).toEqual({
      op: 'root',
      column: 'name`with`tick',
    })
  })
})

describe('parseSelector — error cases', () => {
  it('empty input', () => {
    expect(err('').msg).toMatch(/empty selector/)
  })

  it('starts with dot', () => {
    expect(err('.foo').msg).toMatch(/expected column name/)
  })

  it('trailing dot', () => {
    expect(err('foo.').msg).toMatch(/trailing dot/)
  })

  it('bare integer at root is rejected (root must be identifier)', () => {
    expect(err('123').msg).toMatch(/expected column name/)
  })

  it('unmatched [', () => {
    expect(err('images.[0').msg).toMatch(/expected '\]'/)
  })

  it('empty brackets', () => {
    expect(err('images.[]').msg).toMatch(/expected '\*', integer/)
  })

  it('rejects .[:] — both slice bounds missing', () => {
    const e = err('images.[:]')
    expect(e.msg).toMatch(/slice must have at least one bound/)
    // Offset should point at the opening bracket.
    expect(e.offset).toBe(7)
  })

  it('rejects double fan-out', () => {
    const e = err('images.[*].tags.[*]')
    expect(e.msg).toMatch(/at most one \[\*\]/)
    // Offset points at the second `[`.
    expect(e.offset).toBe(16)
  })

  it('rejects double fan-out even when adjacent', () => {
    expect(err('a.[*].[*]').msg).toMatch(/at most one \[\*\]/)
  })

  it('non-integer slice bound', () => {
    expect(err('images.[a:5]').msg).toMatch(/expected '\]'/)
  })

  it('rejects unknown bracket content', () => {
    expect(err('images.[$x]').msg).toMatch(/expected '\*', integer/)
  })

  it('error offsets are byte offsets, 0-indexed via .offset', () => {
    const e = err('images.[:]')
    expect(e.offset).toBe(7)
    expect(e.msg).toContain('col 8') // offset+1 in human form
  })
})

describe('parseSelector — whitespace', () => {
  it('whitespace inside brackets is ignored', () => {
    expect(ast('images.[ 0 ]')).toEqual({
      op: 'index',
      from: { op: 'root', column: 'images' },
      index: 0,
    })
    expect(ast('images.[ 0 : 3 ]')).toEqual({
      op: 'slice',
      from: { op: 'root', column: 'images' },
      start: 0,
      end: 3,
    })
    expect(ast('images.[ * ]')).toEqual({
      op: 'fanout',
      from: { op: 'root', column: 'images' },
    })
  })
})

describe('parseSelector — identifier root edge cases', () => {
  it('underscore identifiers ok', () => {
    expect(ast('_internal_field')).toEqual({ op: 'root', column: '_internal_field' })
  })

  it('numbers in column name (not at start)', () => {
    expect(ast('img2')).toEqual({ op: 'root', column: 'img2' })
  })

  it('reserved word "each" still parses as an identifier (no special syntax)', () => {
    // We dropped the `.each` op in favor of `.[*]`. So 'each' is just a name.
    expect(ast('each.[0]')).toEqual({
      op: 'index',
      from: { op: 'root', column: 'each' },
      index: 0,
    })
  })
})
