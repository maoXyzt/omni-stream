import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import LZString from 'lz-string'

const URL_PARAM = 'rows'

export type Rule =
  | { column: string; kind: 'text'; label?: string }
  | { column: string; kind: 'image'; label?: string; pathPrefix?: string }

export interface RowsViewConfig {
  rules: Rule[]
  /// Non-null when the URL contained a `rows=` param that couldn't be
  /// decompressed or didn't match the expected shape. The Rows tab surfaces
  /// this so a corrupted shared link doesn't silently look "empty".
  decodeError: string | null
  setRules: (next: Rule[]) => void
  clear: () => void
  /// True when the URL currently carries a `rows=` param. Lets the parent
  /// pre-select the Rows tab on shared links.
  hasUrlConfig: boolean
}

export function useRowsViewConfig(): RowsViewConfig {
  const [searchParams, setSearchParams] = useSearchParams()
  const raw = searchParams.get(URL_PARAM)

  const { rules, decodeError } = useMemo(() => decode(raw), [raw])

  const setRules = useCallback(
    (next: Rule[]) => {
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

function decode(raw: string | null): { rules: Rule[]; decodeError: string | null } {
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
  const validation = validateRules(parsed)
  if (validation.error) return { rules: [], decodeError: validation.error }
  return { rules: validation.rules, decodeError: null }
}

/// Validate an `unknown` into a typed `Rule[]`. Returns either parsed rules
/// or a human-readable error pointing at which rule failed and why. Used both
/// for URL decoding and for the Save button in the editor dialog.
export function validateRules(
  input: unknown,
): { rules: Rule[]; error: null } | { rules: never[]; error: string } {
  if (!Array.isArray(input)) {
    return { rules: [], error: 'expected an array of rules' }
  }
  const out: Rule[] = []
  for (let i = 0; i < input.length; i++) {
    const r = input[i] as Record<string, unknown> | null
    if (!r || typeof r !== 'object') {
      return { rules: [], error: `rule #${i + 1}: expected an object` }
    }
    if (typeof r.column !== 'string' || r.column.length === 0) {
      return { rules: [], error: `rule #${i + 1}: "column" must be a non-empty string` }
    }
    if (r.kind !== 'text' && r.kind !== 'image') {
      return {
        rules: [],
        error: `rule #${i + 1}: "kind" must be "text" or "image"`,
      }
    }
    if (r.label !== undefined && typeof r.label !== 'string') {
      return { rules: [], error: `rule #${i + 1}: "label" must be a string when present` }
    }
    if (r.kind === 'image') {
      if (r.pathPrefix !== undefined && typeof r.pathPrefix !== 'string') {
        return {
          rules: [],
          error: `rule #${i + 1}: "pathPrefix" must be a string when present`,
        }
      }
      out.push({
        column: r.column,
        kind: 'image',
        label: r.label as string | undefined,
        pathPrefix: r.pathPrefix as string | undefined,
      })
    } else {
      out.push({
        column: r.column,
        kind: 'text',
        label: r.label as string | undefined,
      })
    }
  }
  return { rules: out, error: null }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
