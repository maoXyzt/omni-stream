// Prism-backed JSON5 highlighter for the rows-view rules editor.
//
// Why Prism instead of the highlight.js we use everywhere else: hljs has no
// dedicated JSON5 grammar — at best you can alias the stock `json` grammar
// (which handles `//` + `/* */` comments thanks to its contains modes but
// misses single-quoted strings and unquoted keys, and tags them as illegal).
// Prism's `prism-json5` is a real community-maintained JSON5 grammar that
// covers single-quoted strings, unquoted keys, and JSON5 number literals
// (hex / leading-dot / +Infinity / -Infinity / NaN).
//
// We bundle only what's needed: prism-core + prism-json (json5 extends it)
// + prism-json5. The full `prismjs` entry would also pull markup / css /
// clike / javascript — wasted bytes for our use case. No Prism theme either
// — token colors come from `highlight-json5.css`, which mirrors the
// github-dark palette already loaded for hljs.
//
// `@types/prismjs` doesn't declare the subpath modules — see
// `prism-shim.d.ts` next to this file for the ambient declarations.
import Prism from 'prismjs/components/prism-core'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-json5'
import './highlight-json5.css'

export function highlightJson5(code: string): string {
  return Prism.highlight(code, Prism.languages.json5, 'json5')
}
