import { describe, expect, it } from 'vitest'

import { normalizeFavoriteKey } from '@/hooks/use-favorites'

describe('normalizeFavoriteKey', () => {
  it('canonicalizes folder keys without changing files or the storage root', () => {
    expect(normalizeFavoriteKey('photos', 'folder')).toBe('photos/')
    expect(normalizeFavoriteKey('photos/', 'folder')).toBe('photos/')
    expect(normalizeFavoriteKey('', 'folder')).toBe('')
    expect(normalizeFavoriteKey('photos', 'file')).toBe('photos')
  })
})
