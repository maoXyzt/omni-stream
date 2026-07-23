import { describe, expect, it } from 'vitest'

import {
  getDirectoryScrollTop,
  getFileListEmptyState,
} from '@/lib/file-list-ux'

describe('getDirectoryScrollTop', () => {
  it('restores history navigation and starts new navigation at the top', () => {
    expect(getDirectoryScrollTop(true, 320)).toBe(320)
    expect(getDirectoryScrollTop(true)).toBe(0)
    expect(getDirectoryScrollTop(false, 320)).toBe(0)
  })
})

describe('getFileListEmptyState', () => {
  it('distinguishes an empty directory from filters with no matches', () => {
    expect(getFileListEmptyState(0, 0)).toBe('empty-directory')
    expect(getFileListEmptyState(4, 0)).toBe('no-matches')
    expect(getFileListEmptyState(4, 2)).toBeNull()
  })
})
