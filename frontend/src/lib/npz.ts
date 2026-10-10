import { unzipSync } from 'fflate'
import { float16ToFloat32, parse, type NpyArray } from 'npyjs'

export interface NpzLimits {
  maxCompressedBytes: number
  maxExtractedBytes: number
  maxArrays: number
}

export const DEFAULT_NPZ_LIMITS: NpzLimits = {
  maxCompressedBytes: 32 * 1024 * 1024,
  maxExtractedBytes: 128 * 1024 * 1024,
  maxArrays: 64,
}

export interface ParsedNpz {
  arrays: Record<string, NpyArray>
  compressedBytes: number
  extractedBytes: number
}

export class NpzLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NpzLimitError'
  }
}

const NUMERIC_DTYPES = new Set([
  'i1', 'u1', 'i2', 'u2', 'i4', 'u4', 'i8', 'u8', 'f2', 'f4', 'f8',
])

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function arrayName(entryName: string): string {
  return entryName.slice(0, -4)
}

export function parseNpy(bytes: ArrayBuffer): NpyArray {
  // Validate the header before npyjs constructs arrays; do not expand bools or
  // float16 into JS arrays or larger buffers merely to show metadata.
  if (bytes.byteLength < 10) throw new Error('Invalid NPY header.')
  const view = new DataView(bytes)
  const major = view.getUint8(6)
  if (major < 1 || major > 3 || (major > 1 && bytes.byteLength < 12)) {
    throw new Error('Unsupported NPY version.')
  }
  const headerStart = major === 1 ? 10 : 12
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true)
  if (headerLength > 65536 || headerStart + headerLength > bytes.byteLength) {
    throw new Error('Invalid NPY header length.')
  }
  const header = new TextDecoder().decode(new Uint8Array(bytes, headerStart, headerLength))
  if (new Uint8Array(bytes, 0, 6).some((value, index) =>
    value !== [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59][index])) {
    throw new Error('Invalid NPY signature.')
  }
  if (/'descr'\s*:\s*'[<|>=]?[SUOSV]/.test(header)) {
    throw new Error('String, object, and structured NumPy arrays are not supported.')
  }
  const array: NpyArray = /'descr'\s*:\s*'[<|]b1'/.test(header) ? {
    data: new Uint8Array(bytes, headerStart + headerLength),
    dtype: 'b1',
    shape: (/'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1] ?? '')
      .split(',').map((part) => part.trim()).filter(Boolean).map(Number),
    fortranOrder: /'fortran_order'\s*:\s*True/.test(header),
  } : parse(bytes, { convertFloat16: false })
  if (array.shape.some((dimension) => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new NpzLimitError('NPY shape contains an invalid dimension.')
  }
  const expected = array.shape.reduce((total, dimension) => total * dimension, 1)
  const data = array.data as unknown as ArrayLike<unknown> & {
    byteLength?: number
    BYTES_PER_ELEMENT?: number
  }
  const actual = data.byteLength !== undefined && data.BYTES_PER_ELEMENT
    ? data.byteLength / data.BYTES_PER_ELEMENT
    : data.length
  if (!Number.isSafeInteger(expected) || expected > actual) {
    throw new NpzLimitError('NPY payload is shorter than its declared shape.')
  }
  return array
}

export function parseNpz(
  bytes: ArrayBuffer,
  limits: NpzLimits = DEFAULT_NPZ_LIMITS,
): ParsedNpz {
  if (bytes.byteLength > limits.maxCompressedBytes) {
    throw new NpzLimitError(
      `NPZ file is too large (${bytes.byteLength.toLocaleString()} bytes; limit is ${limits.maxCompressedBytes.toLocaleString()})`,
    )
  }

  let extractedBytes = 0
  let arrayCount = 0
  const archive = unzipSync(new Uint8Array(bytes), {
    filter: (entry) => {
      if (!entry.name.toLowerCase().endsWith('.npy')) return false
      arrayCount += 1
      extractedBytes += entry.originalSize
      if (arrayCount > limits.maxArrays) {
        throw new NpzLimitError(
          `NPZ contains too many arrays (limit is ${limits.maxArrays})`,
        )
      }
      if (extractedBytes > limits.maxExtractedBytes) {
        throw new NpzLimitError(
          `NPZ expands beyond the safe limit (${limits.maxExtractedBytes.toLocaleString()} bytes)`,
        )
      }
      return true
    },
  })

  const arrays: Record<string, NpyArray> = Object.create(null)
  for (const entryName of Object.keys(archive)) {
    const data = archive[entryName]
    if (!data) continue
    arrays[arrayName(entryName)] = parseNpy(exactArrayBuffer(data))
    // Release the decompressed archive entry as soon as its typed array has
    // been parsed. This keeps the archive from retaining every raw copy while
    // the parsed arrays are still needed for the preview.
    delete archive[entryName]
  }

  return {
    arrays,
    compressedBytes: bytes.byteLength,
    extractedBytes,
  }
}

export function isNumericArray(array: NpyArray): boolean {
  return NUMERIC_DTYPES.has(array.dtype)
}

export function pointDimensions(array: NpyArray): number | null {
  if (!isNumericArray(array) || array.shape.length !== 2) return null
  if (array.shape[0] <= 0) return null
  const dimensions = array.shape[1]
  return dimensions === 3 || dimensions === 6 ? dimensions : null
}

export function sampledPointRows(
  array: NpyArray,
  maxPoints = 100_000,
): Float32Array | null {
  const dimensions = pointDimensions(array)
  if (!dimensions || maxPoints < 1) return null
  const rows = array.shape[0]
  const stride = Math.max(1, Math.ceil(rows / maxPoints))
  const sampledRows = Math.ceil(rows / stride)
  const output = new Float32Array(sampledRows * dimensions)
  const source = array.data as unknown as ArrayLike<number | bigint>

  let outputOffset = 0
  for (let row = 0; row < rows; row += stride) {
    for (let column = 0; column < dimensions; column += 1) {
      const sourceOffset = array.fortranOrder
        ? column * rows + row
        : row * dimensions + column
      const value = source[sourceOffset]
      output[outputOffset++] = array.dtype === 'f2' ? float16ToFloat32(Number(value)) : Number(value)
    }
  }
  return output
}

export function sampledScalarValues(
  array: NpyArray,
  maxValues: number,
): Float32Array | null {
  if (!isNumericArray(array) ||
    !(array.shape.length === 1 || (array.shape.length === 2 && array.shape[1] === 1)) ||
    maxValues < 1) {
    return null
  }
  const values = array.data as unknown as ArrayLike<number | bigint>
  const stride = Math.max(1, Math.ceil(array.shape[0] / maxValues))
  const output = new Float32Array(Math.ceil(array.shape[0] / stride))
  let outputOffset = 0
  for (let index = 0; index < array.shape[0]; index += stride) {
    const value = values[index]
    output[outputOffset++] = array.dtype === 'f2' ? float16ToFloat32(Number(value)) : Number(value)
  }
  return output
}
