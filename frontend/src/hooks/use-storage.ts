import { useCallback } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { getServerInfo, listFiles, listStorages, statFile } from '@/api/storage'

export function useStorages() {
  return useQuery({
    queryKey: ['storages'] as const,
    queryFn: listStorages,
    // Storage roster is configured on the server and only changes on restart.
    staleTime: Infinity,
  })
}

export function useServerInfo() {
  return useQuery({
    queryKey: ['server'] as const,
    queryFn: getServerInfo,
    // Hostname is read from the kernel once at server boot; it doesn't change
    // for the lifetime of the page, so we cache it forever.
    staleTime: Infinity,
  })
}

export function useListFiles(
  prefix: string,
  pageToken: string | undefined,
  storage: string | undefined,
) {
  return useQuery({
    queryKey: ['list', storage ?? null, prefix, pageToken ?? null] as const,
    queryFn: () => listFiles(prefix, pageToken, storage),
    placeholderData: keepPreviousData,
    // 5 minutes: long enough that paging within a prefix and re-expanding
    // sidebar nodes reuses the cache without refetching, short enough that
    // a user returning after a break sees a fresh listing.
    staleTime: 5 * 60_000,
    // Refetch when the tab regains focus, but only if the data is already
    // stale (cheap by construction — staleTime gates it). Catches the case
    // where the user updates files in another tool and tabs back expecting
    // to see the change. Overrides the global default (`false` in App).
    refetchOnWindowFocus: true,
    enabled: storage !== undefined,
  })
}

export function useInfiniteListFiles(
  prefix: string,
  storage: string | undefined,
) {
  return useInfiniteQuery({
    queryKey: [
      'list',
      storage ?? null,
      prefix,
      { scope: 'tree' },
    ] as const,
    queryFn: ({ pageParam }) => listFiles(prefix, pageParam, storage),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_token ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    enabled: storage !== undefined,
  })
}

/// Imperative companion to `useListFiles` for pre-warming the cache —
/// FileList calls this once the current page has revealed its
/// `next_token` so the user's "Next" click lands instantly. Query key
/// + staleTime mirror `useListFiles` so the prefetched entry is the
/// same cache slot the next mount will read from.
export function usePrefetchListFiles() {
  const queryClient = useQueryClient()
  return useCallback(
    (prefix: string, pageToken: string, storage: string | undefined) => {
      void queryClient.prefetchQuery({
        queryKey: ['list', storage ?? null, prefix, pageToken] as const,
        queryFn: () => listFiles(prefix, pageToken, storage),
        staleTime: 5 * 60_000,
      })
    },
    [queryClient],
  )
}

export function useFileStat(
  key: string,
  storage: string | undefined,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: ['stat', storage ?? null, key] as const,
    queryFn: () => statFile(key, storage),
    enabled: enabled && key.length > 0 && storage !== undefined,
    staleTime: 60_000,
  })
}
