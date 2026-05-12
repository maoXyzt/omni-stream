import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { listFiles, listStorages, statFile } from '@/api/storage'

export function useStorages() {
  return useQuery({
    queryKey: ['storages'] as const,
    queryFn: listStorages,
    // Storage roster is configured on the server and only changes on restart.
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
    // 5 minutes: long enough that navigating between sibling dirs (and the
    // sidebar's parent-dir read) reuses the cache without refetching. Short
    // enough that a user returning after a break sees a fresh listing.
    staleTime: 5 * 60_000,
    enabled: storage !== undefined,
  })
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
