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
      rendered: '00001.png',
    })
  })

  it('prefix template prepends to value', () => {
    const r = resolveSrc('../images/{value}', '00001.png', FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/images/00001.png',
      key: 'datasets/images/00001.png',
      rendered: '../images/00001.png',
    })
  })

  it('template without {value} is used verbatim (static)', () => {
    const r = resolveSrc('/static/logo.png', 'ignored', FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/static/logo.png',
      key: 'static/logo.png',
      rendered: '/static/logo.png',
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
      rendered: 'https://cdn.example.com/abc123.png',
    })
  })

  it('cell value that is itself an http URL after substitution stays external', () => {
    const r = resolveSrc(
      '{value}',
      'https://example.com/img.png',
      FILE,
      undefined,
    )
    expect(r).toEqual({
      ok: true,
      url: 'https://example.com/img.png',
      rendered: 'https://example.com/img.png',
    })
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
      rendered: '/static/logo.png',
    })
  })

  it('object cell value with .path field is supported', () => {
    const r = resolveSrc('{value}', { path: 'a.png' }, FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/imagenet/a.png',
      key: 'datasets/imagenet/a.png',
      rendered: 'a.png',
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
      rendered: '/foo/bar.png',
    })
  })

  it('relative path includes the storage query param', () => {
    const r = resolveSrc('{value}', 'a.png', FILE, 'mybucket')
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/imagenet/a.png?storage=mybucket',
      key: 'datasets/imagenet/a.png',
      rendered: 'a.png',
    })
  })

  it('all template occurrences of {value} are substituted', () => {
    // Slightly odd but useful pattern: template references value twice.
    const r = resolveSrc('{value}/thumb-{value}', 'abc', FILE, undefined)
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/imagenet/abc/thumb-abc',
      key: 'datasets/imagenet/abc/thumb-abc',
      rendered: 'abc/thumb-abc',
    })
  })

  it('empty template → error', () => {
    expect(resolveSrc('', 'a.png', FILE, undefined)).toEqual({
      ok: false,
      reason: 'empty src',
    })
  })
})

// ---------------------------------------------------------------------------
// StorageDescriptor fixtures for s3:// tests
// ---------------------------------------------------------------------------

import type { StorageDescriptor } from '@/types/storage'

/** Multi-bucket S3 storage: any bucket in the URI belongs to this storage. */
const MULTI_BUCKET_S3: StorageDescriptor = {
  name: 'main',
  type: 's3',
  valid: true,
  s3: { bucket: null },
}

/** Single-bucket S3 storage: only URIs whose bucket equals 'mybucket' resolve. */
const SINGLE_BUCKET_S3: StorageDescriptor = {
  name: 'mybucket-storage',
  type: 's3',
  valid: true,
  s3: { bucket: 'mybucket' },
}

/** Local FS storage: rejects s3:// URIs with a clear reason. */
const LOCAL_STORAGE: StorageDescriptor = {
  name: 'local',
  type: 'local',
  valid: true,
  local: { root_path: '/data' },
}

describe('resolveSrc — s3:// URI handling', () => {
  // -- multi-bucket storage ---------------------------------------------------

  it('s3://bucket/key — multi-bucket: maps bucket as first key segment', () => {
    const r = resolveSrc(
      's3://infographics/vigeneval/data/img.png',
      'ignored',
      FILE,
      'main',
      MULTI_BUCKET_S3,
    )
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/infographics/vigeneval/data/img.png?storage=main',
      key: 'infographics/vigeneval/data/img.png',
      rendered: 's3://infographics/vigeneval/data/img.png',
    })
  })

  it('s3a:// variant resolves identically to s3://', () => {
    const r = resolveSrc(
      's3a://infographics/data/img.png',
      'ignored',
      FILE,
      'main',
      MULTI_BUCKET_S3,
    )
    expect(r).toMatchObject({ ok: true, key: 'infographics/data/img.png' })
  })

  it('{value} substitution + s3:// prefix template', () => {
    const r = resolveSrc(
      's3://infographics/vigeneval/data/{value}',
      'x.png',
      FILE,
      'main',
      MULTI_BUCKET_S3,
    )
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/infographics/vigeneval/data/x.png?storage=main',
      key: 'infographics/vigeneval/data/x.png',
      rendered: 's3://infographics/vigeneval/data/x.png',
    })
  })

  it('cell value is itself an s3:// URI (default {value} template)', () => {
    const r = resolveSrc(
      '{value}',
      's3://infographics/data/y.png',
      FILE,
      'main',
      MULTI_BUCKET_S3,
    )
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/infographics/data/y.png?storage=main',
      key: 'infographics/data/y.png',
      rendered: 's3://infographics/data/y.png',
    })
  })

  // -- single-bucket storage --------------------------------------------------

  it('s3://mybucket/key — single-bucket, bucket matches: returns bare key', () => {
    const r = resolveSrc(
      's3://mybucket/data/img.png',
      'ignored',
      FILE,
      'mybucket-storage',
      SINGLE_BUCKET_S3,
    )
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/data/img.png?storage=mybucket-storage',
      key: 'data/img.png',
      rendered: 's3://mybucket/data/img.png',
    })
  })

  it('bucket mismatch on single-bucket storage → ok:false with clear reason', () => {
    const r = resolveSrc(
      's3://other-bucket/data/img.png',
      'ignored',
      FILE,
      'mybucket-storage',
      SINGLE_BUCKET_S3,
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { ok: false; reason: string }).reason).toMatch(/bucket/)
  })

  // -- non-S3 storage ---------------------------------------------------------

  it('s3:// on a local storage → ok:false (not S3)', () => {
    const r = resolveSrc(
      's3://bucket/img.png',
      'ignored',
      FILE,
      'local',
      LOCAL_STORAGE,
    )
    expect(r).toMatchObject({ ok: false })
  })

  // -- unsupported scheme -----------------------------------------------------

  it('gs:// scheme → ok:false (unsupported)', () => {
    const r = resolveSrc(
      'gs://bucket/img.png',
      'ignored',
      FILE,
      'main',
      MULTI_BUCKET_S3,
    )
    expect(r).toMatchObject({ ok: false })
    expect((r as { ok: false; reason: string }).reason).toMatch(/scheme/)
  })

  // -- missing descriptor -----------------------------------------------------

  it('s3:// without storageDescriptor → ok:false (descriptor not loaded)', () => {
    const r = resolveSrc('s3://bucket/img.png', 'ignored', FILE, 'main')
    expect(r).toMatchObject({ ok: false })
    expect((r as { ok: false; reason: string }).reason).toMatch(/storage info/)
  })

  // -- regression: existing branches unaffected by new s3:// branch ----------

  it('regression: /absolute path still works without descriptor', () => {
    const r = resolveSrc('/foo/bar.png', 'ignored', FILE, 'mybucket-storage')
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/foo/bar.png?storage=mybucket-storage',
      key: 'foo/bar.png',
      rendered: '/foo/bar.png',
    })
  })

  it('regression: relative path still works without descriptor', () => {
    const r = resolveSrc('{value}', 'a.png', FILE, 'mybucket-storage')
    expect(r).toEqual({
      ok: true,
      url: '/api/proxy/datasets/imagenet/a.png?storage=mybucket-storage',
      key: 'datasets/imagenet/a.png',
      rendered: 'a.png',
    })
  })
})
