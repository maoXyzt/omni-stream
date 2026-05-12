import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2 } from 'lucide-react'

import { apiClient, ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import {
  SUPPORTED_LANGUAGES,
  detectLanguage,
  ensureLanguage,
  highlight,
  isLanguageBundled,
} from '@/lib/highlight'

import type { PreviewerProps } from './types'

export function TextPreview({ fileKey, src, storage }: PreviewerProps) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['text-preview', storage ?? null, fileKey] as const,
    queryFn: async () => {
      const res = await apiClient.get<string>(src, {
        responseType: 'text',
        // Override the global JSON Accept so the proxy returns the raw body.
        headers: { Accept: 'text/plain, */*' },
        transformResponse: [(value) => value],
      })
      return res.data
    },
    staleTime: 60_000,
  })

  // Initial language from the file extension; the dropdown can override.
  // useMemo so re-renders don't reset the user's manual choice.
  const initialLang = useMemo(() => detectLanguage(fileKey), [fileKey])
  const [lang, setLang] = useState(initialLang)
  const [ready, setReady] = useState(() => isLanguageBundled(initialLang) || initialLang === 'plaintext')

  // Load the grammar if it isn't bundled. `cancelled` guards against races
  // when the user rapid-flips the dropdown.
  useEffect(() => {
    if (lang === 'plaintext' || isLanguageBundled(lang)) {
      setReady(true)
      return
    }
    setReady(false)
    let cancelled = false
    ensureLanguage(lang).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [lang])

  const highlighted = useMemo(() => {
    if (!data || !ready) return null
    return highlight(data, lang)
  }, [data, lang, ready])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-muted/30">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background/50 px-3 py-2">
        <span className="truncate text-xs text-muted-foreground">
          {lang === 'plaintext' ? 'No syntax highlighting' : `Language: ${lang}`}
        </span>
        <div className="flex items-center gap-2">
          {!ready && lang !== 'plaintext' && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          )}
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Syntax highlighting language"
          >
            {SUPPORTED_LANGUAGES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {isPending && (
          <div className="flex w-full flex-col gap-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
        {isError && (
          <div className="w-full p-3">
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Failed to load text</AlertTitle>
              <AlertDescription>
                {error instanceof ApiError
                  ? `${error.status} — ${error.message}`
                  : error instanceof Error
                    ? error.message
                    : 'Unknown error.'}
              </AlertDescription>
            </Alert>
          </div>
        )}
        {data !== undefined && (
          <pre className="hljs h-full w-full overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            {highlighted !== null ? (
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <code>{data}</code>
            )}
          </pre>
        )}
      </div>
    </div>
  )
}
