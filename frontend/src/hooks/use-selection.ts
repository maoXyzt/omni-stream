import { useCallback, useRef, useState } from 'react'

export interface SelectionState {
  selectedKeys: ReadonlySet<string>
  size: number
  isSelected: (key: string) => boolean
  /// Normal (non-shift) toggle. Sets the shift-click anchor to `key`.
  toggle: (key: string) => void
  /// Shift-click toggle — selects the closed interval [anchor, key] in
  /// `orderedKeys`. Falls back to single toggle when the anchor is not
  /// present in `orderedKeys` (e.g. after a filter change).
  toggleRange: (key: string, orderedKeys: readonly string[]) => void
  /// Replace the selection with exactly `keys`.
  selectAll: (keys: readonly string[]) => void
  clear: () => void
}

export function useSelection(): SelectionState {
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const anchorRef = useRef<string | null>(null)

  const toggle = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    anchorRef.current = key
  }, [])

  const toggleRange = useCallback(
    (key: string, orderedKeys: readonly string[]) => {
      const anchor = anchorRef.current
      if (!anchor || !orderedKeys.includes(anchor)) {
        // Anchor absent from current list → treat as single toggle.
        setSelectedKeys((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
        anchorRef.current = key
        return
      }
      const anchorIdx = orderedKeys.indexOf(anchor)
      const clickedIdx = orderedKeys.indexOf(key)
      if (clickedIdx === -1) return
      const [from, to] =
        anchorIdx <= clickedIdx
          ? [anchorIdx, clickedIdx]
          : [clickedIdx, anchorIdx]
      const rangeKeys = orderedKeys.slice(from, to + 1)
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        for (const k of rangeKeys) next.add(k)
        return next
      })
      // Don't update the anchor on shift-click — the anchor stays fixed so
      // successive shift-clicks extend from the same origin.
    },
    [],
  )

  const selectAll = useCallback((keys: readonly string[]) => {
    setSelectedKeys(new Set(keys))
  }, [])

  const clear = useCallback(() => {
    setSelectedKeys(new Set())
    anchorRef.current = null
  }, [])

  const isSelected = useCallback(
    (key: string) => selectedKeys.has(key),
    [selectedKeys],
  )

  return {
    selectedKeys,
    size: selectedKeys.size,
    isSelected,
    toggle,
    toggleRange,
    selectAll,
    clear,
  }
}
