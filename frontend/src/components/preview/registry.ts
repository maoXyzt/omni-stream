import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from 'lucide-react'

import { GenericPreview } from './GenericPreview'
import { ImagePreview } from './ImagePreview'
import { ParquetPreview } from './ParquetPreview'
import { TextPreview } from './TextPreview'
import { VideoPreview } from './VideoPreview'
import type { PreviewKind, PreviewType } from './types'

// Adding a new previewable type means appending one entry here — the modal
// and previewability checks all read from this list. Icons for the file list
// come from VISUAL_GROUPS below, which is intentionally broader than this set
// (audio/archives/spreadsheets etc. have distinct icons even though they're
// not yet previewable).
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
      // `jsonl` / `ndjson` route through TextPreview too — its Range-based
      // chunked loader kicks in above 1 MiB so large log dumps don't pull
      // the whole file before anything renders.
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
  {
    kind: 'parquet',
    extensions: ['parquet', 'parq', 'pq'],
    icon: FileSpreadsheet,
    Component: ParquetPreview,
  },
  // Fallback for any file the browser can't preview inline — shows the file
  // icon + metadata, plus an iframe for PDF/similar. Has no `extensions` of
  // its own because `previewableKind` returns 'generic' as the catch-all.
  {
    kind: 'generic',
    extensions: [],
    icon: FileIcon,
    Component: GenericPreview,
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

/// Returns the preview kind for any non-empty file key. Known extensions
/// route to image / video / text; everything else falls back to 'generic'
/// (file icon + metadata + optional iframe). Returns null only for the empty
/// string, which never represents a real entry.
export function previewableKind(key: string): PreviewKind | null {
  if (!key) return null
  return previewTypeForKey(key)?.kind ?? 'generic'
}

export function getPreviewType(kind: PreviewKind): PreviewType | null {
  return PREVIEW_TYPES.find((t) => t.kind === kind) ?? null
}

// File visual = icon + Tailwind text-color class + a short human-readable
// label. Groups are broader than PREVIEW_TYPES so the file list can show
// distinct icons for things that aren't (yet) previewable: audio, archives,
// spreadsheets, PDFs, etc.
export interface FileVisual {
  Icon: LucideIcon
  color: string
  label: string
}

interface VisualGroup extends FileVisual {
  exts: readonly string[]
}

const VISUAL_GROUPS: readonly VisualGroup[] = [
  {
    Icon: FileImage,
    color: 'text-sky-500',
    label: 'Image',
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'heif'],
  },
  {
    Icon: FileVideo,
    color: 'text-purple-500',
    label: 'Video',
    exts: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv', 'avi', 'wmv', 'flv'],
  },
  {
    Icon: FileAudio,
    color: 'text-pink-500',
    label: 'Audio',
    exts: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'alac'],
  },
  {
    Icon: FileArchive,
    color: 'text-amber-600',
    label: 'Archive',
    exts: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', '7z', 'rar', 'zst', 'zstd', 'lz', 'lzma', 'z', 'cab', 'iso', 'dmg'],
  },
  // Tabular formats share an icon + color but report distinct labels:
  // "Parquet" / "CSV" / "Spreadsheet" are meaningfully different to a user
  // scanning the column, even though their visual treatment matches.
  {
    Icon: FileSpreadsheet,
    color: 'text-emerald-600',
    label: 'Parquet',
    exts: ['parquet', 'parq', 'pq'],
  },
  {
    Icon: FileSpreadsheet,
    color: 'text-emerald-600',
    label: 'CSV',
    exts: ['csv', 'tsv'],
  },
  {
    Icon: FileSpreadsheet,
    color: 'text-emerald-600',
    label: 'Spreadsheet',
    exts: ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'],
  },
  // PDFs and Office docs share `FileText` but get distinct colors so they're
  // visually separable from plain text and from each other.
  {
    Icon: FileText,
    color: 'text-red-500',
    label: 'PDF',
    exts: ['pdf'],
  },
  {
    Icon: FileText,
    color: 'text-blue-600',
    label: 'Document',
    exts: ['doc', 'docx', 'odt', 'rtf'],
  },
  {
    Icon: FileCode,
    color: 'text-cyan-600',
    label: 'Code',
    exts: [
      'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
      'py', 'rb', 'go', 'rs', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'java', 'kt', 'swift',
      'php', 'cs', 'fs', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'lua', 'r', 'pl',
      'sh', 'bash', 'zsh', 'fish', 'ps1',
      'sql', 'graphql', 'gql', 'proto', 'dart', 'm', 'mm', 'asm', 's',
      'json', 'jsonl', 'ndjson',
      'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env',
      'xml', 'plist',
      'html', 'htm', 'xhtml',
      'css', 'scss', 'sass', 'less',
    ],
  },
  {
    Icon: FileText,
    color: 'text-zinc-500',
    label: 'Text',
    exts: ['txt', 'md', 'markdown', 'log', 'rst'],
  },
]

const EXT_TO_VISUAL = new Map<string, FileVisual>()
for (const g of VISUAL_GROUPS) {
  for (const ext of g.exts) {
    EXT_TO_VISUAL.set(ext, { Icon: g.Icon, color: g.color, label: g.label })
  }
}

const DEFAULT_VISUAL: FileVisual = {
  Icon: FileIcon,
  color: 'text-muted-foreground',
  label: 'File',
}

// Folders use the lucide `Folder` icon directly at call sites; only the color
// is shared from here so list and grid stay in sync.
export const FOLDER_COLOR = 'text-amber-500'
export const FOLDER_LABEL = 'Folder'

export function fileVisual(key: string): FileVisual {
  const ext = extensionOf(key)
  if (!ext) return DEFAULT_VISUAL
  return EXT_TO_VISUAL.get(ext) ?? DEFAULT_VISUAL
}

export function iconForKey(key: string): LucideIcon {
  return fileVisual(key).Icon
}

export function colorForKey(key: string): string {
  return fileVisual(key).color
}

// Short human-readable label for the list view's Type column. Folders get
// "Folder"; known extensions get their group label ("Image", "Video",
// "Parquet", "CSV", "Code", ...); unknown extensions fall back to the
// extension itself uppercased so the user still has *something* to go on
// (e.g. ".dxf" → "DXF"). Empty or extension-less keys yield "File".
export function typeLabelForEntry(key: string, isDir: boolean): string {
  if (isDir) return FOLDER_LABEL
  const ext = extensionOf(key)
  if (!ext) return DEFAULT_VISUAL.label
  return EXT_TO_VISUAL.get(ext)?.label ?? ext.toUpperCase()
}

function extensionOf(key: string): string | null {
  const stripped = key.replace(/\/+$/, '')
  const dot = stripped.lastIndexOf('.')
  if (dot < 0 || dot === stripped.length - 1) return null
  return stripped.slice(dot + 1).toLowerCase()
}
