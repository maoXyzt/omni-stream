import type { ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Axis3D,
  Box,
  Focus,
  Grid3X3,
  Layers,
  Maximize2,
  MousePointer2,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  RotateCcw,
  ScanLine,
  Search,
  Square,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type ThreeViewportView =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'

export type ThreeViewportProjection = 'perspective' | 'orthographic'

export type ThreeViewportDisplayMode = 'solid' | 'wireframe' | 'transparent'

export interface ThreeViewportControlsProps {
  /** Currently selected camera projection. */
  projection?: ThreeViewportProjection
  /** Currently selected material display mode. */
  displayMode?: ThreeViewportDisplayMode
  /** Whether the scene grid is visible. */
  showGrid?: boolean
  /** Whether the scene axes are visible. */
  showAxes?: boolean
  /** Controlled model-part search value. */
  searchQuery?: string
  /** Optional replacement for the default interaction hint text. */
  interactionHint?: ReactNode
  className?: string
  disabled?: boolean
  onFitToView?: () => void
  onResetView?: () => void
  onViewChange?: (view: ThreeViewportView) => void
  onProjectionChange?: (projection: ThreeViewportProjection) => void
  onDisplayModeChange?: (mode: ThreeViewportDisplayMode) => void
  onGridVisibilityChange?: (visible: boolean) => void
  onAxesVisibilityChange?: (visible: boolean) => void
  onSearchQueryChange?: (query: string) => void
}

interface ControlButtonProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  variant?: 'default' | 'outline' | 'secondary' | 'ghost'
}

function ControlButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  pressed,
  variant = pressed ? 'default' : 'outline',
}: ControlButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant={variant}
          aria-label={label}
          aria-pressed={pressed}
          title={label}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon className="size-4" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

interface ViewButtonDefinition {
  view: ThreeViewportView
  label: string
  icon: LucideIcon
}

const standardViews: ViewButtonDefinition[] = [
  { view: 'front', label: 'Front view', icon: PanelTop },
  { view: 'back', label: 'Back view', icon: PanelBottom },
  { view: 'left', label: 'Left view', icon: PanelLeft },
  { view: 'right', label: 'Right view', icon: PanelRight },
  { view: 'top', label: 'Top view', icon: ArrowUp },
  { view: 'bottom', label: 'Bottom view', icon: ArrowDown },
]

/**
 * Presentational controls for a 3D preview. ThreeViewport owns the camera,
 * scene, and materials; this component only renders controls and emits the
 * requested action through callbacks.
 */
export function ThreeViewportControls({
  projection = 'perspective',
  displayMode = 'solid',
  showGrid = true,
  showAxes = true,
  searchQuery,
  interactionHint,
  className,
  disabled = false,
  onFitToView,
  onResetView,
  onViewChange,
  onProjectionChange,
  onDisplayModeChange,
  onGridVisibilityChange,
  onAxesVisibilityChange,
  onSearchQueryChange,
}: ThreeViewportControlsProps) {
  return (
    <div
      className={cn(
        'flex w-full flex-col gap-2 rounded-md border bg-background/95 p-2 shadow-sm backdrop-blur',
        className,
      )}
      role="region"
      aria-label="3D preview controls"
    >
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="3D view toolbar">
        <ControlButton
          icon={Maximize2}
          label="Fit model to view"
          disabled={disabled}
          onClick={() => onFitToView?.()}
        />
        <ControlButton
          icon={RotateCcw}
          label="Reset view"
          disabled={disabled}
          onClick={() => onResetView?.()}
        />

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

        <div className="flex items-center gap-1" role="group" aria-label="Standard views">
          {standardViews.map(({ view, label, icon }) => (
            <ControlButton
              key={view}
              icon={icon}
              label={label}
              disabled={disabled}
              onClick={() => onViewChange?.(view)}
            />
          ))}
        </div>

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

        <div className="flex items-center gap-1" role="group" aria-label="Projection">
          <ControlButton
            icon={Box}
            label="Perspective projection"
            pressed={projection === 'perspective'}
            disabled={disabled}
            onClick={() => onProjectionChange?.('perspective')}
          />
          <ControlButton
            icon={Square}
            label="Orthographic projection"
            pressed={projection === 'orthographic'}
            disabled={disabled}
            onClick={() => onProjectionChange?.('orthographic')}
          />
        </div>

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

        <div className="flex items-center gap-1" role="group" aria-label="Display mode">
          <ControlButton
            icon={Box}
            label="Solid display"
            pressed={displayMode === 'solid'}
            disabled={disabled}
            onClick={() => onDisplayModeChange?.('solid')}
          />
          <ControlButton
            icon={ScanLine}
            label="Wireframe display"
            pressed={displayMode === 'wireframe'}
            disabled={disabled}
            onClick={() => onDisplayModeChange?.('wireframe')}
          />
          <ControlButton
            icon={Layers}
            label="Transparent display"
            pressed={displayMode === 'transparent'}
            disabled={disabled}
            onClick={() => onDisplayModeChange?.('transparent')}
          />
        </div>

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

        <div className="flex items-center gap-1" role="group" aria-label="Scene helpers">
          <ControlButton
            icon={Grid3X3}
            label={showGrid ? 'Hide grid' : 'Show grid'}
            pressed={showGrid}
            disabled={disabled}
            onClick={() => onGridVisibilityChange?.(!showGrid)}
          />
          <ControlButton
            icon={Axis3D}
            label={showAxes ? 'Hide axes' : 'Show axes'}
            pressed={showAxes}
            disabled={disabled}
            onClick={() => onAxesVisibilityChange?.(!showAxes)}
          />
        </div>
      </div>

      <div className="flex min-w-48 max-w-sm items-center gap-2">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          value={searchQuery}
          placeholder="Search model parts"
          aria-label="Search model parts"
          title="Search model parts"
          disabled={disabled}
          onChange={(event) => onSearchQueryChange?.(event.target.value)}
        />
      </div>

      <div
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        role="note"
        aria-label="3D interaction hints"
      >
        <Focus className="size-3.5 shrink-0" aria-hidden="true" />
        {interactionHint ?? (
          <span>
            <MousePointer2 className="mr-1 inline size-3.5" aria-hidden="true" />
            Drag to rotate · right-click drag to pan · scroll to zoom · double-click to focus
          </span>
        )}
      </div>
    </div>
  )
}
