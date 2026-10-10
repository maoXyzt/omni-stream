import { describe, expect, it } from 'vitest'

import { LARGE_PREVIEW_BYTES, isLargePreview } from './large-preview-gate'

describe('isLargePreview', () => {
  it('gates model and NumPy files strictly above 10 MiB', () => {
    expect(isLargePreview('model3d', LARGE_PREVIEW_BYTES)).toBe(false)
    expect(isLargePreview('model3d', LARGE_PREVIEW_BYTES + 1)).toBe(true)
    expect(isLargePreview('numpy', LARGE_PREVIEW_BYTES + 1)).toBe(true)
  })

  it('does not gate unrelated previews or unknown sizes', () => {
    expect(isLargePreview('image', LARGE_PREVIEW_BYTES + 1)).toBe(false)
    expect(isLargePreview('model3d', undefined)).toBe(false)
    expect(isLargePreview('numpy', Number.NaN)).toBe(false)
  })
})
