import { ApiError } from '@/api/client'
import type { ApiErrorBody } from '@/types/storage'

/** Structured, display-ready error detail extracted from an API response. */
export interface ErrorDetail {
  /** One-line message suitable for use as a dialog title or toast text. */
  message: string
  /** Actionable troubleshooting hint, if the server classified the error. */
  hint?: string
  /** Verbatim DuckDB error text for power users / support (convert only). */
  raw?: string
}

/**
 * Extract display-ready error detail from an unknown thrown value.
 *
 * When the server returns a structured error (ConvertFailed / QueryDiagnosed)
 * it includes `hint` and optionally `raw` in the response body, which
 * `ApiError.payload` already carries.  For older builds or unrecognised
 * errors the function degrades gracefully — `hint` and `raw` are simply
 * absent so callers can branch on their presence.
 */
export function extractErrorDetail(err: unknown): ErrorDetail {
  if (err instanceof ApiError) {
    const body = (err.payload ?? {}) as ApiErrorBody
    return {
      message: body.message ?? err.message,
      hint: body.hint,
      raw: body.raw,
    }
  }
  if (err instanceof Error) return { message: err.message }
  return { message: String(err) }
}
