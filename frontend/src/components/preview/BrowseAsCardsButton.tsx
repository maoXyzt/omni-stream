import { LayoutList } from 'lucide-react'

import { Button } from '@/components/ui/button'

interface BrowseAsCardsButtonProps {
  onClick: () => void
  disabled?: boolean
}

export function BrowseAsCardsButton({ onClick, disabled }: BrowseAsCardsButtonProps) {
  return (
    <Button type="button" size="sm" onClick={onClick} disabled={disabled} className="shadow-sm">
      <LayoutList className="size-4" />
      Browse as cards
    </Button>
  )
}
