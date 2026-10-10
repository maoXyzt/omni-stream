import { describe, expect, it } from 'vitest'

import { gltfResourceUris } from './model-source'

describe('gltfResourceUris', () => {
  it('extracts external buffers and images from JSON glTF', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      buffers: [{ uri: 'mesh.bin', byteLength: 4 }],
      images: [{ uri: 'textures/albedo.png' }, { uri: 'data:image/png;base64,AA==' }],
    }))
    expect(gltfResourceUris(bytes.buffer, false)).toEqual(['mesh.bin', 'textures/albedo.png'])
  })

  it('extracts resources from a GLB JSON chunk', () => {
    const json = new TextEncoder().encode(JSON.stringify({ buffers: [{ uri: 'mesh.bin' }] }))
    const padded = new Uint8Array(Math.ceil(json.length / 4) * 4)
    padded.set(json)
    const bytes = new ArrayBuffer(20 + padded.length)
    const view = new DataView(bytes)
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, bytes.byteLength, true)
    view.setUint32(12, json.length, true)
    view.setUint32(16, 0x4e4f534a, true)
    new Uint8Array(bytes, 20).set(padded)
    expect(gltfResourceUris(bytes, true)).toEqual(['mesh.bin'])
  })
})
