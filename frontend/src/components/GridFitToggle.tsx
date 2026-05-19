import { Maximize2, Minimize2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { GridFit } from '@/hooks/use-grid-fit'

interface GridFitToggleProps {
  fit: GridFit
  onChange: (fit: GridFit) => void
}

/// Two-button toggle for the grid's image fit mode. Rendered next to
/// `ViewToggle` and only shown in grid view — the choice has no meaning in
/// list view. Icons: `Maximize2` reads as "fill the tile" (cover) and
/// `Minimize2` reads as "fit the image inside" (contain).
export function GridFitToggle({ fit, onChange }: GridFitToggleProps) {
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={fit === 'cover' ? 'default' : 'outline'}
            size="sm"
            aria-pressed={fit === 'cover'}
            aria-label="Fill thumbnails (cover)"
            onClick={() => onChange('cover')}
          >
            <Maximize2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Fill (crops to tile)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={fit === 'contain' ? 'default' : 'outline'}
            size="sm"
            aria-pressed={fit === 'contain'}
            aria-label="Fit thumbnails (contain)"
            onClick={() => onChange('contain')}
          >
            <Minimize2 className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Fit (shows the whole image)</TooltipContent>
      </Tooltip>
    </div>
  )
}
