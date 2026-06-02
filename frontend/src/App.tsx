import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { FileList } from '@/components/FileList'
import { RowsPage } from '@/components/RowsPage'
import { StorageRedirect } from '@/components/StorageRedirect'
import { Toaster } from '@/components/ui/sonner'
import { useServerInfo, useStorages } from '@/hooks/use-storage'
import { pruneOrphanTreeExpanded } from '@/hooks/use-tree-expanded'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TreeExpandedJanitor />
      <Toaster />
      <BrowserRouter>
        <DocumentTitle />
        <Routes>
          <Route path="/" element={<StorageRedirect />} />
          <Route path="/s/:storage/*" element={<FileList />} />
          <Route path="/r/:storage/*" element={<RowsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

/// Keeps the tab title in sync with the active route: `<leaf> · <storage>@<host> · OmniStream`.
/// Segments are dropped when missing (no storage selected, at the storage root, server info
/// still loading) so the title never has stranded separators.
function DocumentTitle() {
  const { data } = useServerInfo()
  const { pathname } = useLocation()
  useEffect(() => {
    document.title = buildTitle(pathname, data?.hostname)
  }, [pathname, data?.hostname])
  return null
}

const ROUTE_RE = /^\/[sr]\/([^/]+)(?:\/(.*))?$/

function buildTitle(pathname: string, hostname: string | undefined): string {
  const m = pathname.match(ROUTE_RE)
  let storage: string | null = null
  let leaf: string | null = null
  if (m) {
    storage = safeDecode(m[1])
    const rest = m[2] ? safeDecode(m[2]).replace(/\/+$/, '') : ''
    if (rest) {
      const parts = rest.split('/')
      leaf = parts[parts.length - 1] || null
    }
  }
  const scope = storage && hostname ? `${storage}@${hostname}` : (storage ?? hostname ?? null)
  const head = [leaf, scope].filter(Boolean).join(' · ')
  return head ? `${head} · OmniStream` : 'OmniStream'
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/// Drops tree-expanded localStorage keys for storages no longer in the
/// server's roster. Runs once after the storages list resolves; the hook
/// itself caches forever (`staleTime: Infinity`) so the dep array gates this
/// to a single execution per page load.
function TreeExpandedJanitor() {
  const { data } = useStorages()
  useEffect(() => {
    if (!data?.storages) return
    pruneOrphanTreeExpanded(data.storages.map((s) => s.name))
  }, [data?.storages])
  return null
}

export default App
