import { apiClient } from '@/api/client'
import type { ConvertResult } from '@/types/storage'

/// Convert a JSONL/NDJSON/TSV/CSV file to Parquet in-place via the server's
/// embedded DuckDB. The server enforces its own wall-clock timeout; the
/// generous client timeout just needs to outlast that.
export async function convertToParquet(
  storage: string,
  key: string,
  overwrite = false,
): Promise<ConvertResult> {
  const { data } = await apiClient.post<ConvertResult>(
    '/api/convert',
    { storage, key, overwrite },
    { timeout: 120_000 },
  )
  return data
}
