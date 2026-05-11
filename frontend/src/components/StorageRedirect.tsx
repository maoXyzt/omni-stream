import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import { Navigate } from 'react-router-dom'

import { ApiError } from '@/api/client'
import { useStorages } from '@/hooks/use-storage'
import { TokenPrompt } from '@/components/TokenPrompt'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * `/` has no storage context yet — fetch the list and route the user to the
 * default storage at the root prefix. Keeping the redirect inside React (rather
 * than as a server-side rewrite) means the URL the user lands on already
 * encodes the active storage and is therefore directly shareable.
 */
export function StorageRedirect() {
  const queryClient = useQueryClient()
  const { data, error, isPending } = useStorages()

  if (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403)
  ) {
    return (
      <TokenPrompt
        onSubmit={() => queryClient.invalidateQueries()}
      />
    )
  }

  if (isPending) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-2 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  if (error || !data) {
    const message = error instanceof Error ? error.message : 'unknown error'
    return (
      <div className="mx-auto max-w-5xl p-6">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Failed to load storages</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  return <Navigate to={`/s/${encodeURIComponent(data.default)}/`} replace />
}
