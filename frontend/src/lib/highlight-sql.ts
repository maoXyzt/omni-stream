// Prism-backed SQL highlighter for the SQL query page editor. Same
// bundle-only-what's-needed approach as `highlight-json5.ts`: prism-core +
// the sql grammar, no theme file — token colors live in `highlight-sql.css`,
// mirroring the github-dark palette used everywhere else.
//
// `@types/prismjs` doesn't declare the subpath modules — see
// `prism-shim.d.ts` for the ambient declarations.
import Prism from 'prismjs/components/prism-core'
import 'prismjs/components/prism-sql'
import './highlight-sql.css'

export function highlightSql(code: string): string {
  return Prism.highlight(code, Prism.languages.sql, 'sql')
}
