import { describe, expect, it } from 'vitest'

import { basenameOf, extensionOf } from '@/lib/path'

describe('basenameOf', () => {
  it('returns the final segment of a file key', () => {
    expect(basenameOf('foo/bar/baz.txt')).toBe('baz.txt')
  })

  it('returns the input when there is no slash', () => {
    expect(basenameOf('baz.txt')).toBe('baz.txt')
  })

  it('strips trailing slashes so directory keys yield the directory name', () => {
    expect(basenameOf('foo/bar/')).toBe('bar')
    expect(basenameOf('foo/bar///')).toBe('bar')
  })

  it('returns empty string for the empty key and root', () => {
    expect(basenameOf('')).toBe('')
    expect(basenameOf('/')).toBe('')
  })
})

describe('extensionOf', () => {
  it('returns the lowercase extension without the dot', () => {
    expect(extensionOf('photo.JPG')).toBe('jpg')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('foo/bar/image.png')).toBe('png')
  })

  it('returns null for extension-less keys', () => {
    expect(extensionOf('Makefile')).toBeNull()
    expect(extensionOf('foo/Makefile')).toBeNull()
    expect(extensionOf('')).toBeNull()
  })

  it('returns null when the dot is the last character', () => {
    expect(extensionOf('archive.tar.')).toBeNull()
  })

  it('strips trailing slashes before extracting the extension', () => {
    // Directory keys like `foo/bar.d/` should not yield "d"
    expect(extensionOf('foo/bar.d/')).toBe('d')
    // A trailing slash after a dot-only segment
    expect(extensionOf('foo/')).toBeNull()
  })
})
