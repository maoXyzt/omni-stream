import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom'

import { FileList } from '@/components/FileList'
import { RowsPage } from '@/components/RowsPage'
import { StorageRedirect } from '@/components/StorageRedirect'
import { Toaster } from '@/components/ui/sonner'
import { useServerInfo, useStorages } from '@/hooks/use-storage'
import { pruneOrphanTreeExpanded } from '@/hooks/use-tree-expanded'
import { buildTitle } from '@/lib/document-title'
import { buildFaviconHref } from '@/lib/favicon'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

// The data router gives editors React Router's native navigation blocker.
// Route paths and rendered pages stay identical to the former BrowserRouter
// setup; only navigation coordination changes.
const router = createBrowserRouter([
  {
    element: <RouterShell />,
    children: [
      { path: '/', element: <StorageRedirect /> },
      { path: '/s/:storage/*', element: <FileList /> },
      { path: '/r/:storage/*', element: <RowsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TreeExpandedJanitor />
      <Toaster />
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

function RouterShell() {
  return (
    <>
      <DocumentTitle />
      <Outlet />
    </>
  )
}

/// Keeps the tab title and favicon in sync with the active route via
/// `buildTitle` / `buildFaviconHref`. Sits inside the router so it can
/// read the current pathname. The favicon swap reuses the existing
/// `<link rel="icon">` from index.html — replacing the href rather than
/// adding/removing nodes avoids racing the browser's first-paint icon load.
function DocumentTitle() {
  const { data: server } = useServerInfo()
  const { data: storages } = useStorages()
  const { pathname } = useLocation()
  useEffect(() => {
    document.title = buildTitle(pathname, server?.hostname)
  }, [pathname, server?.hostname])
  useEffect(() => {
    const href = buildFaviconHref(pathname, storages?.storages)
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link && link.getAttribute('href') !== href) link.setAttribute('href', href)
  }, [pathname, storages?.storages])
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
