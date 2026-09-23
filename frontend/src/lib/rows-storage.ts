import type { RenderContext } from '@/components/preview/rows-widgets'
import type { StorageDescriptor } from '@/types/storage'

export type WidgetStorageResolution =
  | { status: 'loading' }
  | { status: 'error'; message: string; retry: () => void; retrying: boolean }
  | { status: 'unknown'; storage: string }
  | {
      status: 'ready'
      storage: string | undefined
      descriptor: StorageDescriptor | undefined
    }

export function resolveWidgetStorage(
  requestedStorage: string | undefined,
  ctx: Pick<RenderContext, 'storage' | 'storageDescriptor' | 'storageRoster'>,
): WidgetStorageResolution {
  if (!requestedStorage) {
    return {
      status: 'ready',
      storage: ctx.storage,
      descriptor: ctx.storageDescriptor,
    }
  }
  if (ctx.storageRoster.status === 'loading') return { status: 'loading' }
  if (ctx.storageRoster.status === 'error') {
    return {
      status: 'error',
      message: ctx.storageRoster.message,
      retry: ctx.storageRoster.retry,
      retrying: ctx.storageRoster.retrying,
    }
  }
  const descriptor = ctx.storageRoster.descriptors.find(
    (candidate) => candidate.name === requestedStorage,
  )
  if (!descriptor) return { status: 'unknown', storage: requestedStorage }
  return { status: 'ready', storage: requestedStorage, descriptor }
}
