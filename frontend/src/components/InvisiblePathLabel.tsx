import { TriangleAlert } from 'lucide-react'

import {
  describeInvisibleChars,
  findInvisibleChars,
  visualizeInvisibleChars,
} from '@/lib/path'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface Props {
  value: string
  showInvisible: boolean
  className?: string
}

export function InvisiblePathLabel({ value, showInvisible, className }: Props) {
  const chars = findInvisibleChars(value)
  const hasInvisible = chars.length > 0
  const display = showInvisible && hasInvisible
    ? visualizeInvisibleChars(value)
    : value
  const description = hasInvisible
    ? `Contains invisible characters: ${describeInvisibleChars(value)}`
    : undefined

  if (!hasInvisible) {
    return (
      <span className={cn('min-w-0 truncate', className)} title={value}>
        {value}
      </span>
    )
  }

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="min-w-0 truncate" title={display}>
        {display}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            tabIndex={0}
            className="inline-flex shrink-0 rounded-sm text-amber-600 outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-amber-400"
            aria-label={description}
          >
            <TriangleAlert className="size-3.5" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
    </span>
  )
}
