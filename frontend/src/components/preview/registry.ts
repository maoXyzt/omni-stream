import { File as FileIcon, FileImage, FileText, FileVideo } from 'lucide-react'

import { ImagePreview } from './ImagePreview'
import { TextPreview } from './TextPreview'
import { VideoPreview } from './VideoPreview'
import type { PreviewKind, PreviewType } from './types'

// Adding a new previewable type means appending one entry here — the modal,
// FileList icons, and previewability checks all read from this list.
export const PREVIEW_TYPES: readonly PreviewType[] = [
  {
    kind: 'image',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'],
    icon: FileImage,
    Component: ImagePreview,
  },
  {
    kind: 'video',
    extensions: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'],
    icon: FileVideo,
    Component: VideoPreview,
  },
  {
    kind: 'text',
    extensions: [
      'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
      'json', 'jsonl', 'ndjson', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env',
      'sh', 'bash', 'zsh', 'fish', 'ps1',
      'py', 'rb', 'pl', 'lua', 'r',
      'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
      'html', 'htm', 'css', 'scss', 'sass', 'less',
      'rs', 'go', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'java', 'kt', 'swift',
      'php', 'cs', 'fs', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs',
      'sql', 'graphql', 'gql', 'proto',
    ],
    icon: FileText,
    Component: TextPreview,
  },
]

const EXT_TO_TYPE = new Map<string, PreviewType>()
for (const t of PREVIEW_TYPES) {
  for (const ext of t.extensions) EXT_TO_TYPE.set(ext, t)
}

export function previewTypeForKey(key: string): PreviewType | null {
  const ext = extensionOf(key)
  if (!ext) return null
  return EXT_TO_TYPE.get(ext) ?? null
}

export function previewableKind(key: string): PreviewKind | null {
  return previewTypeForKey(key)?.kind ?? null
}

export function iconForKey(key: string) {
  return previewTypeForKey(key)?.icon ?? FileIcon
}

export function getPreviewType(kind: PreviewKind): PreviewType | null {
  return PREVIEW_TYPES.find((t) => t.kind === kind) ?? null
}

function extensionOf(key: string): string | null {
  const stripped = key.replace(/\/+$/, '')
  const dot = stripped.lastIndexOf('.')
  if (dot < 0 || dot === stripped.length - 1) return null
  return stripped.slice(dot + 1).toLowerCase()
}
