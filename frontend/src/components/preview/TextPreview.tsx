import { useQuery } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'

import { apiClient, ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

import type { PreviewerProps } from './types'

export function TextPreview({ fileKey, src, storage }: PreviewerProps) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['text-preview', storage ?? null, fileKey] as const,
    queryFn: async () => {
      const res = await apiClient.get<string>(src, {
        responseType: 'text',
        // Override the global JSON Accept so the proxy returns the raw body.
        headers: { Accept: 'text/plain, */*' },
        transformResponse: [(value) => value],
      })
      return res.data
    },
    staleTime: 60_000,
  })

  return (
    <div className="flex h-full w-full overflow-hidden rounded-md bg-muted/30">
      {isPending && (
        <div className="flex w-full flex-col gap-2 p-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      )}
      {isError && (
        <div className="w-full p-3">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Failed to load text</AlertTitle>
            <AlertDescription>
              {error instanceof ApiError
                ? `${error.status} — ${error.message}`
                : error instanceof Error
                  ? error.message
                  : 'Unknown error.'}
            </AlertDescription>
          </Alert>
        </div>
      )}
      {data !== undefined && (
        <pre className="h-full w-full overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
          {data}
        </pre>
      )}
    </div>
  )
}
