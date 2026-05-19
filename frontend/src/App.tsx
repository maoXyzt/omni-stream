import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { FileList } from '@/components/FileList'
import { RowsPage } from '@/components/RowsPage'
import { StorageRedirect } from '@/components/StorageRedirect'
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
      <DocumentTitle />
      <TreeExpandedJanitor />
      <BrowserRouter>
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

/// Stamps the server's hostname into the tab title once /api/server resolves.
/// Lives at the App root so it runs exactly once regardless of routes.
function DocumentTitle() {
  const { data } = useServerInfo()
  useEffect(() => {
    if (data?.hostname) {
      document.title = `${data.hostname} | OmniStream`
    }
  }, [data?.hostname])
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
