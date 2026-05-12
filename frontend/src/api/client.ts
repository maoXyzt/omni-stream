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

const TOKEN_STORAGE_KEY = 'omni-stream:auth-token'

export function getStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    // localStorage is unavailable in some sandboxed contexts; treat as no token.
    return null
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  } catch {
    // ignore: storage write may fail in private mode / disabled cookies
  }
}

// Same-origin requests; the Rust backend serves both the SPA and /api/*.
// During `pnpm dev`, vite.config.ts proxies /api to OMNI_BACKEND_URL.
export const apiClient = axios.create({
  baseURL: '',
  timeout: 30_000,
  headers: { Accept: 'application/json' },
})

apiClient.interceptors.request.use((config) => {
  const token = getStoredToken()
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`)
  }
  return config
})

apiClient.interceptors.response.use(
  (res) => res,
  (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status ?? 0
    // A stale token must be discarded so the next request prompts for re-entry.
    if (status === 401) {
      setStoredToken(null)
    }
    const message =
      error.response?.data?.message ??
      error.response?.statusText ??
      error.message ??
      'request failed'
    return Promise.reject(new ApiError(status, message, error.response?.data))
  },
)
