import { expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { readLancePage } from './lance-page'

const tooLarge = new ApiError(413, 'The preview exceeds the 4 MiB display limit.')

it.each([false, true])('keeps the adjoining edge on retry (backwards=%s)', async backwards => {
  const read = vi.fn(async (offset: number, limit: number) => {
    if (limit > 1) throw tooLarge
    return offset
  })
  const result = await readLancePage({ offset: 10, limit: 10, backwards }, read)
  expect(read.mock.calls).toEqual(backwards ? [[10, 10], [15, 5], [19, 1]] : [[10, 10], [10, 5], [10, 1]])
  expect(result).toEqual({ data: backwards ? 19 : 10, limit: 1 })
})

it('reports the row and backend limit if one row still fails', async () => {
  await expect(readLancePage({ offset: 8, limit: 1 }, async () => { throw tooLarge }))
    .rejects.toThrow(/row 9.*4 MiB/)
})

it('propagates other errors without changing the requested range', async () => {
  const error = new ApiError(403, 'Access denied')
  const read = vi.fn().mockRejectedValue(error)
  await expect(readLancePage({ offset: 0, limit: 10 }, read)).rejects.toBe(error)
  expect(read).toHaveBeenCalledTimes(1)
})
