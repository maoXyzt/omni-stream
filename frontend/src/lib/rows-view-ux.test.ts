import { describe, expect, it } from 'vitest'

import { shouldKeepPreviousRowsPage } from '@/lib/rows-view-ux'

describe('shouldKeepPreviousRowsPage', () => {
  it('keeps pagination data only within the same storage and file', () => {
    expect(
      shouldKeepPreviousRowsPage(
        ['rows-data', 'primary', 'events.jsonl', 0],
        'primary',
        'events.jsonl',
      ),
    ).toBe(true)
    expect(
      shouldKeepPreviousRowsPage(
        ['rows-data', 'archive', 'events.jsonl', 0],
        'primary',
        'events.jsonl',
      ),
    ).toBe(false)
    expect(
      shouldKeepPreviousRowsPage(
        ['rows-data', 'primary', 'other.jsonl', 0],
        'primary',
        'events.jsonl',
      ),
    ).toBe(false)
  })
})
