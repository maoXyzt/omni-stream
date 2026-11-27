import { describe, expect, it } from 'vitest'

import { previewTypeForKey, previewableKind } from './registry'

describe('visual file preview registry', () => {
  it('routes Safetensors files to a header-only preview', () => {
    expect(previewableKind('weights/model.SAFETENSORS')).toBe('safetensors')
    expect(previewTypeForKey('weights/model.safetensors')?.kind).toBe('safetensors')
    expect(previewableKind('weights/model.bin')).toBe('generic')
  })

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

it('recognizes Lance dataset directories only when supported', () => {
  expect(previewableKind('nested/test.LANCE/', true)).toBe('lance')
  expect(previewableKind('nested/test.LANCE/')).not.toBe('lance')
  expect(previewableKind('dataset.lance/data/part.lance', true)).toBe('lance')
  expect(previewableKind('standalone.LANCE', true)).toBe('lance')
  expect(previewableKind('standalone.LANCE', false)).toBe('generic')
})
