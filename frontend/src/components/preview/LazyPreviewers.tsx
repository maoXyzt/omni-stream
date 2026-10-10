import { lazy, Suspense } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import type { PreviewerProps } from './types'

const Model3DPreview = lazy(() =>
  import('./Model3DPreview').then(({ Model3DPreview: component }) => ({
    default: component,
  })),
)
const NpzPreview = lazy(() =>
  import('./NpzPreview').then(({ NpzPreview: component }) => ({
    default: component,
  })),
)

function LoadingPreview() {
  return <Skeleton className="min-h-0 w-full flex-1 rounded-md" />
}

export function LazyModel3DPreview(props: PreviewerProps) {
  return (
    <Suspense fallback={<LoadingPreview />}>
      <Model3DPreview {...props} />
    </Suspense>
  )
}

export function LazyNpzPreview(props: PreviewerProps) {
  return (
    <Suspense fallback={<LoadingPreview />}>
      <NpzPreview {...props} />
    </Suspense>
  )
}
