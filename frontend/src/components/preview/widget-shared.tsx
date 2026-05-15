// Placeholder pieces shared across widgets. Pulled into its own module so
// lazily-loaded widgets (markdown, highlight) don't have to pull the whole
// rows-widgets bundle just to render their empty state.

export function EmptyHint({ text }: { text?: string } = {}) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs italic text-muted-foreground">
      {text ?? '(empty)'}
    </div>
  )
}
