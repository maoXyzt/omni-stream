// Prompt template for the "AI prompt" button in the rules editor. We
// hand-roll a compact distillation of the user guide here so the popup
// can stitch in the actual column schema without round-tripping to the
// docs file at build time.
//
// IMPORTANT: this content should track docs/parquet_rows_view_user_guide.md.
// When the guide gains a new rule (e.g. a widget option) update this string
// too so the AI-generated configs reflect reality.

import type { ColumnInfo } from '@/lib/rows-source'

const SPEC = `You're writing a Rows View config for omni-stream — a JSON array describing how each row of a data file should be rendered as a card.

═══ ATOMS (one widget per cell value) ═══

Three equivalent forms:
  "prompt"                                  ← shortest: bare string = default-widget atom on column "prompt"
  { "image": "thumb" }                      ← widget-tag sugar
  { "from": "thumb", "show": "image" }      ← canonical

Widgets (the value of \`show\`, or the tag-key in sugar form):
  default     plain text / number / object (the default when \`show\` is omitted)
  highlight   code highlight — REQUIRES \`lang\` (json/python/typescript/sql/bash/yaml/markdown/html/...)
  image       <img>
  video       <video controls>
  audio       <audio controls>
  link        <a href>
  markdown    minimal markdown (no GFM tables, no raw HTML)
  text        fetch the file at the cell's path and render its body inline.
              Large files load in 1 MiB chunks with a "Load more" button.
              Optional \`lang\` for syntax highlighting; auto-detected from the
              filename extension when omitted.

Atom options:
  label       text shown above the widget
  width       CSS dim when atom sits as a flex child: "1fr" | "320px" | "auto"
  maxHeight   only on default / highlight / markdown / text
  src         only on image/video/audio/link/text — URL template with {value} placeholder
                "{value}"                  ← default; cell value used as the storage path
                "./images/{value}"         ← sibling dir
                "https://cdn/{value}.png"  ← remote URL
  layout      "flow" / "row" / "column" / "grid" — only when selector contains \`.[*]\`
  columns     positive int — only when \`layout\` (or container \`kind\`) is "grid"
  gap, empty  only with \`.[*]\` fan-out

═══ CONTAINERS (group + lay out child nodes) ═══

Sugar:     { "<kind>": [children], ...opts }
Canonical: { "kind": "<kind>", "children": [...], ...opts }

Four kinds:
  flow (default) — flex-wrap horizontal. Children flow naturally, wrap when full.
  row    — single horizontal line, no wrap. Full width.
  column — vertical stack. Full width.
  grid   — N-column grid (set \`columns: N\`). Full width.

CRITICAL:
- The top-level JSON array is implicitly a \`flow\` container. Don't wrap it.
- Explicit containers (row / column / grid) all take FULL WIDTH in their parent flow → wrapping nodes in one is the way to "start a new row / line".
- Nested arrays inside container children also default to \`flow\`.

═══ SELECTOR — the \`from\` string ═══

A path expression that extracts value(s) from the row.

  col              column at the root
  col.field        object field (shortcut)
  col.[field]      same, explicit bracket form
  col.[0]          index (negative wraps from end: -1 = last)
  col.[2:5]        slice (at least one bound required; \`.[:]\` is invalid)
  col.[:200]       prefix slice (first 200 chars of a string column)
  col.[*]          ★ fan-out: render the widget N times, once per list element
  col.[*].[path]   each list element's \`path\` field
  meta.tags.[0]    nested

Rules:
- At most one \`.[*]\` per selector chain.
- \`.[*]\` only works on lists. Wrong type → renders empty placeholder, no exception.
- Special-char column names: wrap in backticks. A column literally named "weird.col" is referenced as the selector \`\\\`weird.col\\\`\` — inside JSON that's "\\\`weird.col\\\`" (backticks need no JSON escape).

═══ EXAMPLES ═══

Just text:                       ["prompt"]
Image, default src:              [{ "image": "thumbnail" }]
Image, remote URL:               [{ "image": "id", "src": "https://cdn/{value}.png" }]
Each image (grid 3-up):          [{ "image": "images.[*]", "layout": "grid", "columns": 3 }]
First image only:                [{ "image": "images.[0]" }]
Nested struct field per element: [{ "image": "images.[*].[path]" }]
Highlighted JSON cell:           [{ "highlight": "metadata", "lang": "json" }]
Inline text file by path:        [{ "text": "transcript_path" }]
Sibling .log inline w/ syntax:   [{ "text": "id", "src": "./logs/{value}.log", "lang": "bash" }]
Forced one-line row:             [{ "row": ["prompt", { "image": "thumb" }] }]
Mixed default flow:              ["prompt", { "image": "thumb", "width": "320px" }]
Stack a chunk + flow:            [{ "column": ["prompt", { "image": "thumb" }] }, "metadata"]

═══ COMMON MISTAKES ═══

- \`highlight\` widget without \`lang\` → ERROR. Always include \`"lang": "..."\`.
- \`.[:]\` slice with no bounds → ERROR. Use \`.[*]\` for "every element".
- Using \`pathPrefix\` (old name) → field is now \`src\`, with \`{value}\` template.
- \`src\` on default / highlight / markdown → ERROR; only image/video/audio/link/text accept it.
- \`layout\` / \`columns\` / \`gap\` / \`empty\` without \`.[*]\` in selector → ERROR.
- Column name with \`.\` written bare: \`image.path\` parses as \`column "image" → field "path"\`. To reference a column literally named "image.path" use backticks.
`

/// Build the complete AI prompt, weaving the file's columns in. The user
/// fills in `<<<...>>>` with their natural-language request before sending
/// to the AI; the AI replies with a JSON array the user pastes into the
/// editor.
export function buildAiPrompt(columns: ColumnInfo[]): string {
  const columnsBlock =
    columns.length === 0
      ? '(no columns detected — file may not be loaded yet)'
      : columns.map((c) => `- ${c.name}: ${c.type}`).join('\n')

  return `${SPEC}
═══ MY COLUMNS ═══

${columnsBlock}

═══ WHAT I WANT ═══

<<<describe in natural language what each card should look like, then delete this placeholder>>>

═══ OUTPUT ═══

Output ONLY the JSON array. No markdown code fences, no explanation, no preamble. Must be syntactically valid JSON and conform to the schema above.
`
}
