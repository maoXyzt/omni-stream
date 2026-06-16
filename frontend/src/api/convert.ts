import { apiClient } from '@/api/client'
import type { ConvertAccepted, ConvertStatus } from '@/types/storage'

/**
 * Start a JSONL/NDJSON/TSV/CSV → Parquet conversion and return immediately
 * with a job id (202 Accepted).
 *
 * The conversion runs in the background on the server. Poll
 * `getConvertStatus(jobId)` (~1.5 s interval) until `state` is `"done"` or
 * `"failed"`.
 *
 * Synchronous errors (401 Unauthorized, 409 Conflict, 400 Unsupported, …) are
 * still thrown immediately so existing error-handling branches work unchanged.
 */
export async function startConvert(
  storage: string,
  key: string,
  overwrite = false,
): Promise<ConvertAccepted> {
  const { data } = await apiClient.post<ConvertAccepted>('/api/convert', {
    storage,
    key,
    overwrite,
  })
  return data
}

/**
 * Query the status of a background conversion job.
 * Returns 404 (`ApiError` with `status === 404`) if the job id is unknown or
 * has been pruned (jobs are kept for ~5 minutes after completion).
 */
export async function getConvertStatus(jobId: string): Promise<ConvertStatus> {
  const { data } = await apiClient.get<ConvertStatus>(`/api/convert/${jobId}`)
  return data
}
