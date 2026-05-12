import type { ReactNode } from 'react'
import {
  Copy,
  Download,
  ExternalLink,
  Link as LinkIcon,
} from 'lucide-react'

import { proxyUrl } from '@/api/storage'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import type { FileEntry } from '@/types/storage'

interface EntryContextMenuProps {
  entry: FileEntry
  storageName: string
  children: ReactNode
}

/// Right-click menu for any directory entry. Shared across grid tiles, list
/// rows, and the sidebar's folder list so users see the same actions
/// regardless of view. Folder entries get only the name/URL pair; files add
/// open-in-new-tab and download.
export function EntryContextMenu({
  entry,
  storageName,
  children,
}: EntryContextMenuProps) {
  const name = basenameOf(entry.key)

  function copyText(text: string) {
    void navigator.clipboard?.writeText(text)
  }

  function entryUrl(): string {
    // Folders → the route URL that takes the user into that directory in the
    // UI (shareable). Files → the proxy endpoint that streams the raw bytes
    // (useful for direct-preview / download links).
    if (entry.is_dir) {
      return `${window.location.origin}/s/${encodeURIComponent(
        storageName,
      )}/${entry.key}`
    }
    return (
      window.location.origin + proxyUrl(entry.key, storageName || undefined)
    )
  }

  function openInNewTab() {
    window.open(
      proxyUrl(entry.key, storageName || undefined),
      '_blank',
      'noreferrer',
    )
  }

  function downloadFile() {
    // The `download` attribute on a same-origin anchor triggers a download
    // dialog instead of rendering inline. The backend doesn't set
    // Content-Disposition so this client-side trick is the simplest cross-
    // browser approach.
    const link = document.createElement('a')
    link.href = proxyUrl(entry.key, storageName || undefined)
    link.download = name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => copyText(name)}>
          <Copy />
          Copy name
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyText(entryUrl())}>
          <LinkIcon />
          Copy URL
        </ContextMenuItem>
        {!entry.is_dir && (
          <>
            <ContextMenuItem onClick={openInNewTab}>
              <ExternalLink />
              Open in new tab
            </ContextMenuItem>
            <ContextMenuItem onClick={downloadFile}>
              <Download />
              Download
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function basenameOf(key: string): string {
  const stripped = key.replace(/\/+$/, '')
  const slash = stripped.lastIndexOf('/')
  return slash < 0 ? stripped : stripped.slice(slash + 1)
}
