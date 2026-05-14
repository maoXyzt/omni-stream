import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import LZString from 'lz-string'

import { type Node, parseRules } from '@/lib/rows-schema'

const URL_PARAM = 'rows'

export interface RowsViewConfig {
  rules: Node[]
  /// Non-null when the URL contained a `rows=` param that couldn't be
  /// decompressed or didn't pass schema validation. The Rows page surfaces
  /// this so a corrupted shared link doesn't silently look "empty".
  decodeError: string | null
  setRules: (next: Node[]) => void
  clear: () => void
  /// True when the URL currently carries a `rows=` param.
  hasUrlConfig: boolean
}

export function useRowsViewConfig(): RowsViewConfig {
  const [searchParams, setSearchParams] = useSearchParams()
  const raw = searchParams.get(URL_PARAM)

  const { rules, decodeError } = useMemo(() => decode(raw), [raw])

  const setRules = useCallback(
    (next: Node[]) => {
      const encoded = LZString.compressToEncodedURIComponent(JSON.stringify(next))
      setSearchParams(
        (sp) => {
          const params = new URLSearchParams(sp)
          if (next.length === 0) {
            params.delete(URL_PARAM)
          } else {
            params.set(URL_PARAM, encoded)
          }
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const clear = useCallback(() => {
    setSearchParams(
      (sp) => {
        const params = new URLSearchParams(sp)
        params.delete(URL_PARAM)
        return params
      },
      { replace: true },
    )
  }, [setSearchParams])

  return {
    rules,
    decodeError,
    setRules,
    clear,
    hasUrlConfig: raw !== null && raw !== '',
  }
}

function decode(raw: string | null): { rules: Node[]; decodeError: string | null } {
  if (!raw) return { rules: [], decodeError: null }
  let json: string | null
  try {
    json = LZString.decompressFromEncodedURIComponent(raw)
  } catch (err) {
    return { rules: [], decodeError: `failed to decompress: ${describe(err)}` }
  }
  if (!json) return { rules: [], decodeError: 'config in URL is empty or corrupted' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    return { rules: [], decodeError: `invalid JSON: ${describe(err)}` }
  }
  const result = parseRules(parsed)
  if (result.error) return { rules: [], decodeError: result.error }
  return { rules: result.rules, decodeError: null }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
