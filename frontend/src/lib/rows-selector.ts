// Selector parser for the rows view. See docs/parquet_rows_view_spec.md §1.
//
// Grammar (EBNF, no left recursion):
//   selector    := IDENT step*
//   step        := '.' IDENT                  // field shortcut
//                | '.' '[' bracketExpr ']'    // explicit bracket form
//   bracketExpr := '*'                        // fan-out
//                | INTEGER                    // index, possibly negative
//                | INTEGER? ':' INTEGER?      // slice, at least one bound
//                | IDENT                      // field by identifier
//                | STRING                     // field by quoted name
//   IDENT       := [A-Za-z_][A-Za-z0-9_]*
//   INTEGER     := '-'? [0-9]+
//   STRING      := '"' (escape | non-quote-non-backslash)* '"'
//
// Semantics:
//   * The first IDENT is the root column. Subsequent steps drill down.
//   * '.[*]' (fan-out) may appear at most once per selector. Multiple
//     fan-outs would mean cross-product, which we don't render today.
//   * '.[:]' (slice with both sides omitted) is rejected — that's a no-op
//     and would confuse readers into thinking it means fan-out.
//   * Field access can be written as '.ident' or '.[ident]'. They are
//     identical in semantics. Use bracket form for keys with special chars.
//
// Errors carry the char offset into the source string so the editor can
// underline the bad span.

export type Selector =
  | { op: 'root'; column: string }
  | { op: 'field'; from: Selector; key: string }
  | { op: 'index'; from: Selector; index: number }
  | { op: 'slice'; from: Selector; start: number | null; end: number | null }
  | { op: 'fanout'; from: Selector }

export interface ParsedSelector {
  ast: Selector
  /// True if the selector contains a `.[*]` step somewhere in the chain.
  /// Schema validation uses this to decide whether `layout` / `columns` /
  /// `gap` / `empty` fields are allowed on an atom node.
  hasFanout: boolean
}

export class SelectorError extends Error {
  readonly offset: number
  constructor(offset: number, msg: string) {
    super(`${msg} (col ${offset + 1})`)
    this.name = 'SelectorError'
    this.offset = offset
  }
}

/// Parse a selector source string. Throws SelectorError on syntax violation.
export function parseSelector(src: string): ParsedSelector {
  const p = new Parser(src)
  const ast = p.parse()
  return { ast, hasFanout: p.fanouts > 0 }
}

class Parser {
  readonly src: string
  pos = 0
  fanouts = 0

  constructor(src: string) {
    this.src = src
  }

  parse(): Selector {
    this.skipWs()
    if (this.pos >= this.src.length) {
      throw new SelectorError(0, 'empty selector')
    }
    // Root accepts IDENT, double-quoted string, or backtick-quoted string.
    // Backtick is the JSON-friendly form: column names with dots / spaces /
    // other special chars don't need double escaping inside the JSON.
    const rootAt = this.pos
    let column: string | null = null
    const c0 = this.peek()
    if (c0 === '"' || c0 === '`') {
      column = this.readQuotedString(c0)
    } else {
      column = this.readIdent()
    }
    if (column === null) {
      throw new SelectorError(
        this.pos,
        'expected column name (identifier, "double-quoted", or `backtick-quoted`)',
      )
    }
    if (column.length === 0) {
      throw new SelectorError(rootAt, 'empty column name')
    }
    let node: Selector = { op: 'root', column }
    while (this.pos < this.src.length) {
      this.skipWs()
      if (this.pos >= this.src.length) break
      node = this.parseStep(node)
    }
    return node
  }

  parseStep(from: Selector): Selector {
    if (this.peek() !== '.') {
      throw new SelectorError(this.pos, `expected '.' to start next step, got '${this.peek()}'`)
    }
    this.pos++ // consume '.'
    if (this.pos >= this.src.length) {
      throw new SelectorError(this.pos, 'trailing dot — expected identifier or [...]')
    }
    if (this.peek() === '[') {
      return this.parseBracketStep(from)
    }
    // Field shortcut: .ident
    const key = this.readIdent()
    if (key === null) {
      throw new SelectorError(this.pos, "expected identifier or '[' after '.'")
    }
    return { op: 'field', from, key }
  }

  parseBracketStep(from: Selector): Selector {
    const openAt = this.pos
    this.pos++ // consume '['
    this.skipWs()
    if (this.pos >= this.src.length) {
      throw new SelectorError(openAt, "unterminated '['")
    }
    const c = this.peek()

    // Fan-out: .[*]
    if (c === '*') {
      this.pos++
      this.skipWs()
      this.expect(']')
      this.fanouts++
      if (this.fanouts > 1) {
        throw new SelectorError(
          openAt,
          'at most one [*] per selector (multiple fan-outs are cross-product, not supported)',
        )
      }
      return { op: 'fanout', from }
    }

    // Slice or index — both start with optional integer or ':'.
    // Try to parse as slice/index first; if not numeric and not ':', it's a
    // field key.
    if (c === ':' || c === '-' || isDigit(c)) {
      return this.parseIndexOrSlice(from, openAt)
    }

    // Quoted field — double-quote (JSON escapes) or backtick (raw).
    if (c === '"' || c === '`') {
      const key = this.readQuotedString(c)
      this.skipWs()
      this.expect(']')
      return { op: 'field', from, key }
    }

    // Bare identifier field
    const key = this.readIdent()
    if (key !== null) {
      this.skipWs()
      this.expect(']')
      return { op: 'field', from, key }
    }

    throw new SelectorError(this.pos, "expected '*', integer, ':', identifier, or quoted string inside '[...]'")
  }

  parseIndexOrSlice(from: Selector, openAt: number): Selector {
    const startTok = this.tryReadInt()
    this.skipWs()
    // If we see ':' it's a slice. Otherwise must be index — close bracket.
    if (this.peek() === ':') {
      this.pos++ // consume ':'
      this.skipWs()
      let end: number | null = null
      if (this.peek() !== ']') {
        end = this.readInt(openAt) // required when not ']'
        this.skipWs()
      }
      this.expect(']')
      if (startTok === null && end === null) {
        throw new SelectorError(
          openAt,
          'slice must have at least one bound; .[:] is not allowed (use .[*] to fan out)',
        )
      }
      return { op: 'slice', from, start: startTok, end }
    }
    // Plain index — startTok must be present (we entered on digit or '-')
    if (startTok === null) {
      throw new SelectorError(openAt, 'expected integer index')
    }
    this.expect(']')
    return { op: 'index', from, index: startTok }
  }

  // ----- low-level token helpers -----

  peek(): string {
    return this.src[this.pos] ?? ''
  }

  expect(ch: string): void {
    if (this.peek() !== ch) {
      const got = this.peek() || '<end>'
      throw new SelectorError(this.pos, `expected '${ch}', got '${got}'`)
    }
    this.pos++
  }

  skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos++
      } else {
        break
      }
    }
  }

  readIdent(): string | null {
    const start = this.pos
    const c = this.peek()
    if (!isIdentStart(c)) return null
    this.pos++
    while (this.pos < this.src.length && isIdentCont(this.src[this.pos]!)) {
      this.pos++
    }
    return this.src.slice(start, this.pos)
  }

  /// Read an integer, throwing if the next chars don't parse.
  readInt(errAt: number): number {
    const v = this.tryReadInt()
    if (v === null) {
      throw new SelectorError(errAt, 'expected integer')
    }
    return v
  }

  /// Try to consume an integer. Returns null without advancing if the next
  /// chars don't start an integer.
  tryReadInt(): number | null {
    const start = this.pos
    if (this.peek() === '-') this.pos++
    let digitStart = this.pos
    while (this.pos < this.src.length && isDigit(this.src[this.pos]!)) {
      this.pos++
    }
    if (this.pos === digitStart) {
      // Backtrack — we may have consumed a stray '-'.
      this.pos = start
      return null
    }
    return Number.parseInt(this.src.slice(start, this.pos), 10)
  }

  /// Read a quoted string. Two forms:
  ///   * Double-quoted: JSON-style escapes (\" \\ \/ \n \r \t \uXXXX).
  ///   * Backtick-quoted: raw — no escapes interpreted, ends at next backtick.
  ///     Use this form in JSON-embedded selectors to avoid double escaping.
  ///     A column name literally containing a backtick must fall back to the
  ///     double-quote form (with `).
  readQuotedString(quote: '"' | '`'): string {
    if (this.peek() !== quote) {
      throw new SelectorError(this.pos, `expected ${quote}`)
    }
    const start = this.pos
    this.pos++ // consume opening quote
    let out = ''
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!
      if (c === quote) {
        this.pos++
        return out
      }
      if (quote === '"' && c === '\\') {
        this.pos++
        const esc = this.src[this.pos]
        if (esc === undefined) {
          throw new SelectorError(this.pos, 'unterminated escape')
        }
        this.pos++
        switch (esc) {
          case '"':
            out += '"'
            break
          case '\\':
            out += '\\'
            break
          case '/':
            out += '/'
            break
          case 'n':
            out += '\n'
            break
          case 'r':
            out += '\r'
            break
          case 't':
            out += '\t'
            break
          case 'u': {
            if (this.pos + 4 > this.src.length) {
              throw new SelectorError(this.pos - 2, '\\u escape needs 4 hex digits')
            }
            const hex = this.src.slice(this.pos, this.pos + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new SelectorError(this.pos - 2, '\\u escape needs 4 hex digits')
            }
            this.pos += 4
            out += String.fromCharCode(Number.parseInt(hex, 16))
            break
          }
          default:
            throw new SelectorError(this.pos - 2, `unknown escape '\\${esc}'`)
        }
        continue
      }
      out += c
      this.pos++
    }
    throw new SelectorError(start, 'unterminated string')
  }
}

function isIdentStart(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_'
}

function isIdentCont(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9')
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}
