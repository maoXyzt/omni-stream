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
  /// Attach to the drag-handle's `onPointerDown`. Pointer-move listeners are
  /// attached to `window` for the duration of the drag so the cursor can
  /// leave the handle without dropping the gesture.
  startResize: (e: ReactPointerEvent) => void
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

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      // Skip secondary buttons — only left mouse / primary touch should drag.
      if (e.button !== 0) return
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startWidth: width }

      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d) return
        const next = Math.min(
          Math.max(d.startWidth + (ev.clientX - d.startX), minPx),
          maxPx,
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

  return { width, startResize }
}
