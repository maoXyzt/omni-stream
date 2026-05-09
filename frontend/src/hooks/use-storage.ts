import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { listFiles, statFile } from '@/api/storage'

export function useListFiles(prefix: string, pageToken?: string) {
  return useQuery({
    queryKey: ['list', prefix, pageToken ?? null] as const,
    queryFn: () => listFiles(prefix, pageToken),
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  })
}

export function useFileStat(key: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['stat', key] as const,
    queryFn: () => statFile(key),
    enabled: enabled && key.length > 0,
    staleTime: 60_000,
  })
}
