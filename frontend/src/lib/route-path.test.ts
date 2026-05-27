import { describe, expect, it } from 'vitest'

import { encodePathSegments } from '@/lib/route-path'

describe('encodePathSegments', () => {
  it('is a no-op for plain alphanumeric keys', () => {
    expect(encodePathSegments('foo/bar/baz.json')).toBe('foo/bar/baz.json')
  })

  it('preserves a trailing slash (directory prefix)', () => {
    expect(encodePathSegments('foo/bar/')).toBe('foo/bar/')
  })

  it('preserves the empty string (storage root)', () => {
    expect(encodePathSegments('')).toBe('')
  })

  it('encodes "#" so it does not start the URL hash', () => {
    expect(encodePathSegments('foo/a#b/c')).toBe('foo/a%23b/c')
  })

  it('encodes "?" so it does not start the query string', () => {
    expect(encodePathSegments('foo/a?b/')).toBe('foo/a%3Fb/')
  })

  it('encodes spaces', () => {
    expect(encodePathSegments('my docs/a b.txt')).toBe('my%20docs/a%20b.txt')
  })

  it('keeps slashes literal while encoding the segments around them', () => {
    expect(encodePathSegments('a/b c/d#e/')).toBe('a/b%20c/d%23e/')
  })

  it('round-trips back to the original via per-segment decode', () => {
    const original = 'dir with space/odd#name?.png'
    const decoded = encodePathSegments(original)
      .split('/')
      .map(decodeURIComponent)
      .join('/')
    expect(decoded).toBe(original)
  })
})
