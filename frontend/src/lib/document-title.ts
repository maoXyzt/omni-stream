/// Build the tab title from the active route + server hostname:
/// `<storage>/<bucket-or-context> · <leaf> · <host> · OmniStream`. Segments
/// missing for the current state (no storage selected, at the storage root,
/// /api/server still loading) are dropped so the title never has stranded
/// separators.
///
/// Route prefixes are kept in sync with `<Routes>` in `App.tsx` — extend
/// the character class in ROUTE_RE when adding new storage-scoped routes.
const ROUTE_RE = /^\/[sr]\/([^/]+)(?:\/(.*))?$/

export function buildTitle(pathname: string, hostname: string | undefined): string {
  const m = pathname.match(ROUTE_RE)
  let storage: string | null = null
  let context: string | null = null
  let leaf: string | null = null
  if (m) {
    storage = safeDecode(m[1])
    const rest = m[2] ? safeDecode(m[2]).replace(/\/+$/, '') : ''
    if (rest) {
      const parts = rest.split('/')
      const first = parts[0] || null
      context = first ? `${storage}/${first}` : storage
      leaf = parts.length > 1 ? (parts[parts.length - 1] || null) : null
    }
  }
  const shortHost = shortenHost(hostname)
  const head = context
    ? [context, leaf, shortHost].filter(Boolean).join(' · ')
    : [storage && shortHost ? `${storage}@${shortHost}` : (storage ?? shortHost ?? null)]
        .filter(Boolean)
        .join(' · ')
  return head ? `${head} · OmniStream` : 'OmniStream'
}

/// Trim FQDNs to the first label so `dev.internal.corp.example.com` doesn't
/// dominate the tab title. Same-DNS-domain machines are still distinguishable
/// by the leading label. IP literals are kept verbatim — splitting `192.168.1.100`
/// on `.` would otherwise leave just `192`, dropping the only useful context.
const IPV4_RE = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/

function shortenHost(hostname: string | undefined): string | null {
  if (!hostname) return null
  if (IPV4_RE.test(hostname)) return hostname
  if (hostname.includes(':')) return hostname
  const first = hostname.split('.')[0]
  return first || hostname
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
