import type { ViewMode } from '@/hooks/use-view-mode'

export type RovingDirection = 'up' | 'down' | 'left' | 'right'

type AttributeTarget = {
  getAttribute(name: string): string | null
}

function hasAttributeTarget(value: unknown): value is AttributeTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getAttribute' in value &&
    typeof (value as AttributeTarget).getAttribute === 'function'
  )
}

export function getRovingKey(target: unknown): string | null {
  if (!hasAttributeTarget(target)) return null
  return target.getAttribute('data-roving-key')
}

export function isRovingEntryTarget(target: unknown): boolean {
  return getRovingKey(target) !== null
}

export function shouldEnterRovingRing(active: unknown, body: unknown): boolean {
  return active == null || active === body || isRovingEntryTarget(active)
}

export function getRovingStep(
  viewMode: ViewMode,
  dir: RovingDirection,
  columns: number,
): number | null {
  if (viewMode === 'list') {
    if (dir === 'down') return 1
    if (dir === 'up') return -1
    return null
  }

  if (dir === 'right') return 1
  if (dir === 'left') return -1
  return dir === 'down' ? columns : -columns
}

export function getRovingEntryAction(
  key: string,
  target: unknown,
  currentTarget: unknown,
  selectable: boolean,
): 'activate' | 'select' | null {
  if (target !== currentTarget) return null
  if (key === 'Enter') return 'activate'
  if (key === ' ') return selectable ? 'select' : 'activate'
  return null
}
