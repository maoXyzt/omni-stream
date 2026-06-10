import { apiClient } from '@/api/client'
import type { QueryResult } from '@/types/storage'

/// Execute one SQL statement against a storage via the server's embedded
/// DuckDB. The server enforces its own wall-clock timeout and interrupts the
/// query past it; the generous client timeout just needs to outlast that
/// (default global timeout is 30s — same as the server's default limit,
/// which operators may raise).
export async function executeQuery(
  sql: string,
  storage: string,
): Promise<QueryResult> {
  const { data } = await apiClient.post<QueryResult>(
    '/api/query',
    { sql, storage },
    { timeout: 120_000 },
  )
  return data
}
