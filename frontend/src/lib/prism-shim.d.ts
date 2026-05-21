// Subpath imports for `prismjs` aren't typed by `@types/prismjs` — it only
// covers the main entry. We import via subpaths in `highlight-json5.ts` to
// stay tree-shake-friendly, so shim the missing declarations here. The core
// export is the same shape as the main `prismjs` namespace; the language
// modules are side-effect imports that mutate `Prism.languages`.
declare module 'prismjs/components/prism-core' {
  import type * as Prism from 'prismjs'
  const core: typeof Prism
  export default core
}
declare module 'prismjs/components/prism-json'
declare module 'prismjs/components/prism-json5'
