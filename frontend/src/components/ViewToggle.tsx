import { LayoutGrid, List } from 'lucide-react'

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
