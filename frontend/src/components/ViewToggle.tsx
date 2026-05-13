import { LayoutGrid, LayoutPanelLeft, List } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { ViewMode } from '@/hooks/use-view-mode'

interface ViewToggleProps {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}

export function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div className="flex items-center gap-1">
      {/* Gallery view splits the main pane into a narrow file list + inline
          preview. Below `md` there isn't horizontal room for both, so the
          toggle is hidden and FileList falls back to list rendering even if
          this mode is the persisted preference. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={mode === 'gallery' ? 'default' : 'outline'}
            size="sm"
            aria-pressed={mode === 'gallery'}
            aria-label="Gallery view"
            onClick={() => onChange('gallery')}
            className="hidden md:inline-flex"
          >
            <LayoutPanelLeft className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Gallery view</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={mode === 'list' ? 'default' : 'outline'}
            size="sm"
            aria-pressed={mode === 'list'}
            aria-label="List view"
            onClick={() => onChange('list')}
          >
            <List className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>List view</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={mode === 'grid' ? 'default' : 'outline'}
            size="sm"
            aria-pressed={mode === 'grid'}
            aria-label="Grid view"
            onClick={() => onChange('grid')}
          >
            <LayoutGrid className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Grid view</TooltipContent>
      </Tooltip>
    </div>
  )
}
