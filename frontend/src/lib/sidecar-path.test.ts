import { describe, expect, it } from 'vitest'

import { joinSidecarKey } from './sidecar-path'

describe('joinSidecarKey', () => {
  it('resolves safe relative sidecars and strips URL metadata', () => {
    expect(joinSidecarKey('models/scene/model.gltf', './textures/albedo.png?v=2')).toBe(
      'models/scene/textures/albedo.png',
    )
  })

  it('rejects absolute, external, and parent paths', () => {
    for (const url of ['/texture.png', 'https://example.com/texture.png', '../texture.png', '%2e%2e/texture.png']) {
      expect(() => joinSidecarKey('models/scene/model.gltf', url)).toThrow()
    }
  })
})
