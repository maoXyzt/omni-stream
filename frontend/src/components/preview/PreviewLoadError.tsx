import { RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const OBJECT_READ_PERMISSION_HINT =
  'For S3, s3:ListBucket only lists object names; previewing requires s3:GetObject (and kms:Decrypt for SSE-KMS).'

interface Props {
  kind: 'image' | 'video' | 'audio'
  onRetry?: () => void
  className?: string
}

export function PreviewLoadError({ kind, onRetry, className }: Props) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        className,
      )}
    >
      <p className="text-sm font-medium text-destructive">
        Failed to load {kind}.
      </p>
      <p className="max-w-lg text-xs text-muted-foreground">
        {OBJECT_READ_PERMISSION_HINT}
      </p>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCw className="size-4" />
          Retry
        </Button>
      )}
    </div>
  )
}
