// Recursive renderer for the Rows View node tree. Maps each schema node onto
// a React subtree:
//
//   AtomNode      → parse selector, evaluate against row, render widget(s)
//   ContainerNode → row / column / grid wrapper around children
//
// Selector parsing happens here (not in the schema layer) because the schema
// stores `from` as a source string for URL compactness. We memoize per-node
// so the same string isn't re-parsed across rows.

import { Suspense, useMemo } from 'react'

import type { AtomNode, Node } from '@/lib/rows-schema'
import { parseSelector } from '@/lib/rows-selector'
import { evalSelector } from '@/lib/rows-selector-eval'
import { Skeleton } from '@/components/ui/skeleton'
import {
  EmptyHint,
  WidgetAudio,
  WidgetDefault,
  WidgetHighlight,
  WidgetImage,
  WidgetLink,
  WidgetMarkdown,
  WidgetVideo,
  type RenderContext,
} from '@/components/preview/rows-widgets'

interface RowNodeProps {
  node: Node
  row: Record<string, unknown>
  ctx: RenderContext
}

export function RowNode({ node, row, ctx }: RowNodeProps) {
  if ('children' in node) {
    return (
      <NodeFrame label={node.label}>
        <RowContainer node={node} row={row} ctx={ctx} />
      </NodeFrame>
    )
  }
  return (
    <NodeFrame label={node.label}>
      <RowAtom node={node} row={row} ctx={ctx} />
    </NodeFrame>
  )
}

// One card per source data row. Header strip mirrors the v1 look so the visual
// anchor stays familiar; tabular-nums keeps the row counter aligned.
export function RowCard({
  index,
  children,
}: {
  index: number
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md border bg-card">
      <div className="border-b bg-muted/40 px-3 py-1.5 font-mono text-xs text-muted-foreground tabular-nums">
        row {(index + 1).toLocaleString()}
      </div>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </div>
  )
}

// -----------------------------------------------------------------------
// Atom
// -----------------------------------------------------------------------

function RowAtom({
  node,
  row,
  ctx,
}: {
  node: AtomNode
  row: Record<string, unknown>
  ctx: RenderContext
}) {
  // Re-parsing the same source string is cheap, but per-row re-parses for the
  // same node would burn cycles on large pages — memoize on `node.from`.
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, ...parseSelector(node.from) }
    } catch (err) {
      return {
        ok: false as const,
        message:
          err instanceof Error ? err.message : `invalid selector: ${String(err)}`,
      }
    }
  }, [node.from])

  // `values` is always computed (hooks must run every render) but the body
  // bails out when the selector itself failed to parse — the error UI below
  // takes precedence.
  const values = useMemo(
    () => (parsed.ok ? evalSelector(parsed.ast, row) : []),
    [parsed, row],
  )

  // Selector errors should have been caught at parseRules time, but a stale
  // URL with a since-changed grammar could theoretically slip past. Show
  // inline rather than crash the whole tree.
  if (!parsed.ok) {
    return (
      <div className="rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-xs italic text-destructive">
        invalid selector: <span className="font-mono not-italic">{node.from}</span>{' '}
        — {parsed.message}
      </div>
    )
  }

  if (!parsed.hasFanout) {
    return <WidgetSlot value={values[0]} node={node} ctx={ctx} />
  }

  // Fan-out: render N widgets in the atom's own layout container.
  if (values.length === 0) {
    return <EmptyHint text={node.empty} />
  }
  const layout = node.layout ?? 'column'
  const gap = node.gap ?? '0.75rem'
  const elements = values.map((v, i) => (
    <WidgetSlot key={i} value={v} node={node} ctx={ctx} />
  ))
  if (layout === 'row') {
    return (
      <div className="flex flex-row flex-wrap items-start" style={{ gap }}>
        {elements}
      </div>
    )
  }
  if (layout === 'grid') {
    const columns = node.columns ?? 2
    return (
      <div
        className="grid items-start"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap,
        }}
      >
        {elements}
      </div>
    )
  }
  // default 'column'
  return (
    <div className="flex flex-col" style={{ gap }}>
      {elements}
    </div>
  )
}

// Dispatch a single value to the configured widget. Wraps in Suspense for the
// two lazy widgets (markdown / highlight) — non-lazy widgets don't suspend so
// the boundary is invisible to them.
function WidgetSlot({
  value,
  node,
  ctx,
}: {
  value: unknown
  node: AtomNode
  ctx: RenderContext
}) {
  return (
    <Suspense fallback={<WidgetFallback />}>
      <WidgetBody value={value} node={node} ctx={ctx} />
    </Suspense>
  )
}

function WidgetBody({
  value,
  node,
  ctx,
}: {
  value: unknown
  node: AtomNode
  ctx: RenderContext
}) {
  const show = node.show ?? 'default'
  switch (show) {
    case 'default':
      return <WidgetDefault value={value} maxHeight={node.maxHeight} />
    case 'highlight':
      // `lang` is required at this point (schema validation), but guard so a
      // bad URL parsed by an older schema doesn't crash here.
      return (
        <WidgetHighlight
          value={value}
          lang={node.lang ?? 'plaintext'}
          maxHeight={node.maxHeight}
        />
      )
    case 'image':
      return <WidgetImage value={value} src={node.src ?? '{value}'} ctx={ctx} />
    case 'video':
      return <WidgetVideo value={value} src={node.src ?? '{value}'} ctx={ctx} />
    case 'audio':
      return <WidgetAudio value={value} src={node.src ?? '{value}'} ctx={ctx} />
    case 'link':
      return <WidgetLink value={value} src={node.src ?? '{value}'} ctx={ctx} />
    case 'markdown':
      return <WidgetMarkdown value={value} maxHeight={node.maxHeight} />
  }
}

function WidgetFallback() {
  return <Skeleton className="h-16 w-full" />
}

// -----------------------------------------------------------------------
// Container
// -----------------------------------------------------------------------

function RowContainer({
  node,
  row,
  ctx,
}: {
  node: Extract<Node, { children: Node[] }>
  row: Record<string, unknown>
  ctx: RenderContext
}) {
  const gap = node.gap ?? '0.75rem'
  const children = node.children.map((c, i) => (
    <RowNode key={i} node={c} row={row} ctx={ctx} />
  ))
  if (node.kind === 'column') {
    return (
      <div className="flex flex-col" style={{ gap }}>
        {children}
      </div>
    )
  }
  if (node.kind === 'row') {
    // Each child's `width` defines its grid track; missing → 'auto'.
    const tracks = node.children
      .map((c) => c.width ?? 'auto')
      .join(' ')
    return (
      <div
        className="grid items-start"
        style={{ gridTemplateColumns: tracks, gap }}
      >
        {children}
      </div>
    )
  }
  // grid
  const columns = node.columns ?? 2
  return (
    <div
      className="grid items-start"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap,
      }}
    >
      {children}
    </div>
  )
}

// -----------------------------------------------------------------------
// Label wrapper
// -----------------------------------------------------------------------

function NodeFrame({
  label,
  children,
}: {
  label: string | undefined
  children: React.ReactNode
}) {
  if (!label) return <>{children}</>
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
