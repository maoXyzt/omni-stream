import type { PreviewKind } from './types'

export const LARGE_PREVIEW_BYTES = 10 * 1024 * 1024

export function isLargePreview(kind: PreviewKind, size: number | undefined): boolean {
  return (kind === 'model3d' || kind === 'numpy') &&
    size !== undefined && Number.isFinite(size) && size > LARGE_PREVIEW_BYTES
}
