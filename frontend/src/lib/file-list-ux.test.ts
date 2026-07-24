import { describe, expect, it } from 'vitest'

import {
  canShowInlinePreview,
  getBrowseScrollTarget,
  getFileListEmptyState,
  saveScrollPosition,
  shouldKeepPreviousListPage,
} from '@/lib/file-list-ux'

describe('getBrowseScrollTarget', () => {
  it('starts new pages at the top and restores history entries', () => {
    expect(
      getBrowseScrollTarget({
        pageChanged: true,
        splitViewChanged: false,
        historyNavigation: false,
        savedScrollTop: 240,
        previousScrollTop: 120,
      }),
    ).toBe(0)
    expect(
      getBrowseScrollTarget({
        pageChanged: true,
        splitViewChanged: false,
        historyNavigation: true,
        savedScrollTop: 240,
        previousScrollTop: 120,
      }),
    ).toBe(240)
  })

  it('carries scroll into a new split container and restores one from history', () => {
    expect(
      getBrowseScrollTarget({
        pageChanged: false,
        splitViewChanged: true,
        historyNavigation: false,
        savedScrollTop: 240,
        previousScrollTop: 120,
      }),
    ).toBe(120)
    expect(
      getBrowseScrollTarget({
        pageChanged: false,
        splitViewChanged: true,
        historyNavigation: true,
        savedScrollTop: 240,
        previousScrollTop: 120,
      }),
    ).toBe(240)
  })

  it('leaves a stable page and scroll container untouched', () => {
    expect(
      getBrowseScrollTarget({
        pageChanged: false,
        splitViewChanged: false,
        historyNavigation: false,
        savedScrollTop: 240,
        previousScrollTop: 120,
      }),
    ).toBeNull()
  })
})

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

describe('canShowInlinePreview', () => {
  it('requires the list, preview, gutter, and resize handle to fit', () => {
    expect(canShowInlinePreview(null, 360)).toBe(false)
    expect(canShowInlinePreview(795, 360)).toBe(false)
    expect(canShowInlinePreview(796, 360)).toBe(true)
  })
})

describe('shouldKeepPreviousListPage', () => {
  it('keeps pagination data only within the same storage and directory', () => {
    expect(
      shouldKeepPreviousListPage(
        ['list', 'primary', 'photos/', 'next'],
        'primary',
        'photos/',
      ),
    ).toBe(true)
    expect(
      shouldKeepPreviousListPage(
        ['list', 'archive', 'photos/', null],
        'primary',
        'photos/',
      ),
    ).toBe(false)
    expect(
      shouldKeepPreviousListPage(
        ['list', 'primary', 'photos/2025/', null],
        'primary',
        'photos/',
      ),
    ).toBe(false)
  })
})
