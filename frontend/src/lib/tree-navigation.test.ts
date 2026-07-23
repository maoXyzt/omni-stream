import { describe, expect, it } from 'vitest'

import { getTreeKeyboardAction, type VisibleTreeItem } from '@/lib/tree-navigation'

const items: VisibleTreeItem[] = [
  { depth: 0, expanded: true },
  { depth: 1, expanded: false },
  { depth: 1, expanded: null },
  { depth: 0, expanded: false },
]

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
