import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

interface Options {
  /// Used to build the localStorage key (`omni-stream:resize:<key>`). Pick
  /// something stable per resizable element so different panels persist
  /// independently.
  key: string
  defaultPx: number
  minPx: number
  maxPx: number
}

interface Result {
  width: number
  minWidth: number
  maxWidth: number
  /// Attach to the drag-handle's `onPointerDown`. Pointer-move listeners are
  /// attached to `window`; `maxOverride` can temporarily preserve space for
  /// a sibling pane without overwriting the persisted preferred width.
  startResize: (e: ReactPointerEvent, maxOverride?: number) => void
  resizeTo: (width: number) => void
}

export function getKeyboardResizeWidth(
  key: string,
  value: number,
  min: number,
  max: number,
): number | null {
  if (key === 'ArrowLeft') return Math.max(min, value - 16)
  if (key === 'ArrowRight') return Math.min(max, value + 16)
  if (key === 'Home') return min
  if (key === 'End') return max
  return null
}

export function getResizeDragMax(
  configuredMax: number,
  maxOverride?: number,
): number {
  return Math.min(maxOverride ?? configuredMax, configuredMax)
}

/// Draggable width with localStorage persistence. The drag deltas are applied
/// in CSS pixels — caller is responsible for using the returned `width` as
/// `style={{ width }}` and reserving horizontal space for the handle itself.
export function useResizableWidth({
  key,
  defaultPx,
  minPx,
  maxPx,
}: Options): Result {
  const storageKey = `omni-stream:resize:${key}`
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = window.localStorage.getItem(storageKey)
      if (v !== null) {
        const n = Number(v)
        if (Number.isFinite(n)) {
          return Math.min(Math.max(n, minPx), maxPx)
        }
      }
    } catch {
      // localStorage unavailable; fall through to default.
    }
    return defaultPx
  })

  // Persist on change, debounced via React's batching (each `setWidth` during
  // a drag triggers a render which writes the latest value).
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width))
    } catch {
      // Ignore quota / availability errors.
    }
  }, [storageKey, width])

  // Use refs inside the move handler so a single drag isn't restarted by the
  // re-renders that each setWidth triggers.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const resizeTo = useCallback(
    (next: number) => setWidth(Math.min(Math.max(next, minPx), maxPx)),
    [minPx, maxPx],
  )

  const startResize = useCallback(
    (e: ReactPointerEvent, maxOverride?: number) => {
      // Skip secondary buttons — only left mouse / primary touch should drag.
      if (e.button !== 0) return
      e.preventDefault()
      const dragMax = getResizeDragMax(maxPx, maxOverride)
      dragRef.current = {
        startX: e.clientX,
        startWidth: Math.min(width, dragMax),
      }

      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d) return
        const next = Math.min(
          Math.max(d.startWidth + (ev.clientX - d.startX), minPx),
          dragMax,
        )
        setWidth(next)
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      // Suppress text-selection and lock the cursor for the whole drag so the
      // pointer can leave the handle without flickering between cursors.
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [width, minPx, maxPx],
  )

  return {
    width,
    minWidth: minPx,
    maxWidth: maxPx,
    startResize,
    resizeTo,
  }
}
