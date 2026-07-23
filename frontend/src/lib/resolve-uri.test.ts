import { describe, expect, it } from 'vitest'

import { cleanPathInput, resolveStorageUri } from '@/lib/resolve-uri'
import type { StorageDescriptor } from '@/types/storage'

const singleBucket = (bucket: string): StorageDescriptor => ({
  name: 's3',
  type: 's3',
  valid: true,
  writeable: false,
  s3: { bucket },
})

const multiBucket: StorageDescriptor = {
  name: 's3',
  type: 's3',
  valid: true,
  writeable: false,
  s3: { bucket: null },
}

const local: StorageDescriptor = {
  name: 'fs',
  type: 'local',
  valid: true,
  writeable: false,
  local: { root_path: '/data' },
}

// The path from the user's report.
const REPORTED =
  's3://infographics/vigeneval/training_files/captions-rewritten_260129_9949rows_processed_train.json'
const REPORTED_KEY =
  'vigeneval/training_files/captions-rewritten_260129_9949rows_processed_train.json'

describe('cleanPathInput', () => {
  it('removes pasted line breaks and surrounding whitespace', () => {
    expect(cleanPathInput('  s3://bucket/\r\npath/file.txt \n')).toBe(
      's3://bucket/path/file.txt',
    )
  })
})

describe('resolveStorageUri — relative input (no scheme)', () => {
  it('returns a relative path unchanged', () => {
    expect(resolveStorageUri('foo/bar/baz.json', singleBucket('x'))).toEqual({
      ok: true,
      path: 'foo/bar/baz.json',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(resolveStorageUri('  foo/bar/  ', multiBucket)).toEqual({
      ok: true,
      path: 'foo/bar/',
    })
  })

  it('passes the empty string through (jump to root)', () => {
    expect(resolveStorageUri('', singleBucket('x'))).toEqual({
      ok: true,
      path: '',
    })
  })
})

describe('resolveStorageUri — single-bucket S3', () => {
  it('strips the matching bucket and returns the key (reported case)', () => {
    expect(resolveStorageUri(REPORTED, singleBucket('infographics'))).toEqual({
      ok: true,
      path: REPORTED_KEY,
    })
  })

  it('rejects a URI whose bucket differs from the pinned bucket', () => {
    const r = resolveStorageUri(REPORTED, singleBucket('other-bucket'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('infographics')
      expect(r.reason).toContain('other-bucket')
    }
  })

  it('maps a bare bucket URI to an empty key', () => {
    expect(resolveStorageUri('s3://infographics', singleBucket('infographics'))).toEqual(
      { ok: true, path: '' },
    )
  })

  it('matches the bucket case-insensitively', () => {
    expect(
      resolveStorageUri('s3://Infographics/vigeneval/x', singleBucket('infographics')),
    ).toEqual({ ok: true, path: 'vigeneval/x' })
  })
})

describe('resolveStorageUri — multi-bucket S3', () => {
  it('keeps the bucket as the first path segment', () => {
    expect(resolveStorageUri(REPORTED, multiBucket)).toEqual({
      ok: true,
      path: `infographics/${REPORTED_KEY}`,
    })
  })

  it('maps a bare bucket URI to "<bucket>/"', () => {
    expect(resolveStorageUri('s3://infographics', multiBucket)).toEqual({
      ok: true,
      path: 'infographics/',
    })
  })

  it('accepts any bucket (root lists all buckets)', () => {
    expect(resolveStorageUri('s3://whatever/foo', multiBucket)).toEqual({
      ok: true,
      path: 'whatever/foo',
    })
  })
})

describe('resolveStorageUri — scheme variants & casing', () => {
  it('accepts s3a:// and s3n:// (Hadoop variants)', () => {
    expect(resolveStorageUri('s3a://infographics/x', singleBucket('infographics'))).toEqual(
      { ok: true, path: 'x' },
    )
    expect(resolveStorageUri('s3n://infographics/x', singleBucket('infographics'))).toEqual(
      { ok: true, path: 'x' },
    )
  })

  it('is case-insensitive on the scheme', () => {
    expect(resolveStorageUri('S3://infographics/x', singleBucket('infographics'))).toEqual(
      { ok: true, path: 'x' },
    )
  })
})

describe('resolveStorageUri — rejections', () => {
  it('rejects unsupported schemes', () => {
    const r = resolveStorageUri('gs://bucket/obj', multiBucket)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('gs://')
  })

  it('rejects https URLs', () => {
    expect(resolveStorageUri('https://example.com/a/b', multiBucket).ok).toBe(false)
  })

  it('rejects an s3:// path when the current storage is local', () => {
    const r = resolveStorageUri(REPORTED, local)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('not S3')
  })

  it('rejects an s3:// URI with no bucket', () => {
    const r = resolveStorageUri('s3:///just/a/key', multiBucket)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('bucket')
  })

  it('rejects when storage is undefined and a scheme is present', () => {
    expect(resolveStorageUri(REPORTED, undefined).ok).toBe(false)
  })
})

describe('resolveStorageUri — local absolute paths', () => {
  it('strips the root prefix (reported case)', () => {
    expect(resolveStorageUri('/data/foo/bar/', local)).toEqual({
      ok: true,
      path: 'foo/bar/',
    })
  })

  it('maps bare root (no trailing slash) to empty key', () => {
    expect(resolveStorageUri('/data', local)).toEqual({ ok: true, path: '' })
  })

  it('maps bare root (trailing slash) to empty key', () => {
    expect(resolveStorageUri('/data/', local)).toEqual({ ok: true, path: '' })
  })

  it('handles root_path with trailing slash in descriptor', () => {
    const localTrailing: StorageDescriptor = {
      name: 'fs',
      type: 'local',
      valid: true,
      writeable: false,
      local: { root_path: '/data/' },
    }
    expect(resolveStorageUri('/data/foo', localTrailing)).toEqual({
      ok: true,
      path: 'foo',
    })
  })

  it('rejects paths outside root', () => {
    const r = resolveStorageUri('/etc/passwd', local)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('/data')
  })

  it('does not match a similarly-prefixed sibling directory', () => {
    // /database/x must not match root /data
    const r = resolveStorageUri('/database/x', local)
    expect(r.ok).toBe(false)
  })

  it('passes relative paths through unchanged', () => {
    expect(resolveStorageUri('foo/bar/', local)).toEqual({
      ok: true,
      path: 'foo/bar/',
    })
  })
})
