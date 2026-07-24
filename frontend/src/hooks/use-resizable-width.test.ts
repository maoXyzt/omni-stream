import { describe, expect, it } from 'vitest'

import {
  getKeyboardResizeWidth,
  getResizeDragMax,
} from '@/hooks/use-resizable-width'

describe('getKeyboardResizeWidth', () => {
  it('steps left and right while respecting bounds', () => {
    expect(getKeyboardResizeWidth('ArrowLeft', 200, 180, 480)).toBe(184)
    expect(getKeyboardResizeWidth('ArrowLeft', 184, 180, 480)).toBe(180)
    expect(getKeyboardResizeWidth('ArrowRight', 472, 180, 480)).toBe(480)
  })

  it('supports Home/End and ignores unrelated keys', () => {
    expect(getKeyboardResizeWidth('Home', 240, 180, 480)).toBe(180)
    expect(getKeyboardResizeWidth('End', 240, 180, 480)).toBe(480)
    expect(getKeyboardResizeWidth('Enter', 240, 180, 480)).toBeNull()
  })
})

describe('getResizeDragMax', () => {
  it('uses only a stricter temporary maximum', () => {
    expect(getResizeDragMax(600)).toBe(600)
    expect(getResizeDragMax(600, 480)).toBe(480)
    expect(getResizeDragMax(600, 720)).toBe(600)
  })
})
