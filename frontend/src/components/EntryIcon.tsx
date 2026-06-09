import { Link2, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

interface EntryIconProps {
  /** The primary lucide icon component to render. */
  Icon: LucideIcon
  /** Tailwind color class applied to the primary icon (e.g. "text-amber-500"). */
  color?: string
  /** When true, a small symlink badge is overlaid at the bottom-right corner. */
  isSymlink?: boolean
  /** Additional classes forwarded to the primary icon (e.g. "size-4 shrink-0"). */
  className?: string
}

/**
 * Renders a file-system entry's icon with an optional symlink badge.
 *
 * Always renders an `inline-flex relative` outer span so the DOM structure is
 * consistent regardless of symlink status, avoiding layout shifts or remounts
 * if the prop changes. The badge (Link2) is conditionally rendered inside it.
 *
 * Used by FileRow, GalleryRow, FileTile and TreeNode so all four views stay
 * visually consistent with a single implementation.
 */
export function EntryIcon({
  Icon,
  color,
  isSymlink = false,
  className,
}: EntryIconProps) {
  return (
    <span className="relative inline-flex shrink-0">
      <Icon className={cn(color, className)} />
      {isSymlink && (
        <Link2
          aria-label="symlink"
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-background stroke-[2.5] text-muted-foreground"
        />
      )}
    </span>
  )
}
