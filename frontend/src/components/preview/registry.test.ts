import { describe, expect, it } from 'vitest'

import { previewTypeForKey, previewableKind } from './registry'

describe('visual file preview registry', () => {
  it('routes supported 3D formats to the model previewer', () => {
    for (const key of ['model.GLB', 'mesh.ply', 'cloud.PCD', 'scene.fbx']) {
      expect(previewableKind(key)).toBe('model3d')
      expect(previewTypeForKey(key)?.extensions).toContain(key.split('.').pop()?.toLowerCase())
    }
  })

  it('routes NumPy files to the array previewer', () => {
    expect(previewableKind('samples/shape.npz')).toBe('numpy')
    expect(previewableKind('samples/points.NPY')).toBe('numpy')
    expect(previewTypeForKey('samples/shape.npz')?.kind).toBe('numpy')
  })
})
