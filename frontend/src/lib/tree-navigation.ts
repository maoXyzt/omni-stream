export interface VisibleTreeItem {
  depth: number
  expanded: boolean | null
}

export type TreeKeyboardAction =
  | { type: 'focus'; index: number }
  | { type: 'expand' | 'collapse' }
  | null

export function getTreeKeyboardAction(
  key: string,
  items: readonly VisibleTreeItem[],
  index: number,
): TreeKeyboardAction {
  const current = items[index]
  if (!current) return null

  if (key === 'ArrowDown' && index < items.length - 1) {
    return { type: 'focus', index: index + 1 }
  }
  if (key === 'ArrowUp' && index > 0) {
    return { type: 'focus', index: index - 1 }
  }
  if (key === 'Home' && index > 0) {
    return { type: 'focus', index: 0 }
  }
  if (key === 'End' && index < items.length - 1) {
    return { type: 'focus', index: items.length - 1 }
  }
  if (key === 'ArrowRight') {
    if (current.expanded === false) return { type: 'expand' }
    const child = items[index + 1]
    if (current.expanded === true && child && child.depth > current.depth) {
      return { type: 'focus', index: index + 1 }
    }
  }
  if (key === 'ArrowLeft') {
    if (current.expanded === true) return { type: 'collapse' }
    for (let i = index - 1; i >= 0; i--) {
      if (items[i]?.depth < current.depth) {
        return { type: 'focus', index: i }
      }
    }
  }
  return null
}
