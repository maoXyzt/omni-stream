import { ApiError } from '@/api/client'

export interface LanceCursor {
  offset: number
  limit: number
  version?: number
  backwards?: boolean
}

// Each smaller size divides the previous one, so existing row boundaries
// still fall on whole pages for the shared page-jump control.
export async function readLancePage<T>(
  cursor: LanceCursor,
  read: (offset: number, limit: number) => Promise<T>,
) {
  let limit = cursor.limit
  for (;;) {
    // Prev must end immediately before the visible rows, even after shrinking.
    const offset = cursor.backwards ? cursor.offset + cursor.limit - limit : cursor.offset
    try {
      return { data: await read(offset, limit), limit }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 413) throw error
      if (limit === 1) {
        throw new Error(`Cannot preview row ${(offset + 1).toLocaleString()} even when read alone. ${error.message}`, { cause: error })
      }
      limit = limit === 10 ? 5 : 1
    }
  }
}
