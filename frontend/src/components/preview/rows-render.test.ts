import { describe, expect, it } from 'vitest'

import { resolveWidgetStorage } from '@/lib/rows-storage'
import type { RenderContext } from '@/components/preview/rows-widgets'

const mediaStorage = {
  name: 'media',
  type: 'local' as const,
  valid: true,
  writeable: false,
  local: { root_path: '/data/media' },
}

function context(
  storageRoster: RenderContext['storageRoster'],
): Pick<RenderContext, 'storage' | 'storageDescriptor' | 'storageRoster'> {
  return {
    storage: 'current',
    storageDescriptor: undefined,
    storageRoster,
  }
}

describe('resolveWidgetStorage', () => {
  it('uses the current storage when no override is present', () => {
    expect(resolveWidgetStorage(undefined, context({ status: 'loading' }))).toEqual({
      status: 'ready',
      storage: 'current',
      descriptor: undefined,
    })
  })

  it('waits for roster validation before resolving an override', () => {
    expect(resolveWidgetStorage('media', context({ status: 'loading' }))).toEqual({
      status: 'loading',
    })
  })

  it('surfaces roster errors without resolving an override', () => {
    expect(
      resolveWidgetStorage(
        'media',
        context({ status: 'error', message: 'network unavailable' }),
      ),
    ).toEqual({ status: 'error', message: 'network unavailable' })
  })

  it('rejects unknown storage names', () => {
    expect(
      resolveWidgetStorage(
        'missing',
        context({ status: 'ready', descriptors: [mediaStorage] }),
      ),
    ).toEqual({ status: 'unknown', storage: 'missing' })
  })

  it('returns the selected descriptor for a known storage', () => {
    expect(
      resolveWidgetStorage(
        'media',
        context({ status: 'ready', descriptors: [mediaStorage] }),
      ),
    ).toEqual({ status: 'ready', storage: 'media', descriptor: mediaStorage })
  })
})
