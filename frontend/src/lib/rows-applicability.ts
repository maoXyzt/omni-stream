// Compute how well a saved rules preset matches the current file's
// schema. Used by the rules editor to highlight presets that would render
// cleanly against the open file, so users don't have to remember which
// preset goes with which dataset.
//
// Matching is purely structural: we extract the *root* column from each
// atom's selector (e.g. `images.[*].path` → `images`, `` `weird.col` ``
// → `weird.col`) and compare against the file's column list. Selectors
// that fail to parse are skipped — those will surface as validation
// errors in the editor anyway.

import type { Node } from './rows-schema'
import { SelectorError, parseSelector, rootColumn } from './rows-selector'

export interface PresetMatch {
  /// Distinct root columns referenced anywhere in the rules tree.
  referenced: Set<string>
  /// Subset of `referenced` that exists in the file's column list.
  matched: Set<string>
  /// Columns the rules reference but the file doesn't expose. When this
  /// is non-empty, applying the preset will render those atoms as empty
  /// — usually not what the user wanted.
  missing: Set<string>
  /// True when every referenced column resolves against the file
  /// (`missing` is empty). Empty rule sets (no references at all) are
  /// considered to fit trivially.
  fits: boolean
}

export function presetMatch(
  rules: Node[],
  columnNames: readonly string[],
): PresetMatch {
  const referenced = new Set<string>()
  collectColumns(rules, referenced)
  const available = new Set(columnNames)
  const matched = new Set<string>()
  const missing = new Set<string>()
  for (const col of referenced) {
    if (available.has(col)) matched.add(col)
    else missing.add(col)
  }
  return { referenced, matched, missing, fits: missing.size === 0 }
}

function collectColumns(nodes: Node[], out: Set<string>): void {
  for (const node of nodes) {
    if ('kind' in node) {
      collectColumns(node.children, out)
      continue
    }
    try {
      const parsed = parseSelector(node.from)
      out.add(rootColumn(parsed.ast))
    } catch (err) {
      // A malformed selector won't render anyway — skip and let the
      // editor's own validation flag it. We don't want one bad atom
      // to derail the whole applicability calculation.
      if (err instanceof SelectorError) continue
      throw err
    }
  }
}
