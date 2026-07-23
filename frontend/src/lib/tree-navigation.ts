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

export function reconcileTreeFocus(
  focusedKey: string | null,
  parent: string,
  visibleFolderKeys: readonly string[],
  hasNextPage: boolean,
): string | null {
  if (focusedKey === null) return null

  const loadMoreKey = `load-more:${parent}`
  if (focusedKey === loadMoreKey) {
    return hasNextPage
      ? focusedKey
      : (visibleFolderKeys.at(-1) ?? (parent || null))
  }
  if (focusedKey.startsWith('load-more:') || focusedKey === parent) {
    return focusedKey
  }
  if (parent && !isSameOrDescendant(focusedKey, parent)) {
    return focusedKey
  }
  if (visibleFolderKeys.some((key) => isSameOrDescendant(focusedKey, key))) {
    return focusedKey
  }
  return parent || visibleFolderKeys[0] || null
}

function isSameOrDescendant(key: string, ancestor: string): boolean {
  return (
    key === ancestor ||
    key.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`)
  )
}
