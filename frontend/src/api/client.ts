import axios, { AxiosError } from 'axios'

import type { ApiErrorBody } from '@/types/storage'

export class ApiError extends Error {
  status: number
  payload?: unknown

  constructor(status: number, message: string, payload?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }

  get isNotFound(): boolean {
    return this.status === 404
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403
  }
}

// Same-origin requests; the Rust backend serves both the SPA and /api/*.
// During `pnpm dev`, vite.config.ts proxies /api to 127.0.0.1:8080.
export const apiClient = axios.create({
  baseURL: '',
  timeout: 30_000,
  headers: { Accept: 'application/json' },
})

apiClient.interceptors.response.use(
  (res) => res,
  (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status ?? 0
    const message =
      error.response?.data?.message ??
      error.response?.statusText ??
      error.message ??
      'request failed'
    return Promise.reject(new ApiError(status, message, error.response?.data))
  },
)
