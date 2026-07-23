import { describe, expect, it } from 'vitest'

import {
  getRovingStep,
  getRovingEntryAction,
  isRovingEntryTarget,
  shouldEnterRovingRing,
} from '@/lib/roving-navigation'

describe('roving navigation guards', () => {
  it('only enters the roving ring from body-level focus', () => {
    const body = { id: 'body' }
    const toolbarButton = { id: 'toolbar' }

    expect(shouldEnterRovingRing(body, body)).toBe(true)
    expect(shouldEnterRovingRing(null, body)).toBe(true)
    expect(shouldEnterRovingRing(toolbarButton, body)).toBe(false)
  })

  it('recognizes existing roving entry targets', () => {
    const entry = {
      getAttribute(name: string) {
        return name === 'data-roving-key' ? 'file.txt' : null
      },
    }
    const toolbarButton = {
      getAttribute() {
        return null
      },
    }

    expect(isRovingEntryTarget(entry)).toBe(true)
    expect(isRovingEntryTarget(toolbarButton)).toBe(false)
    expect(isRovingEntryTarget(null)).toBe(false)
  })

  it('does not handle horizontal movement in list view', () => {
    expect(getRovingStep('list', 'down', 4)).toBe(1)
    expect(getRovingStep('list', 'up', 4)).toBe(-1)
    expect(getRovingStep('list', 'left', 4)).toBeNull()
    expect(getRovingStep('list', 'right', 4)).toBeNull()
  })

  it('steps by column count for vertical movement in grid view', () => {
    expect(getRovingStep('grid', 'down', 3)).toBe(3)
    expect(getRovingStep('grid', 'up', 3)).toBe(-3)
    expect(getRovingStep('grid', 'right', 3)).toBe(1)
    expect(getRovingStep('grid', 'left', 3)).toBe(-1)
  })

  it('collapses to ±1 when grid has a single column', () => {
    expect(getRovingStep('grid', 'down', 1)).toBe(1)
    expect(getRovingStep('grid', 'up', 1)).toBe(-1)
  })

  it('opens with Enter, selects files with Space, and ignores child controls', () => {
    const row = { id: 'row' }
    const checkbox = { id: 'checkbox' }

    expect(getRovingEntryAction('Enter', row, row, true)).toBe('activate')
    expect(getRovingEntryAction(' ', row, row, true)).toBe('select')
    expect(getRovingEntryAction(' ', row, row, false)).toBe('activate')
    expect(getRovingEntryAction('Enter', checkbox, row, true)).toBeNull()
    expect(getRovingEntryAction(' ', checkbox, row, true)).toBeNull()
    expect(getRovingEntryAction('ArrowDown', row, row, true)).toBeNull()
  })
})
