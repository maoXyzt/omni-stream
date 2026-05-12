import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { FileList } from '@/components/FileList'
import { StorageRedirect } from '@/components/StorageRedirect'
import { useServerInfo } from '@/hooks/use-storage'

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
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<StorageRedirect />} />
          <Route path="/s/:storage/*" element={<FileList />} />
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

export default App
