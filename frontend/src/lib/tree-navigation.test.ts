import { describe, expect, it } from 'vitest'

import {
  getTreeAncestorPrefixes,
  getTreeKeyboardAction,
  reconcileTreeFocus,
  type VisibleTreeItem,
} from '@/lib/tree-navigation'

const items: VisibleTreeItem[] = [
  { depth: 0, expanded: true },
  { depth: 1, expanded: false },
  { depth: 1, expanded: null },
  { depth: 0, expanded: false },
]

describe('getTreeAncestorPrefixes', () => {
  it('keeps only the strict ancestors of the current folder', () => {
    expect(getTreeAncestorPrefixes('')).toEqual([])
    expect(getTreeAncestorPrefixes('photos/')).toEqual([])
    expect(getTreeAncestorPrefixes('photos/2026/events/')).toEqual([
      'photos/',
      'photos/2026/',
    ])
  })
})

describe('getTreeKeyboardAction', () => {
  it('moves through visible items and supports Home/End', () => {
    expect(getTreeKeyboardAction('ArrowDown', items, 0)).toEqual({
      type: 'focus',
      index: 1,
    })
    expect(getTreeKeyboardAction('ArrowUp', items, 2)).toEqual({
      type: 'focus',
      index: 1,
    })
    expect(getTreeKeyboardAction('Home', items, 3)).toEqual({
      type: 'focus',
      index: 0,
    })
    expect(getTreeKeyboardAction('End', items, 0)).toEqual({
      type: 'focus',
      index: 3,
    })
  })

  it('expands collapsed branches and enters expanded branches', () => {
    expect(getTreeKeyboardAction('ArrowRight', items, 1)).toEqual({
      type: 'expand',
    })
    expect(getTreeKeyboardAction('ArrowRight', items, 0)).toEqual({
      type: 'focus',
      index: 1,
    })
  })

  it('collapses expanded branches or moves to the parent', () => {
    expect(getTreeKeyboardAction('ArrowLeft', items, 0)).toEqual({
      type: 'collapse',
    })
    expect(getTreeKeyboardAction('ArrowLeft', items, 2)).toEqual({
      type: 'focus',
      index: 0,
    })
  })

  it('ignores keys and edge moves that have no tree action', () => {
    expect(getTreeKeyboardAction('ArrowUp', items, 0)).toBeNull()
    expect(getTreeKeyboardAction('ArrowRight', items, 2)).toBeNull()
    expect(getTreeKeyboardAction('Enter', items, 1)).toBeNull()
  })
})

describe('reconcileTreeFocus', () => {
  it('falls back when a focused folder disappears', () => {
    expect(
      reconcileTreeFocus('archive/removed', 'archive', ['archive/kept'], false),
    ).toBe('archive')
    expect(
      reconcileTreeFocus('removed', '', ['documents', 'photos'], false),
    ).toBe('documents')
  })

  it('keeps focus in visible or unrelated branches', () => {
    expect(
      reconcileTreeFocus(
        'archive/kept/report',
        'archive',
        ['archive/kept'],
        false,
      ),
    ).toBe('archive/kept/report')
    expect(
      reconcileTreeFocus('photos/2026', 'archive', ['archive/kept'], false),
    ).toBe('photos/2026')
  })

  it('restores a visible tab stop even when more folders can load', () => {
    expect(
      reconcileTreeFocus('archive/later', 'archive', ['archive/kept'], true),
    ).toBe('archive')
  })

  it('moves focus off a load-more item after the final page loads', () => {
    expect(
      reconcileTreeFocus(
        'load-more:archive',
        'archive',
        ['archive/a', 'archive/z'],
        false,
      ),
    ).toBe('archive/z')
  })
})
