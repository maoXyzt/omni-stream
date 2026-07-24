import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PageControls } from './PageControls'

describe('PageControls', () => {
  it('shows and announces the requested page while rows are loading', () => {
    const markup = renderToStaticMarkup(
      <PageControls
        pageIndex={1}
        pageCount={3}
        hasMore
        loading
        showLoadingStatus
        onPrev={() => {}}
        onNext={() => {}}
        onJump={() => {}}
      />,
    )

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Loading page 2')
  })

  it('can disable controls without adding a second loading indicator', () => {
    const markup = renderToStaticMarkup(
      <PageControls
        pageIndex={0}
        pageCount={3}
        hasMore
        loading
        onPrev={() => {}}
        onNext={() => {}}
        onJump={() => {}}
      />,
    )

    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toContain('role="status"')
  })
})
