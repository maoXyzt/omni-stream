import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { InvisiblePathLabel } from '@/components/InvisiblePathLabel'

describe('InvisiblePathLabel', () => {
  it('keeps the path text accessible and labels only the warning icon', () => {
    const markup = renderToStaticMarkup(
      <InvisiblePathLabel value={'info\u200b'} showInvisible={false} />,
    )

    expect(markup).toContain('info\u200b')
    expect(markup).toContain('role="img"')
    expect(markup).toContain(
      'aria-label="Contains invisible characters: U+200B ZERO WIDTH SPACE"',
    )
    expect(markup).toContain('tabindex="0"')
    expect(markup.match(/aria-label=/g)).toHaveLength(1)
  })

  it('renders a visible code point marker when enabled', () => {
    const markup = renderToStaticMarkup(
      <InvisiblePathLabel value={'info\u200b'} showInvisible />,
    )

    expect(markup).toContain('info⟦U+200B⟧')
  })
})
