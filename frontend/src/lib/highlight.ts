import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'

import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini'

import 'highlight.js/styles/github-dark.css'

// Eagerly bundled languages — load instantly, no network. The set is
// intentionally small: the most common config/script formats.
// `ini` doubles as TOML — they're syntactically close enough that the visual
// result is acceptable until highlight.js ships a real TOML grammar.
// `json5` reuses the stock JSON grammar so `{ "highlight": "field", "lang":
// "json5" }` in rules widgets gives the user *some* highlighting (comments
// work; single-quoted strings / unquoted keys stay uncolored under
// `ignoreIllegals: true` rather than break the output). The rows-view rules
// editor itself goes through Prism (see `lib/highlight-json5.ts`) for proper
// JSON5 tokenization.
hljs.registerLanguage('json', json)
hljs.registerLanguage('json5', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('ini', ini)

const BUNDLED = new Set(['json', 'json5', 'python', 'yaml', 'ini'])
const loaded = new Set<string>(BUNDLED)

/// Dynamic loaders for non-bundled languages. Vite turns each `import()` into
/// a separate chunk, so the user only fetches the grammar they actually pick.
/// We list them explicitly (instead of `import(`.../${name}.js`)`) so that
/// Vite's static analyser can generate predictable chunk filenames and so the
/// production build doesn't try to bundle every single grammar in node_modules.
const LAZY: Record<string, () => Promise<{ default: LanguageFn }>> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  swift: () => import('highlight.js/lib/languages/swift'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  php: () => import('highlight.js/lib/languages/php'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  perl: () => import('highlight.js/lib/languages/perl'),
  lua: () => import('highlight.js/lib/languages/lua'),
  r: () => import('highlight.js/lib/languages/r'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  sql: () => import('highlight.js/lib/languages/sql'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  scala: () => import('highlight.js/lib/languages/scala'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
}

export interface LanguageOption {
  readonly value: string
  readonly label: string
}

export const SUPPORTED_LANGUAGES: readonly LanguageOption[] = [
  { value: 'plaintext', label: 'Plain text' },
  { value: 'json', label: 'JSON' },
  { value: 'json5', label: 'JSON5' },
  { value: 'python', label: 'Python' },
  { value: 'yaml', label: 'YAML' },
  { value: 'ini', label: 'INI / TOML' },
  { value: 'bash', label: 'Bash / shell' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'xml', label: 'HTML / XML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS / Sass' },
  { value: 'less', label: 'Less' },
  { value: 'rust', label: 'Rust' },
  { value: 'go', label: 'Go' },
  { value: 'cpp', label: 'C / C++' },
  { value: 'java', label: 'Java' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'swift', label: 'Swift' },
  { value: 'csharp', label: 'C#' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'perl', label: 'Perl' },
  { value: 'lua', label: 'Lua' },
  { value: 'r', label: 'R' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'sql', label: 'SQL' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'protobuf', label: 'Protobuf' },
  { value: 'scala', label: 'Scala' },
  { value: 'clojure', label: 'Clojure' },
  { value: 'elixir', label: 'Elixir' },
  { value: 'haskell', label: 'Haskell' },
]

const EXT_TO_LANG: Record<string, string> = {
  // Bundled
  json: 'json', jsonl: 'json', ndjson: 'json',
  json5: 'json5',
  py: 'python', pyw: 'python',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini',
  // Dynamic
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml',
  vue: 'xml', svelte: 'xml',
  css: 'css',
  scss: 'scss', sass: 'scss',
  less: 'less',
  rs: 'rust',
  go: 'go',
  c: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  md: 'markdown', markdown: 'markdown', rst: 'markdown',
  sql: 'sql',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf',
  scala: 'scala',
  clj: 'clojure',
  ex: 'elixir', exs: 'elixir',
  hs: 'haskell',
}

export function detectLanguage(fileKey: string): string {
  const stripped = fileKey.replace(/\/+$/, '')
  const dot = stripped.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  const ext = stripped.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext] ?? 'plaintext'
}

export function isLanguageBundled(name: string): boolean {
  return BUNDLED.has(name)
}

/// Loads a language grammar if it isn't registered yet. Idempotent — repeat
/// calls for an already-loaded language are a no-op. Returns true on success.
/// Failures are logged and return false so the caller can fall back to plain.
export async function ensureLanguage(name: string): Promise<boolean> {
  if (name === 'plaintext' || loaded.has(name)) return true
  const loader = LAZY[name]
  if (!loader) {
    console.warn(`unknown highlight.js language: ${name}`)
    return false
  }
  try {
    const mod = await loader()
    hljs.registerLanguage(name, mod.default)
    loaded.add(name)
    return true
  } catch (e) {
    console.warn(`failed to load highlight.js language: ${name}`, e)
    return false
  }
}

export function highlight(text: string, language: string): string {
  if (language === 'plaintext' || !hljs.getLanguage(language)) {
    return escapeHtml(text)
  }
  return hljs.highlight(text, { language, ignoreIllegals: true }).value
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
