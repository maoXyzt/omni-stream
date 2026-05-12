import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/// Detects whether an element's content overflows horizontally (scrollWidth >
/// clientWidth). Re-measures on element resize (ResizeObserver) and when the
/// `content` dep changes (text mutations don't fire ResizeObserver but do
/// change the React tree).
///
/// Usage:
/// ```tsx
/// const [ref, overflow] = useOverflow<HTMLDivElement>(name)
/// // <div ref={ref} className="truncate">{name}</div>
/// // {overflow && <Tooltip ... />}
/// ```
export function useOverflow<T extends HTMLElement>(
  content: unknown,
): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [overflow, setOverflow] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      setOverflow(el.scrollWidth > el.clientWidth)
    }
    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [content])

  return [ref, overflow]
}
