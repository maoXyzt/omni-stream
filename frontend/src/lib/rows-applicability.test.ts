import { describe, expect, it } from 'vitest'

import { parseRules, type Node } from '@/lib/rows-schema'
import { presetMatch } from '@/lib/rows-applicability'

function rules(input: unknown): Node[] {
  const r = parseRules(input)
  if (r.error) throw new Error(`fixture failed parseRules: ${r.error}`)
  return r.rules
}

describe('presetMatch', () => {
  it('empty rules trivially fit any file', () => {
    const m = presetMatch([], ['anything'])
    expect(m.fits).toBe(true)
    expect(m.referenced.size).toBe(0)
    expect(m.matched.size).toBe(0)
    expect(m.missing.size).toBe(0)
  })

  it('single atom resolves when its root column exists', () => {
    const m = presetMatch(rules(['prompt']), ['prompt', 'extra'])
    expect(m.fits).toBe(true)
    expect([...m.referenced]).toEqual(['prompt'])
    expect([...m.matched]).toEqual(['prompt'])
  })

  it('missing column flips fits to false', () => {
    const m = presetMatch(rules(['caption']), ['prompt'])
    expect(m.fits).toBe(false)
    expect([...m.missing]).toEqual(['caption'])
  })

  it('extracts the root column from a chained selector', () => {
    // `images.[*].path` should be tracked as a reference to `images`.
    const m = presetMatch(
      rules([{ image: 'images.[*].path' }]),
      ['images'],
    )
    expect(m.fits).toBe(true)
    expect([...m.referenced]).toEqual(['images'])
  })

  it('walks into containers recursively', () => {
    const m = presetMatch(
      rules([
        {
          row: [
            'prompt',
            { image: 'thumb' },
            { column: [{ markdown: 'description' }] },
          ],
        },
      ]),
      ['prompt', 'thumb', 'description'],
    )
    expect(m.fits).toBe(true)
    expect([...m.referenced].sort()).toEqual(['description', 'prompt', 'thumb'])
  })

  it('partial match reports both matched and missing sets', () => {
    const m = presetMatch(
      rules([
        'prompt',
        { image: 'thumb' },
        { video: 'clip' },
      ]),
      ['prompt', 'thumb'],
    )
    expect(m.fits).toBe(false)
    expect([...m.matched].sort()).toEqual(['prompt', 'thumb'])
    expect([...m.missing]).toEqual(['clip'])
  })

  it('backtick-quoted column names are matched literally', () => {
    const m = presetMatch(
      rules([{ image: '`weird.col`' }]),
      ['weird.col'],
    )
    expect(m.fits).toBe(true)
    expect([...m.referenced]).toEqual(['weird.col'])
  })
})
