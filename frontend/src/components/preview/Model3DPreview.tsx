import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { parseModelObject } from '@/lib/model-object'
import { readModelSource } from '@/lib/model-source'

import { ThreeViewport } from './ThreeViewport'
import type { PreviewerProps } from './types'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'The 3D file could not be loaded.'
}

export function Model3DPreview({ fileKey, src, storage }: PreviewerProps) {
  const modelQuery = useQuery({
    queryKey: ['model-preview', storage ?? '', fileKey, src] as const,
    queryFn: ({ signal }) => readModelSource(fileKey, src, storage, signal),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    structuralSharing: false,
  })

  const loadObject = useCallback(
    async (signal: AbortSignal) => {
      if (!modelQuery.data) throw new Error('The model bytes are not available.')
      return parseModelObject(modelQuery.data, fileKey, signal)
    },
    [fileKey, modelQuery.data],
  )

  if (modelQuery.isPending) {
    return <Skeleton className="min-h-0 w-full flex-1 rounded-md" />
  }
  if (modelQuery.isError) {
    return (
      <div className="flex min-h-0 w-full flex-1 items-center justify-center rounded-md border p-6">
        <Alert variant="destructive" className="max-w-lg">
          <AlertTitle>Failed to load 3D preview.</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(modelQuery.error)}</p>
            <Button variant="outline" size="sm" onClick={() => void modelQuery.refetch()}>Retry</Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }
  return <ThreeViewport loadObject={loadObject} />
}
