// Subsequence-based fuzzy matching with scoring.
//
// A query matches a target when every character in the query appears in the
// target in order (subsequence). Scoring rewards:
//   - Consecutive-character runs (+5 per extra char in a run)
//   - Word-start positions: after `/`, `-`, `_`, `.`, or the very first char (+4)
//   - Earlier position in the target (linear decay: -index/target.length)
//
// Empty query → score 0, indices [] (matches everything, preserves original order).

export interface FuzzyMatch {
  score: number
  indices: number[]
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  if (q.length === 0) return { score: 0, indices: [] }

  const indices: number[] = []
  let ti = 0
  for (let qi = 0; qi < q.length; qi++) {
    let found = false
    while (ti < t.length) {
      if (t[ti] === q[qi]) {
        indices.push(ti)
        ti++
        found = true
        break
      }
      ti++
    }
    if (!found) return null
  }

  // Scoring pass over the matched indices.
  let score = 0
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    // Word-start bonus: first char or preceded by a separator.
    const prev = idx > 0 ? t[idx - 1] : ''
    if (idx === 0 || prev === '/' || prev === '-' || prev === '_' || prev === '.') {
      score += 4
    }
    // Consecutive-run bonus.
    if (i > 0 && indices[i] === indices[i - 1] + 1) {
      score += 5
    }
    // Earlier-is-better: small positive bias for matches toward the start.
    score += (1 - idx / t.length) * 2
  }

  return { score, indices }
}

export function fuzzyRank<T>(
  query: string,
  items: T[],
  key: (t: T) => string,
): Array<{ item: T; match: FuzzyMatch }> {
  const results: Array<{ item: T; match: FuzzyMatch; originalIndex: number }> = []

  for (let i = 0; i < items.length; i++) {
    const match = fuzzyMatch(query, key(items[i]))
    if (match) results.push({ item: items[i], match, originalIndex: i })
  }

  // Stable sort: higher score first; ties preserve original order.
  results.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score
    return a.originalIndex - b.originalIndex
  })

  return results.map(({ item, match }) => ({ item, match }))
}
