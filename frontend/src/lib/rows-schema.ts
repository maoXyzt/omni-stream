// Rows view schema. See docs/parquet_rows_view_spec.md for the spec. This
// module:
//   * defines canonical Node types (atom + container),
//   * accepts canonical + sugar inputs and normalizes to canonical,
//   * validates structure with path-tagged errors,
//   * parses every atom's `from` selector via rows-selector.
//
// No rendering — that lives next to the React components.

import { parseSelector, SelectorError } from './rows-selector'

export type Widget =
  | 'default'
  | 'highlight'
  | 'image'
  | 'video'
  | 'audio'
  | 'link'
  | 'markdown'
  | 'text'

export type ContainerKind = 'flow' | 'row' | 'column' | 'grid'

export interface BaseNode {
  label?: string
  width?: string
}

export interface AtomNode extends BaseNode {
  /// Selector source string. See rows-selector.ts for the grammar.
  from: string
  /// Widget; absent means 'default'. Default is omitted from canonical
  /// serialization to keep URLs short.
  show?: Widget
  /// Required when show='highlight', rejected otherwise.
  lang?: string
  /// URL/path template for image/video/audio/link widgets. The literal token
  /// `{value}` is substituted with the cell value at render time; everything
  /// else is taken verbatim. Defaults to '{value}' (cell value used as-is).
  /// Examples:
  ///   "{value}"                  → use cell value as the storage path
  ///   "./images/{value}"         → cell value lives under a sibling dir
  ///   "https://cdn/{value}.png"  → build a remote URL from an ID column
  /// The rendered string is then resolved like any storage path: relative
  /// paths anchor at the source file's directory, '..' walks up, absolute
  /// paths start with '/'.
  src?: string
  /// Allowed on default/highlight/markdown only.
  maxHeight?: string
  /// Only meaningful when the selector contains `.[*]` (fan-out). Validates
  /// against the selector AST at parse time. Defaults to 'flow' at render
  /// (horizontal wrap), matching the top-level default.
  layout?: 'flow' | 'row' | 'column' | 'grid'
  columns?: number
  gap?: string
  empty?: string
}

export interface ContainerNode extends BaseNode {
  kind: ContainerKind
  children: Node[]
  /// grid only.
  columns?: number
  gap?: string
}

export type Node = AtomNode | ContainerNode

export interface ParseResult {
  rules: Node[]
  error: string | null
}

const WIDGETS = new Set<string>([
  'default',
  'highlight',
  'image',
  'video',
  'audio',
  'link',
  'markdown',
  'text',
])

const CONTAINER_KINDS = new Set<string>(['flow', 'row', 'column', 'grid'])
// Widgets that produce a URL/path from the cell value via the `src` template.
// `text` joins the media widgets because its cell value is also a storage
// path (resolved the same way), the body just happens to be UTF-8 text.
const SRC_WIDGETS = new Set<string>(['image', 'video', 'audio', 'link', 'text'])
const MAX_HEIGHT_WIDGETS = new Set<string>([
  'default',
  'highlight',
  'markdown',
  'text',
])
// Widgets that accept the `lang` highlight hint. Required on `highlight`,
// optional on `text` (auto-detected from the resolved filename when absent).
const LANG_WIDGETS = new Set<string>(['highlight', 'text'])

const ATOM_ALLOWED = new Set([
  'from',
  'show',
  'lang',
  'src',
  'maxHeight',
  'layout',
  'columns',
  'gap',
  'empty',
  'label',
  'width',
])
const CONTAINER_ALLOWED = new Set([
  'kind',
  'children',
  'columns',
  'gap',
  'label',
  'width',
])

// Fields that only make sense when the selector fans out into multiple values.
const FANOUT_REQUIRED_FIELDS = ['layout', 'columns', 'gap', 'empty']

class SchemaError extends Error {
  readonly path: string
  constructor(path: string, msg: string) {
    super(`${path}: ${msg}`)
    this.path = path
    this.name = 'SchemaError'
  }
}

/// Parse rules from any input — accepts sugar and canonical, normalizes to
/// canonical. Returns canonical `Node[]` ready to be JSON.stringified into the
/// URL.
export function parseRules(input: unknown): ParseResult {
  if (input === null || input === undefined) {
    return { rules: [], error: null }
  }
  if (!Array.isArray(input)) {
    return { rules: [], error: 'root: expected an array of nodes' }
  }
  try {
    const out: Node[] = []
    for (let i = 0; i < input.length; i++) {
      out.push(parseNode(input[i], `nodes[${i}]`))
    }
    return { rules: out, error: null }
  } catch (err) {
    if (err instanceof SchemaError) return { rules: [], error: err.message }
    if (err instanceof Error) return { rules: [], error: err.message }
    return { rules: [], error: String(err) }
  }
}

function parseNode(input: unknown, path: string): Node {
  if (typeof input === 'string') {
    if (input.length === 0) {
      throw new SchemaError(path, 'empty string is not a valid atom')
    }
    return buildAtom({ from: input }, path)
  }
  if (Array.isArray(input)) {
    const children = input.map((c, i) => parseNode(c, `${path}[${i}]`))
    return { kind: 'flow', children }
  }
  if (input === null || typeof input !== 'object') {
    const t = input === null ? 'null' : typeof input
    throw new SchemaError(path, `expected node (string | array | object), got ${t}`)
  }
  const obj = input as Record<string, unknown>

  // Container with explicit container kind.
  if (typeof obj.kind === 'string' && CONTAINER_KINDS.has(obj.kind)) {
    return buildContainer(obj, path)
  }
  // Children without explicit kind defaults to 'flow'.
  if ('children' in obj) {
    if ('kind' in obj) {
      throw new SchemaError(
        path,
        `"kind" must be one of flow | row | column | grid (got ${JSON.stringify(obj.kind)})`,
      )
    }
    return buildContainer({ kind: 'flow', ...obj }, path)
  }
  // Stray non-container kind.
  if ('kind' in obj) {
    throw new SchemaError(
      path,
      `"kind" must be one of flow | row | column | grid (got ${JSON.stringify(obj.kind)})`,
    )
  }

  // Atom canonical: explicit `from` or `show` (or both).
  if ('from' in obj || 'show' in obj) {
    return buildAtom(obj, path)
  }

  // Tag-key sugar: widget tags expand to atoms, container tags to containers.
  // No tag name overlaps with any field name, so the disambiguation is purely
  // by key set.
  const keys = Object.keys(obj)
  const tagKeys = keys.filter((k) => WIDGETS.has(k) || CONTAINER_KINDS.has(k))
  if (tagKeys.length === 0) {
    throw new SchemaError(
      path,
      'missing "from", "kind", or tag key (e.g. { "image": "thumb" } / { "row": [...] })',
    )
  }
  if (tagKeys.length > 1) {
    throw new SchemaError(
      path,
      `ambiguous: multiple tag keys ${JSON.stringify(tagKeys)}`,
    )
  }
  const tag = tagKeys[0]!

  if (CONTAINER_KINDS.has(tag)) {
    const value = obj[tag]
    if (!Array.isArray(value)) {
      throw new SchemaError(
        path,
        `container shortcut "${tag}" expects an array of children`,
      )
    }
    const expanded: Record<string, unknown> = { kind: tag, children: value }
    for (const k of keys) {
      if (k === tag) continue
      expanded[k] = obj[k]
    }
    return buildContainer(expanded, path)
  }

  // Widget tag.
  const fromValue = obj[tag]
  if (typeof fromValue !== 'string') {
    throw new SchemaError(
      path,
      `widget shortcut "${tag}" expects a selector string value`,
    )
  }
  const expanded: Record<string, unknown> = { from: fromValue, show: tag }
  for (const k of keys) {
    if (k === tag) continue
    expanded[k] = obj[k]
  }
  return buildAtom(expanded, path)
}

function buildContainer(obj: Record<string, unknown>, path: string): ContainerNode {
  const kind = obj.kind as ContainerKind
  if (!Array.isArray(obj.children)) {
    throw new SchemaError(path, `"${kind}": "children" is required and must be an array`)
  }
  const children = (obj.children as unknown[]).map((c, i) =>
    parseNode(c, `${path}.children[${i}]`),
  )
  if ('label' in obj && typeof obj.label !== 'string') {
    throw new SchemaError(path, '"label" must be a string')
  }
  if ('width' in obj && typeof obj.width !== 'string') {
    throw new SchemaError(path, '"width" must be a string')
  }
  if ('columns' in obj) {
    if (kind !== 'grid') {
      throw new SchemaError(path, '"columns" only allowed on grid')
    }
    if (!isPositiveInt(obj.columns)) {
      throw new SchemaError(path, '"columns" must be a positive integer')
    }
  }
  if ('gap' in obj && typeof obj.gap !== 'string') {
    throw new SchemaError(path, '"gap" must be a string')
  }
  rejectUnknownFields(obj, CONTAINER_ALLOWED, kind, path)
  const node: ContainerNode = { kind, children }
  if (typeof obj.label === 'string') node.label = obj.label
  if (typeof obj.width === 'string') node.width = obj.width
  if (typeof obj.columns === 'number') node.columns = obj.columns
  if (typeof obj.gap === 'string') node.gap = obj.gap
  return node
}

function buildAtom(obj: Record<string, unknown>, path: string): AtomNode {
  if (typeof obj.from !== 'string' || obj.from.length === 0) {
    throw new SchemaError(path, '"from" must be a non-empty selector string')
  }
  let hasFanout: boolean
  try {
    hasFanout = parseSelector(obj.from).hasFanout
  } catch (err) {
    if (err instanceof SelectorError) {
      throw new SchemaError(
        path,
        `invalid selector ${JSON.stringify(obj.from)}: ${err.message}`,
      )
    }
    throw err
  }

  let show: Widget = 'default'
  if ('show' in obj) {
    if (typeof obj.show !== 'string' || !WIDGETS.has(obj.show)) {
      throw new SchemaError(
        path,
        `"show" must be one of ${[...WIDGETS].sort().join(' | ')}`,
      )
    }
    show = obj.show as Widget
  }

  if ('lang' in obj) {
    if (!LANG_WIDGETS.has(show)) {
      throw new SchemaError(
        path,
        `"lang" only allowed on show="highlight" or show="text"`,
      )
    }
    if (typeof obj.lang !== 'string' || obj.lang.length === 0) {
      throw new SchemaError(path, '"lang" must be a non-empty string')
    }
  } else if (show === 'highlight') {
    throw new SchemaError(path, '"lang" is required for show="highlight"')
  }

  if ('src' in obj) {
    if (!SRC_WIDGETS.has(show)) {
      throw new SchemaError(path, `"src" not allowed on show="${show}"`)
    }
    if (typeof obj.src !== 'string' || obj.src.length === 0) {
      throw new SchemaError(path, '"src" must be a non-empty string')
    }
  }

  if ('maxHeight' in obj) {
    if (!MAX_HEIGHT_WIDGETS.has(show)) {
      throw new SchemaError(path, `"maxHeight" not allowed on show="${show}"`)
    }
    if (typeof obj.maxHeight !== 'string') {
      throw new SchemaError(path, '"maxHeight" must be a string')
    }
  }

  // Fan-out-only fields gate before per-field type checks to give the more
  // informative error first.
  if (!hasFanout) {
    for (const f of FANOUT_REQUIRED_FIELDS) {
      if (f in obj) {
        throw new SchemaError(
          path,
          `"${f}" requires a fan-out (.[*]) in the selector`,
        )
      }
    }
  }
  if ('layout' in obj) {
    if (
      obj.layout !== 'flow' &&
      obj.layout !== 'column' &&
      obj.layout !== 'row' &&
      obj.layout !== 'grid'
    ) {
      throw new SchemaError(
        path,
        '"layout" must be "flow" | "row" | "column" | "grid"',
      )
    }
  }
  if ('columns' in obj) {
    if (obj.layout !== 'grid') {
      throw new SchemaError(path, '"columns" only allowed when layout="grid"')
    }
    if (!isPositiveInt(obj.columns)) {
      throw new SchemaError(path, '"columns" must be a positive integer')
    }
  }
  if ('gap' in obj && typeof obj.gap !== 'string') {
    throw new SchemaError(path, '"gap" must be a string')
  }
  if ('empty' in obj && typeof obj.empty !== 'string') {
    throw new SchemaError(path, '"empty" must be a string')
  }
  if ('label' in obj && typeof obj.label !== 'string') {
    throw new SchemaError(path, '"label" must be a string')
  }
  if ('width' in obj && typeof obj.width !== 'string') {
    throw new SchemaError(path, '"width" must be a string')
  }
  rejectUnknownFields(obj, ATOM_ALLOWED, 'atom', path)

  const node: AtomNode = { from: obj.from }
  if (show !== 'default') node.show = show
  if (typeof obj.lang === 'string') node.lang = obj.lang
  if (typeof obj.src === 'string') node.src = obj.src
  if (typeof obj.maxHeight === 'string') node.maxHeight = obj.maxHeight
  if (
    obj.layout === 'flow' ||
    obj.layout === 'column' ||
    obj.layout === 'row' ||
    obj.layout === 'grid'
  ) {
    node.layout = obj.layout
  }
  if (typeof obj.columns === 'number') node.columns = obj.columns
  if (typeof obj.gap === 'string') node.gap = obj.gap
  if (typeof obj.empty === 'string') node.empty = obj.empty
  if (typeof obj.label === 'string') node.label = obj.label
  if (typeof obj.width === 'string') node.width = obj.width
  return node
}

function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  kind: string,
  path: string,
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new SchemaError(path, `unknown field "${k}" on ${kind}`)
    }
  }
}

function isPositiveInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}
