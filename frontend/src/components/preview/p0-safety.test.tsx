import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PreviewSpinner } from './PreviewSpinner'

describe('P0 preview safety', () => {
  it('announces the shared preview loading state', () => {
    const markup = renderToStaticMarkup(<PreviewSpinner />)

    expect(markup).toContain('role="status"')
    expect(markup).toContain('Loading preview')
  })
})
