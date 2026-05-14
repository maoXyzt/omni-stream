// Selector evaluator. Pure: given a parsed AST + a row of column data, walk
// the chain and produce the value(s) the widget should render.
//
// Return shape is always `unknown[]`:
//   * non-fanout selectors → exactly 1 element (possibly `undefined` for a
//     missing column / wrong-type intermediate result)
//   * fanout selectors (chain contains `.[*]`) → N elements, may be 0 when
//     the fan-out target is missing or isn't a list
//
// This unified shape lets the renderer write `evalSelector(...).map(render)`
// regardless of fan-out; the schema's `hasFanout` flag tells the renderer
// whether to expect a single widget or a layout of N widgets.

import type { Selector } from './rows-selector'

export function evalSelector(
  ast: Selector,
  row: Record<string, unknown>,
): unknown[] {
  return evalStep(ast, row)
}

function evalStep(ast: Selector, row: Record<string, unknown>): unknown[] {
  switch (ast.op) {
    case 'root':
      return [row[ast.column]]
    case 'field': {
      const up = evalStep(ast.from, row)
      return up.map((v) => fieldOf(v, ast.key))
    }
    case 'index': {
      const up = evalStep(ast.from, row)
      return up.map((v) => indexOf(v, ast.index))
    }
    case 'slice': {
      const up = evalStep(ast.from, row)
      return up.map((v) => sliceOf(v, ast.start, ast.end))
    }
    case 'fanout': {
      const up = evalStep(ast.from, row)
      const out: unknown[] = []
      for (const v of up) {
        if (Array.isArray(v)) {
          for (const el of v) out.push(el)
        }
        // anything non-list contributes zero elements — surface as empty
        // placeholder downstream, never an exception
      }
      return out
    }
  }
}

// "object" here means *plain* object — Arrays / Dates / Uint8Arrays don't
// participate in field access even though `typeof` says 'object'. A column
// of timestamps shouldn't accidentally expose `Date` instance methods via
// `colName.toISOString` etc.
function fieldOf(v: unknown, key: string): unknown {
  if (v === null || v === undefined) return undefined
  if (typeof v !== 'object') return undefined
  if (Array.isArray(v)) return undefined
  if (v instanceof Date) return undefined
  if (v instanceof Uint8Array) return undefined
  return (v as Record<string, unknown>)[key]
}

function indexOf(v: unknown, n: number): unknown {
  // Array / string only. Negative wraps from the end like Python.
  if (Array.isArray(v)) {
    const i = n < 0 ? v.length + n : n
    return i >= 0 && i < v.length ? v[i] : undefined
  }
  if (typeof v === 'string') {
    const i = n < 0 ? v.length + n : n
    return i >= 0 && i < v.length ? v[i] : undefined
  }
  return undefined
}

function sliceOf(
  v: unknown,
  start: number | null,
  end: number | null,
): unknown {
  // Array.prototype.slice and String.prototype.slice already handle negative
  // bounds the Python-ish way (counted from the end), and `undefined` for
  // missing bounds. Just forward.
  if (Array.isArray(v)) {
    return v.slice(start ?? undefined, end ?? undefined)
  }
  if (typeof v === 'string') {
    return v.slice(start ?? undefined, end ?? undefined)
  }
  return undefined
}
