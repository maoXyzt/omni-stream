import { LayoutGrid, List } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { ViewMode } from '@/hooks/use-view-mode'

interface ViewToggleProps {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}

export function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div className="flex items-center gap-1">
      <Button
        variant={mode === 'list' ? 'default' : 'outline'}
        size="sm"
        aria-pressed={mode === 'list'}
        aria-label="List view"
        title="List view"
        onClick={() => onChange('list')}
      >
        <List className="size-4" />
      </Button>
      <Button
        variant={mode === 'grid' ? 'default' : 'outline'}
        size="sm"
        aria-pressed={mode === 'grid'}
        aria-label="Grid view"
        title="Grid view"
        onClick={() => onChange('grid')}
      >
        <LayoutGrid className="size-4" />
      </Button>
    </div>
  )
}
