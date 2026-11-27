import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { LanceRowTooLarge } from '@/lib/lance-page'
import { LanceDataPage, LancePreview } from './LancePreview'

const query = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-query', () => ({ useQuery: query, keepPreviousData: vi.fn() }))

function preview(fileKey: string, src: string) {
  return renderToStaticMarkup(
    <MemoryRouter><LancePreview fileKey={fileKey} src={src} storage="local" /></MemoryRouter>,
  )
}

it('keeps a single-row failure navigable at the actual row', () => {
  query.mockReturnValue({ isError: true, error: new LanceRowTooLarge(10, new ApiError(413, 'Too large')) })
  const html = renderToStaticMarkup(<LanceDataPage fileKey="part.lance" src="/part" totalRows={20} />)
  expect(html).toContain('Cannot preview row 11')
  expect(html).toContain('value="11"')
  expect(html).toContain('Prev')
  expect(html).toContain('Next')
})

it('includes the physical file revision but keeps dataset queries tied to the snapshot', () => {
  query.mockReturnValue({ isPending: true })
  const key = (file: string, revision: string) => {
    preview(file, revision)
    return query.mock.lastCall?.[0].queryKey
  }
  expect(key('part.lance', '/part?v=2')).not.toEqual(key('part.lance', '/part?v=3'))
  expect(key('data.lance/', '/data?v=2')).toEqual(key('data.lance/', '/data?v=3'))
})

it.each(['set.lance/', 'part.lance'])('opens %s on Schema without requesting rows', fileKey => {
  query.mockClear()
  query.mockReturnValue({ data: { total: 20, columns: [{ name: 'id', type: 'Int64', nullable: false }] } })
  const html = preview(fileKey, '/sample')
  expect(html).toContain('Int64')
  expect(query).toHaveBeenCalledTimes(1)
  expect(query.mock.lastCall?.[0].queryKey[0]).toBe('lance-schema')
})
