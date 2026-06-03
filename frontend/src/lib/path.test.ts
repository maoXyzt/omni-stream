import { describe, expect, it } from 'vitest'

import { basenameOf } from '@/lib/path'

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
