import { zipSync } from 'fflate'
import { dump } from 'npyjs'
import { describe, expect, it } from 'vitest'

import {
  NpzLimitError,
  parseNpy,
  parseNpz,
  pointDimensions,
  sampledPointRows,
} from './npz'

function npyBytes(values: number[], shape: number[]): Uint8Array {
  return new Uint8Array(dump(Float32Array.from(values), shape))
}

describe('parseNpz', () => {
  it('reads named arrays and preserves their shape and dtype', () => {
    const bytes = zipSync({
      'random_surface.npy': npyBytes([1, 2, 3, 0, 0, 1], [1, 6]),
      'labels.npy': npyBytes([-1, 1], [2]),
    })

    const parsed = parseNpz(bytes.buffer)

    expect(parsed.arrays.random_surface.shape).toEqual([1, 6])
    expect(parsed.arrays.random_surface.dtype).toBe('f4')
    expect(parsed.arrays.labels.shape).toEqual([2])
  })

  it('rejects archives that exceed the extracted-byte limit', () => {
    const bytes = zipSync({
      'points.npy': npyBytes(new Array(30).fill(1), [10, 3]),
    })

    expect(() =>
      parseNpz(bytes.buffer, {
        maxCompressedBytes: bytes.byteLength,
        maxExtractedBytes: 1,
        maxArrays: 4,
      }),
    ).toThrow(NpzLimitError)
  })

  it('keeps duplicate basenames addressable', () => {
    const bytes = zipSync({
      'train/points.npy': npyBytes([1, 2, 3], [1, 3]),
      'test/points.npy': npyBytes([4, 5, 6], [1, 3]),
    })
    const parsed = parseNpz(bytes.buffer)
    expect(Object.keys(parsed.arrays)).toEqual(['train/points', 'test/points'])
  })

  it('accepts uppercase NPY entries inside an archive', () => {
    const bytes = zipSync({ 'POINTS.NPY': npyBytes([1, 2, 3], [1, 3]) })
    expect(parseNpz(bytes.buffer).arrays.POINTS.shape).toEqual([1, 3])
  })
})

describe('point cloud helpers', () => {
  it('reads Fortran-order coordinates by row', () => {
    expect(sampledPointRows({
      data: Float32Array.from([1, 4, 2, 5, 3, 6]),
      shape: [2, 3], dtype: 'f4', fortranOrder: true,
    })).toEqual(Float32Array.of(1, 2, 3, 4, 5, 6))
  })

  it('treats zero-row arrays as metadata, not renderable geometry', () => {
    const array = parseNpy(dump(new Float32Array(0), [0, 3]))
    expect(pointDimensions(array)).toBeNull()
  })

  it('rejects headers whose shape would read outside the payload', () => {
    const bytes = dump(Float32Array.of(1, 2, 3), [1, 3])
    const view = new Uint8Array(bytes)
    const headerLength = new DataView(bytes).getUint16(8, true)
    const headerStart = 10
    const header = new TextDecoder().decode(view.slice(headerStart, headerStart + headerLength))
    const offset = header.indexOf('(1, 3)')
    view.set(new TextEncoder().encode('(9, 3)'), headerStart + offset)
    expect(() => parseNpy(bytes)).toThrow()
  })

  it('recognises XYZ and XYZ+normal arrays', () => {
    const bytes = npyBytes([1, 2, 3, 4, 5, 6], [2, 3])
    const parsed = parseNpz(
      zipSync({ 'points.npy': bytes }).buffer,
    )
    expect(pointDimensions(parsed.arrays.points)).toBe(3)
  })

  it('samples rows without changing their component order', () => {
    const parsed = parseNpz(
      zipSync({
        'points.npy': npyBytes([1, 2, 3, 4, 5, 6, 7, 8, 9], [3, 3]),
      }).buffer,
    )
    expect(sampledPointRows(parsed.arrays.points, 2)).toEqual(
      Float32Array.from([1, 2, 3, 7, 8, 9]),
    )
  })
})
