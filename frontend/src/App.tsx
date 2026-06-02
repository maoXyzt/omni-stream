import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { FileList } from '@/components/FileList'
import { RowsPage } from '@/components/RowsPage'
import { StorageRedirect } from '@/components/StorageRedirect'
import { Toaster } from '@/components/ui/sonner'
import { useServerInfo, useStorages } from '@/hooks/use-storage'
import { pruneOrphanTreeExpanded } from '@/hooks/use-tree-expanded'
import { buildTitle } from '@/lib/document-title'

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

/// Keeps the tab title in sync with the active route via `buildTitle`.
/// Sits inside BrowserRouter so it can read the current pathname.
function DocumentTitle() {
  const { data } = useServerInfo()
  const { pathname } = useLocation()
  useEffect(() => {
    document.title = buildTitle(pathname, data?.hostname)
  }, [pathname, data?.hostname])
  return null
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
