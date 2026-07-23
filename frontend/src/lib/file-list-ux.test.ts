import { describe, expect, it } from 'vitest'

import {
  getFileListEmptyState,
  saveScrollPosition,
} from '@/lib/file-list-ux'

describe('saveScrollPosition', () => {
  it('keeps only the 50 most recent history entries', () => {
    const positions = new Map<string, number>()
    for (let index = 0; index <= 50; index += 1) {
      saveScrollPosition(positions, `route-${index}`, index)
    }

    expect(positions.size).toBe(50)
    expect(positions.has('route-0')).toBe(false)
    expect(positions.get('route-50')).toBe(50)
  })
})

describe('getFileListEmptyState', () => {
  it('distinguishes an empty directory from filters with no matches', () => {
    expect(getFileListEmptyState(0, 0)).toBe('empty-directory')
    expect(getFileListEmptyState(4, 0)).toBe('no-matches')
    expect(getFileListEmptyState(4, 2)).toBeNull()
  })
})
