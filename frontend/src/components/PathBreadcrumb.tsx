import { Fragment } from 'react'
import { Home } from 'lucide-react'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

interface Props {
  prefix: string
  onNavigate: (next: string) => void
}

export function PathBreadcrumb({ prefix, onNavigate }: Props) {
  const segments = prefix.split('/').filter(Boolean)
  const crumbs = segments.map((seg, idx) => ({
    label: seg,
    path: segments.slice(0, idx + 1).join('/') + '/',
  }))

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
        {crumbs.map((c, idx) => (
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
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
