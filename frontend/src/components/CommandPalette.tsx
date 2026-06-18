import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'

import { fuzzyRank } from '@/lib/fuzzy'
import type { CommandItem } from '@/hooks/use-command-items'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
  items: CommandItem[]
}

// Stable item id used for aria-activedescendant. Characters outside
// [A-Za-z0-9_-] are percent-encoded (like URL encoding but with 'x' prefix)
// so that different input ids always map to different DOM ids.
function optionId(id: string) {
  const sanitized = id.replace(/[^A-Za-z0-9_-]/g, (ch) => {
    const code = ch.codePointAt(0)?.toString(16) ?? '0'
    return `x${code}`
  })
  return `cp-option-${sanitized}`
}

export function CommandPalette({ open, onClose, items }: Props) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset query and selection whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  // Fuzzy-ranked flat result list.
  const results = useMemo(() => {
    return fuzzyRank(query, items, (item) =>
      item.keywords ? `${item.label} ${item.keywords}` : item.label,
    ).map((r) => r.item)
  }, [query, items])

  // Clamp activeIndex whenever results shrink (e.g. user narrows query).
  // Done in an effect to avoid calling setState during render.
  useEffect(() => {
    if (results.length === 0) {
      setActiveIndex(0)
    } else {
      setActiveIndex((i) => Math.min(i, results.length - 1))
    }
  }, [results.length])

  // Safe read of active index for rendering (never out of bounds).
  const safeIndex = results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1)

  // Group results while preserving their ranked order.
  const groups = useMemo(() => {
    const seen = new Map<string, CommandItem[]>()
    for (const item of results) {
      if (!seen.has(item.group)) seen.set(item.group, [])
      seen.get(item.group)!.push(item)
    }
    return Array.from(seen.entries()).map(([group, groupItems]) => ({
      group,
      items: groupItems,
    }))
  }, [results])

  // Scroll the active option into view.
  useEffect(() => {
    if (!open || results.length === 0) return
    const active = results[safeIndex]
    if (!active) return
    const el = listRef.current?.querySelector(`#${optionId(active.id)}`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [safeIndex, open, results])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(results.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[safeIndex]
      if (item) {
        item.perform()
        onClose()
      }
    }
  }

  const activeItem = results[safeIndex]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 sm:max-w-lg"
        aria-label="Command palette"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search…"
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            role="combobox"
            aria-expanded={open}
            aria-controls="cp-listbox"
            aria-activedescendant={activeItem ? optionId(activeItem.id) : undefined}
            autoComplete="off"
          />
        </div>

        {/* Results */}
        <div
          id="cp-listbox"
          ref={listRef}
          role="listbox"
          aria-label="Command palette results"
          className="max-h-80 overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No results
            </p>
          ) : (
            groups.map(({ group, items: groupItems }) => (
              <div key={group}>
                <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </div>
                {groupItems.map((item) => {
                  const isActive = item === activeItem
                  return (
                    <div
                      key={item.id}
                      id={optionId(item.id)}
                      role="option"
                      aria-selected={isActive}
                      className={cn(
                        'mx-1 flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm',
                        isActive
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground hover:bg-accent/50',
                      )}
                      onPointerDown={(e) => {
                        // Use pointerDown so the input doesn't lose focus on click.
                        e.preventDefault()
                        item.perform()
                        onClose()
                      }}
                      onPointerEnter={() => {
                        setActiveIndex(results.indexOf(item))
                      }}
                    >
                      <span className="min-w-0 truncate">{item.label}</span>
                      {item.hint && (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {item.hint}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
