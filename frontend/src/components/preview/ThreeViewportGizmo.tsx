import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useState,
  type CSSProperties,
} from 'react'
import * as THREE from 'three'
import { Box, ChevronDown } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import type { ThreeViewportView } from './ThreeViewportControls'
import {
  projectGizmo,
  type GizmoAxis,
  type GizmoAxisPoint,
  type GizmoView,
} from './three-viewport-gizmo'

export interface ThreeViewportGizmoHandle {
  updateOrientation: (quaternion: THREE.Quaternion) => void
}

interface ThreeViewportGizmoProps {
  view?: ThreeViewportView
  disabled?: boolean
  onViewChange?: (view: ThreeViewportView) => void
  className?: string
}

const viewLabels: Record<ThreeViewportView, string> = {
  front: '前视',
  back: '后视',
  left: '左视',
  right: '右视',
  top: '顶视',
  bottom: '底视',
}

const viewAriaLabels: Record<ThreeViewportView, string> = {
  front: 'Front view',
  back: 'Back view',
  left: 'Left view',
  right: 'Right view',
  top: 'Top view',
  bottom: 'Bottom view',
}

const axisColors: Record<GizmoAxis, string> = {
  x: '#fb7185',
  y: '#4ade80',
  z: '#60a5fa',
}

const viewOrder: ThreeViewportView[] = [
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
]

function pointView(point: GizmoAxisPoint): ThreeViewportView {
  if (point.axis === 'x') return point.positive ? 'right' : 'left'
  if (point.axis === 'y') return point.positive ? 'top' : 'bottom'
  return point.positive ? 'front' : 'back'
}

function pointTooltip(point: GizmoAxisPoint): string {
  const sign = point.positive ? '+' : '−'
  return `${sign}${point.axis.toUpperCase()} · ${viewLabels[pointView(point)]}`
}

function pointStyle(point: GizmoAxisPoint, size: number): CSSProperties {
  return {
    left: `calc(50% + ${point.x}px)`,
    top: `calc(50% + ${point.y}px)`,
    transform: 'translate(-50%, -50%)',
    zIndex: Math.round((point.depth + 1) * 10),
    width: size,
    height: size,
    borderColor: axisColors[point.axis],
    ...(point.positive && !point.center
      ? { backgroundColor: axisColors[point.axis], color: '#0f172a' }
      : { backgroundColor: 'transparent' }),
    ...(point.center
      ? { color: axisColors[point.axis], boxShadow: `0 0 0 2px ${axisColors[point.axis]}` }
      : {}),
  }
}

/** A compact orientation compass driven by the active camera orientation. */
export const ThreeViewportGizmo = forwardRef<ThreeViewportGizmoHandle, ThreeViewportGizmoProps>(function ThreeViewportGizmo({
  view = 'front',
  disabled = false,
  onViewChange,
  className,
}, ref) {
  const [orientation, setOrientation] = useState<THREE.Quaternion | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useImperativeHandle(ref, () => ({
    updateOrientation: (next) => {
      setOrientation((previous) => {
        if (previous && Math.abs(previous.dot(next)) > 0.999999) return previous
        return next.clone()
      })
    },
  }), [])

  const projection = useMemo(
    () => projectGizmo(orientation ?? new THREE.Quaternion(), 34),
    [orientation],
  )
  const resolvedView: GizmoView = orientation ? projection.view : view
  const label = resolvedView === 'free' ? '自由视角' : viewLabels[resolvedView]
  const ariaLabel = resolvedView === 'free' ? 'Free view' : viewAriaLabels[resolvedView]

  const selectView = (nextView: ThreeViewportView) => {
    setMenuOpen(false)
    onViewChange?.(nextView)
  }

  return (
    <div
      className={cn('pointer-events-auto relative flex w-28 flex-col items-center gap-1.5', className)}
      role="group"
      aria-label="3D orientation controls"
    >
      <div className="relative size-24" aria-label={`${ariaLabel} orientation`}>
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 96 96" aria-hidden="true">
          {projection.points.filter((point) => point.visible && !point.center).map((point) => (
            <line
              key={`${point.axis}-${point.positive}`}
              x1="48"
              y1="48"
              x2={48 + point.x}
              y2={48 + point.y}
              stroke={axisColors[point.axis]}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          ))}
        </svg>
        {projection.points.filter((point) => point.visible).map((point) => {
          const size = point.center ? 24 : point.positive ? 22 : 16
          return (
            <Tooltip key={`${point.axis}-${point.positive}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={viewAriaLabels[pointView(point)]}
                  title={pointTooltip(point)}
                  disabled={disabled}
                  onClick={() => selectView(pointView(point))}
                  className={cn(
                    'absolute flex items-center justify-center rounded-full border-2 text-[10px] font-semibold leading-none transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                    point.center && 'border-2 text-xs',
                  )}
                  style={pointStyle(point, size)}
                >
                  {point.center ? point.axis.toUpperCase() : point.label}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{pointTooltip(point)}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Current view: ${ariaLabel}`}
            title="Choose standard view"
            className="flex h-8 min-w-28 items-center gap-1.5 rounded-md border bg-background/95 px-2.5 text-[11px] font-medium shadow-lg backdrop-blur transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <Box className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span>{label}</span>
            <ChevronDown className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="min-w-32">
          <DropdownMenuItem disabled className="text-muted-foreground">自由视角</DropdownMenuItem>
          {viewOrder.map((option) => (
            <DropdownMenuItem key={option} onSelect={() => selectView(option)}>
              {viewLabels[option]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
