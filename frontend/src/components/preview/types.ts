import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'

export type PreviewKind = 'image' | 'video' | 'text' | 'parquet' | 'csv' | 'generic'

export interface PreviewerProps {
  fileKey: string
  src: string
  storage?: string
}

export interface PreviewType {
  kind: PreviewKind
  extensions: readonly string[]
  icon: LucideIcon
  Component: ComponentType<PreviewerProps>
}
