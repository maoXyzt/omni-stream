import { Fragment } from 'react'
import { Home } from 'lucide-react'

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface Props {
  prefix: string
  onNavigate: (next: string) => void
}

// When there are more than this many crumbs (excluding root), collapse the
// middle ones into a "…" dropdown so the toolbar doesn't overflow on deep
// paths. The first and last crumbs are always kept visible.
const COLLAPSE_THRESHOLD = 4

export function PathBreadcrumb({ prefix, onNavigate }: Props) {
  const segments = prefix.split('/').filter(Boolean)
  const crumbs = segments.map((seg, idx) => ({
    label: seg,
    path: segments.slice(0, idx + 1).join('/') + '/',
  }))

  const shouldCollapse = crumbs.length > COLLAPSE_THRESHOLD

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {crumbs.length === 0 ? (
            <BreadcrumbPage className="flex items-center gap-1">
              <Home className="size-4" />
              <span>Root</span>
            </BreadcrumbPage>
          ) : (
            <BreadcrumbLink
              onClick={() => onNavigate('')}
              className="flex cursor-pointer items-center gap-1"
            >
              <Home className="size-4" />
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>

        {shouldCollapse ? (
          <CollapsedCrumbs crumbs={crumbs} onNavigate={onNavigate} />
        ) : (
          crumbs.map((c, idx) => (
            <Fragment key={c.path}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {idx === crumbs.length - 1 ? (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    onClick={() => onNavigate(c.path)}
                    className="cursor-pointer"
                  >
                    {c.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

// ---------------------------------------------------------------------------
// Collapsed breadcrumb layout
// ---------------------------------------------------------------------------
//
// Shows: Root > first-crumb > … > last-crumb
// The ellipsis opens a dropdown listing all hidden middle segments.
// Always renders at least first + last visible so there are meaningful
// anchors on both ends of the path.

interface CollapsedCrumbsProps {
  crumbs: Array<{ label: string; path: string }>
  onNavigate: (path: string) => void
}

function CollapsedCrumbs({ crumbs, onNavigate }: CollapsedCrumbsProps) {
  const first = crumbs[0]
  const last = crumbs[crumbs.length - 1]
  // Everything between first and last goes into the dropdown.
  const hidden = crumbs.slice(1, crumbs.length - 1)

  return (
    <>
      {/* First crumb — always visible */}
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbLink
          onClick={() => onNavigate(first.path)}
          className="cursor-pointer"
        >
          {first.label}
        </BreadcrumbLink>
      </BreadcrumbItem>

      {/* Ellipsis dropdown for hidden ancestors */}
      {hidden.length > 0 && (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex cursor-pointer items-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="Show hidden folders"
              >
                <BreadcrumbEllipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {hidden.map((c) => (
                  <DropdownMenuItem
                    key={c.path}
                    onClick={() => onNavigate(c.path)}
                    className="cursor-pointer"
                  >
                    {c.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </BreadcrumbItem>
        </>
      )}

      {/* Last crumb — current page */}
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>{last.label}</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  )
}
