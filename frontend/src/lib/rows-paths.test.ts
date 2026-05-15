import { describe, expect, it } from 'vitest'

import {
  cellValueToPath,
  resolveSrc,
  resolveStorageKey,
} from '@/lib/rows-paths'

const FILE = 'datasets/imagenet/train.parquet'

describe('cellValueToPath', () => {
  it('returns plain strings as-is', () => {
    expect(cellValueToPath('00001.png')).toBe('00001.png')
  })

  it('rejects empty string', () => {
    expect(cellValueToPath('')).toBeNull()
  })

  it('rejects null / undefined', () => {
    expect(cellValueToPath(null)).toBeNull()
    expect(cellValueToPath(undefined)).toBeNull()
  })

  it('rejects numbers / booleans / bigint', () => {
    expect(cellValueToPath(42)).toBeNull()
    expect(cellValueToPath(true)).toBeNull()
    expect(cellValueToPath(42n)).toBeNull()
  })

  it('extracts .path / .uri / .url / .src from struct values', () => {
    expect(cellValueToPath({ path: 'a.png' })).toBe('a.png')
    expect(cellValueToPath({ uri: 'a.png' })).toBe('a.png')
    expect(cellValueToPath({ url: 'a.png' })).toBe('a.png')
    expect(cellValueToPath({ src: 'a.png' })).toBe('a.png')
  })

  it('prefers .path over other keys when multiple are present', () => {
    expect(cellValueToPath({ path: 'p', url: 'u' })).toBe('p')
  })

  it('rejects arrays / Date / Uint8Array', () => {
    expect(cellValueToPath(['a'])).toBeNull()
    expect(cellValueToPath(new Date())).toBeNull()
    expect(cellValueToPath(new Uint8Array(4))).toBeNull()
  })

  it('rejects struct with no recognised keys', () => {
    expect(cellValueToPath({ foo: 'a.png' })).toBeNull()
  })
})

describe('resolveStorageKey', () => {
  it('resolves a sibling file', () => {
    expect(resolveStorageKey(FILE, '00001.png')).toEqual({
      ok: true,
      key: 'datasets/imagenet/00001.png',
    })
  })

  it('resolves a subdirectory', () => {
    expect(resolveStorageKey(FILE, 'images/00001.png')).toEqual({
      ok: true,
      key: 'datasets/imagenet/images/00001.png',
    })
  })

  it('walks up one level via ..', () => {
    expect(resolveStorageKey(FILE, '../shared/logo.png')).toEqual({
      ok: true,
      key: 'datasets/shared/logo.png',
    })
  })

  it('walks up multiple levels', () => {
    expect(resolveStorageKey(FILE, '../../top.png')).toEqual({
      ok: true,
      key: 'top.png',
    })
  })

  it('rejects escape past storage root', () => {
    expect(resolveStorageKey(FILE, '../../../foo.png')).toEqual({
      ok: false,
      reason: 'path escapes storage root',
    })
  })

  it('drops "." segments', () => {
    expect(resolveStorageKey(FILE, './foo.png')).toEqual({
      ok: true,
      key: 'datasets/imagenet/foo.png',
    })
    expect(resolveStorageKey(FILE, 'a/./b.png')).toEqual({
      ok: true,
      key: 'datasets/imagenet/a/b.png',
    })
  })

  it('rejects empty result when path lands at storage root', () => {
    expect(resolveStorageKey(FILE, '../..')).toEqual({
      ok: false,
      reason: 'path resolves to storage root with no file',
    })
  })

  it('rejects empty input', () => {
    expect(resolveStorageKey(FILE, '')).toEqual({ ok: false, reason: 'empty path' })
  })

  it('handles a top-level parquet file (no parent dirs)', () => {
    expect(resolveStorageKey('train.parquet', 'a.png')).toEqual({
      ok: true,
      key: 'a.png',
    })
  })
})

describe('resolveSrc — template handling', () => {
  it('default "{value}" template uses cell value as path', () => {
    const r = resolveSrc('{value}', '00001.png', FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/imagenet/00001.png',
      key: 'datasets/imagenet/00001.png',
    })
  })

  it('prefix template prepends to value', () => {
    const r = resolveSrc('../images/{value}', '00001.png', FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/images/00001.png',
      key: 'datasets/images/00001.png',
    })
  })

  it('template without {value} is used verbatim (static)', () => {
    const r = resolveSrc('/static/logo.png', 'ignored', FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/static/logo.png',
      key: 'static/logo.png',
    })
  })

  it('CDN-style template after substitution stays external (no storage key)', () => {
    const r = resolveSrc(
      'https://cdn.example.com/{value}.png',
      'abc123',
      FILE,
      undefined,
    )
    expect(r).toEqual({
      ok: true,
      url: 'https://cdn.example.com/abc123.png',
    })
  })

  it('cell value that is itself an http URL after substitution stays external', () => {
    const r = resolveSrc(
      '{value}',
      'https://example.com/img.png',
      FILE,
      undefined,
    )
    expect(r).toEqual({ ok: true, url: 'https://example.com/img.png' })
  })

  it('missing cell value with {value} template → error', () => {
    const r = resolveSrc('{value}', null, FILE, undefined)
    expect(r).toEqual({ ok: false, reason: 'no usable path in value' })
  })

  it('missing cell value without {value} template → OK', () => {
    const r = resolveSrc('/static/logo.png', null, FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/static/logo.png',
      key: 'static/logo.png',
    })
  })

  it('object cell value with .path field is supported', () => {
    const r = resolveSrc('{value}', { path: 'a.png' }, FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/imagenet/a.png',
      key: 'datasets/imagenet/a.png',
    })
  })

  it('escape past root → error surfaces from resolveStorageKey', () => {
    const r = resolveSrc('../../../etc.png', 'ignored', FILE, undefined)
    expect(r).toEqual({ ok: false, reason: 'path escapes storage root' })
  })

  it('absolute / path includes the storage query param', () => {
    const r = resolveSrc('/foo/bar.png', 'ignored', FILE, 'mybucket')
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/foo/bar.png?storage=mybucket',
      key: 'foo/bar.png',
    })
  })

  it('relative path includes the storage query param', () => {
    const r = resolveSrc('{value}', 'a.png', FILE, 'mybucket')
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/imagenet/a.png?storage=mybucket',
      key: 'datasets/imagenet/a.png',
    })
  })

  it('all template occurrences of {value} are substituted', () => {
    // Slightly odd but useful pattern: template references value twice.
    const r = resolveSrc('{value}/thumb-{value}', 'abc', FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/imagenet/abc/thumb-abc',
      key: 'datasets/imagenet/abc/thumb-abc',
    })
  })

  it('empty template → error', () => {
    expect(resolveSrc('', 'a.png', FILE, undefined)).toEqual({
      ok: false,
      reason: 'empty src',
    })
  })
})
