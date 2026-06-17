import { cn } from "@/lib/utils"

/// Keycap badge for keyboard shortcut hints.
///
/// Variants:
///   - "tooltip" (default) — inverted colours for use inside Tooltip content
///     (`bg-primary-foreground/15` on a `bg-primary` tooltip surface).
///   - "default" — neutral surface colours for use in dialogs, command
///     palettes, and help panels.
///
/// Usage:
///   <Kbd>⌘</Kbd>           — single key
///   <Kbd>K</Kbd>           — single key
///   <Kbd variant="default">?</Kbd>  — in a non-tooltip context
interface KbdProps {
  children: React.ReactNode
  variant?: 'tooltip' | 'default'
  className?: string
}

export function Kbd({ children, variant = 'tooltip', className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded px-1 font-mono text-[10px] leading-none',
        variant === 'tooltip'
          ? 'border border-primary-foreground/30 bg-primary-foreground/15'
          : 'border border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
