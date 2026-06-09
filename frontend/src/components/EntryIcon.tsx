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
 * The badge is a small Link2 icon placed at the bottom-right of the primary
 * icon, indicating that the entry is a symbolic link without replacing the
 * target-type icon. The outer `<span>` is `inline-flex` with `relative`
 * positioning so callers can treat the whole thing as a sized inline element.
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
  if (!isSymlink) {
    // Fast path: no wrapper overhead when there's no badge to render.
    return <Icon className={cn(color, className)} />
  }

  return (
    <span className="relative inline-flex shrink-0">
      <Icon className={cn(color, className)} />
      <Link2
        aria-label="symlink"
        className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-background stroke-[2.5] text-muted-foreground"
      />
    </span>
  )
}
