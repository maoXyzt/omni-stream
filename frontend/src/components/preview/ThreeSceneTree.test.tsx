import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ThreeSceneTree } from './ThreeSceneTree'

describe('ThreeSceneTree', () => {
  it('keeps tree items directly represented in the accessibility tree', () => {
    const markup = renderToStaticMarkup(
      <ThreeSceneTree
        nodes={[{ id: 'cube', name: 'Cube', selected: true }]}
        searchQuery=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onToggleVisibility={vi.fn()}
        onShowAll={vi.fn()}
        onIsolateSelected={vi.fn()}
      />,
    )

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('role="none"')
    expect(markup).toContain('role="treeitem"')
    expect(markup).toContain('>Cube</span>')
  })
})
