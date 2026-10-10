import { useMemo, type KeyboardEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** A flattened item in the model's hierarchy. */
export interface SceneTreeNode {
  id: string
  name: string
  /** Zero-based depth in the flattened hierarchy. */
  depth?: number
  visible?: boolean
  selected?: boolean
  hasChildren?: boolean
  expanded?: boolean
}

export interface ThreeSceneTreeProps {
  nodes: readonly SceneTreeNode[]
  searchQuery: string
  onSearchChange: (value: string) => void
  onSelect: (id: string) => void
  onToggleVisibility: (id: string) => void
  onShowAll: () => void
  onIsolateSelected: () => void
  onToggleExpand?: (id: string) => void
  /** Whether the tree contents are hidden behind its expand control. */
  collapsed?: boolean
  /** Toggle the scene tree between its compact and expanded states. */
  onToggleCollapse?: () => void
  showSearch?: boolean
  hasSelection?: boolean
  className?: string
}

function stopPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation()
}

function handleTreeItemKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  node: SceneTreeNode,
  onSelect: (id: string) => void,
  onToggleExpand?: (id: string) => void,
): void {
  // Let nested expand and visibility buttons handle their own activation keys.
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    onSelect(node.id)
    return
  }

  if (!node.hasChildren || !onToggleExpand) return
  if (event.key === 'ArrowRight' && !node.expanded) {
    event.preventDefault()
    onToggleExpand(node.id)
  } else if (event.key === 'ArrowLeft' && node.expanded) {
    event.preventDefault()
    onToggleExpand(node.id)
  }
}

export function ThreeSceneTree({
  nodes,
  searchQuery,
  onSearchChange,
  onSelect,
  onToggleVisibility,
  onShowAll,
  onIsolateSelected,
  onToggleExpand,
  collapsed = false,
  onToggleCollapse,
  showSearch = true,
  hasSelection: hasSelectionProp,
  className,
}: ThreeSceneTreeProps) {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const filteredNodes = useMemo(() => {
    if (!showSearch || !normalizedQuery) return nodes
    return nodes.filter((node) => node.name.toLocaleLowerCase().includes(normalizedQuery))
  }, [nodes, normalizedQuery, showSearch])

  const hasSelection = hasSelectionProp ?? nodes.some((node) => node.selected)
  const isCollapsed = collapsed === true

  return (
    <section
      className={cn(
        'flex min-h-0 w-full flex-col gap-3 rounded-md border bg-card p-3',
        isCollapsed && 'w-auto self-start p-2',
        className,
      )}
      aria-label="3D scene tree"
    >
      <div className={cn('flex items-center gap-2', isCollapsed && 'justify-center')}>
        {!isCollapsed && showSearch && (
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && searchQuery) onSearchChange('')
              }}
              placeholder="Search objects"
              aria-label="Search scene objects"
              title="Search scene objects"
              className="pl-8"
            />
          </div>
        )}
        {!isCollapsed && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={onShowAll}
                  aria-label="Show all objects"
                  title="Show all objects"
                >
                  <Eye aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Show all objects</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={onIsolateSelected}
                  disabled={!hasSelection}
                  aria-label="Isolate selected object"
                  title="Isolate selected object"
                >
                  <Layers aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Isolate selected object</TooltipContent>
            </Tooltip>
          </>
        )}
        {onToggleCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={onToggleCollapse}
                aria-label={isCollapsed ? 'Show scene tree' : 'Hide scene tree'}
                title={isCollapsed ? 'Show scene tree' : 'Hide scene tree'}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <PanelLeftOpen aria-hidden="true" />
                ) : (
                  <PanelLeftClose aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isCollapsed ? 'Show scene tree' : 'Hide scene tree'}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {!isCollapsed && (
        <div
          role="tree"
          aria-label="Scene hierarchy"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {filteredNodes.length > 0 ? (
            <div className="space-y-0.5">
              {filteredNodes.map((node) => {
                const depth = Math.max(0, Math.floor(node.depth ?? 0))
                const hasChildren = node.hasChildren === true
                const isVisible = node.visible !== false
                const isExpanded = node.expanded === true

                return (
                  <div
                    key={node.id}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-selected={node.selected === true}
                    aria-expanded={hasChildren ? isExpanded : undefined}
                    tabIndex={0}
                    onClick={() => onSelect(node.id)}
                    onKeyDown={(event) =>
                      handleTreeItemKeyDown(event, node, onSelect, onToggleExpand)
                    }
                    className={cn(
                      'group flex min-h-8 w-full items-center gap-1 rounded-md px-1 text-left text-sm outline-none transition-colors',
                      'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50',
                      node.selected && 'bg-accent text-accent-foreground',
                    )}
                    style={{ paddingLeft: `${depth * 16 + 4}px` }}
                  >
                    {hasChildren ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={(event) => {
                              stopPropagation(event)
                              onToggleExpand?.(node.id)
                            }}
                            aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                            title={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                          >
                            {isExpanded ? (
                              <ChevronDown aria-hidden="true" />
                            ) : (
                              <ChevronRight aria-hidden="true" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {isExpanded ? 'Collapse' : 'Expand'} object
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span aria-hidden="true" className="size-6 shrink-0" />
                    )}

                    <span className="min-w-0 flex-1 truncate" title={node.name}>
                      {node.name}
                    </span>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={(event) => {
                            stopPropagation(event)
                            onToggleVisibility(node.id)
                          }}
                          aria-label={isVisible ? `Hide ${node.name}` : `Show ${node.name}`}
                          title={isVisible ? `Hide ${node.name}` : `Show ${node.name}`}
                          className={cn(
                            'opacity-60 group-hover:opacity-100 group-focus-within:opacity-100',
                            !isVisible && 'text-muted-foreground opacity-100',
                          )}
                        >
                          {isVisible ? (
                            <Eye aria-hidden="true" />
                          ) : (
                            <EyeOff aria-hidden="true" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{isVisible ? 'Hide object' : 'Show object'}</TooltipContent>
                    </Tooltip>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex min-h-20 items-center justify-center px-3 py-6 text-center text-xs text-muted-foreground">
              {searchQuery.trim()
                ? `No objects match “${searchQuery.trim()}”.`
                : 'No objects in this scene.'}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
