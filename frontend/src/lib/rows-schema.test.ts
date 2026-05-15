import { describe, expect, it } from 'vitest'

import { parseRules, type Node } from '@/lib/rows-schema'

function ok(input: unknown): Node[] {
  const r = parseRules(input)
  expect(r.error).toBeNull()
  return r.rules
}
function fail(input: unknown): string {
  const r = parseRules(input)
  expect(r.rules).toEqual([])
  expect(r.error).not.toBeNull()
  return r.error!
}

describe('parseRules — root', () => {
  it('null / undefined → empty rules without error', () => {
    expect(parseRules(null)).toEqual({ rules: [], error: null })
    expect(parseRules(undefined)).toEqual({ rules: [], error: null })
  })

  it('non-array root is an error', () => {
    expect(fail({ foo: 'bar' })).toMatch(/root: expected an array/)
    expect(fail(42)).toMatch(/root: expected an array/)
  })

  it('empty array → empty rules', () => {
    expect(ok([])).toEqual([])
  })
})

describe('atom — string shortcut', () => {
  it('bare string is a default-widget atom', () => {
    expect(ok(['prompt'])).toEqual([{ from: 'prompt' }])
  })

  it('empty string atom errors', () => {
    expect(fail([''])).toMatch(/nodes\[0\]:.*empty/)
  })

  it('selector errors surface with the bad source string', () => {
    expect(fail(['images.[:]'])).toMatch(/invalid selector.*at least one bound/)
  })
})

describe('atom — widget tag sugar', () => {
  it('{ image: "x" } → image atom', () => {
    expect(ok([{ image: 'thumb' }])).toEqual([{ from: 'thumb', show: 'image' }])
  })

  it('{ video: "x", src: "...{value}" } merges options', () => {
    expect(
      ok([{ video: 'clip', src: '../clips/{value}' }]),
    ).toEqual([{ from: 'clip', show: 'video', src: '../clips/{value}' }])
  })

  it('{ highlight: "x", lang: "py" }', () => {
    expect(ok([{ highlight: 'code', lang: 'py' }])).toEqual([
      { from: 'code', show: 'highlight', lang: 'py' },
    ])
  })

  it('{ link: "x" } is a link atom', () => {
    expect(ok([{ link: 'url' }])).toEqual([{ from: 'url', show: 'link' }])
  })

  it('rejects multiple widget tags', () => {
    expect(fail([{ image: 'a', video: 'b' }])).toMatch(/multiple tag keys/)
  })

  it('widget tag value must be a string selector', () => {
    expect(fail([{ image: 42 }])).toMatch(/widget shortcut "image"/)
  })
})

describe('atom — canonical', () => {
  it('passes through canonical default atom', () => {
    expect(ok([{ from: 'prompt', label: 'Prompt' }])).toEqual([
      { from: 'prompt', label: 'Prompt' },
    ])
  })

  it('passes through canonical image atom', () => {
    expect(
      ok([{ from: 'thumb', show: 'image', src: '{value}' }]),
    ).toEqual([{ from: 'thumb', show: 'image', src: '{value}' }])
  })

  it('CDN-style src template passes through', () => {
    expect(
      ok([{ from: 'id', show: 'image', src: 'https://cdn/{value}.png' }]),
    ).toEqual([
      { from: 'id', show: 'image', src: 'https://cdn/{value}.png' },
    ])
  })

  it('omitted src is normal: cell value used as-is at render', () => {
    expect(ok([{ from: 'thumb', show: 'image' }])).toEqual([
      { from: 'thumb', show: 'image' },
    ])
  })

  it('show=default is omitted from canonical output (keeps URL short)', () => {
    expect(ok([{ from: 'x', show: 'default' }])).toEqual([{ from: 'x' }])
  })

  it('rejects unknown show values', () => {
    expect(fail([{ from: 'x', show: 'pdf' }])).toMatch(/"show" must be one of/)
  })

  it('rejects unknown fields', () => {
    expect(fail([{ from: 'x', wat: 1 }])).toMatch(/unknown field "wat" on atom/)
  })
})

describe('atom — widget option constraints', () => {
  it('lang required for highlight', () => {
    expect(fail([{ from: 'code', show: 'highlight' }])).toMatch(
      /"lang" is required for show="highlight"/,
    )
  })

  it('lang rejected on non-highlight', () => {
    expect(fail([{ from: 'x', show: 'image', lang: 'py' }])).toMatch(
      /"lang" only allowed on show="highlight"/,
    )
  })

  it('src rejected on default', () => {
    expect(fail([{ from: 'x', src: '{value}' }])).toMatch(
      /"src" not allowed on show="default"/,
    )
  })

  it('src rejected on highlight', () => {
    expect(fail([{ from: 'x', show: 'highlight', lang: 'js', src: '{value}' }])).toMatch(
      /"src" not allowed on show="highlight"/,
    )
  })

  it('empty src is rejected', () => {
    expect(fail([{ from: 'x', show: 'image', src: '' }])).toMatch(
      /"src" must be a non-empty string/,
    )
  })

  it('maxHeight rejected on image', () => {
    expect(fail([{ from: 'x', show: 'image', maxHeight: '10rem' }])).toMatch(
      /"maxHeight" not allowed on show="image"/,
    )
  })

  it('maxHeight allowed on default / highlight / markdown', () => {
    expect(ok([{ from: 'x', maxHeight: '12rem' }])).toEqual([
      { from: 'x', maxHeight: '12rem' },
    ])
    expect(
      ok([{ from: 'x', show: 'markdown', maxHeight: '20rem' }]),
    ).toEqual([{ from: 'x', show: 'markdown', maxHeight: '20rem' }])
  })
})

describe('atom — fan-out fields require .[*] in selector', () => {
  it('layout rejected without fan-out', () => {
    expect(fail([{ from: 'images', show: 'image', layout: 'grid' }])).toMatch(
      /"layout" requires a fan-out/,
    )
  })

  it('columns rejected without fan-out', () => {
    expect(fail([{ from: 'images', show: 'image', columns: 2 }])).toMatch(
      /"columns" requires a fan-out/,
    )
  })

  it('gap rejected without fan-out', () => {
    expect(fail([{ from: 'images', gap: '1rem' }])).toMatch(
      /"gap" requires a fan-out/,
    )
  })

  it('empty rejected without fan-out', () => {
    expect(fail([{ from: 'images', empty: 'none' }])).toMatch(
      /"empty" requires a fan-out/,
    )
  })

  it('layout/columns/gap/empty allowed when selector fans out', () => {
    expect(
      ok([
        {
          from: 'images.[*]',
          show: 'image',
          layout: 'grid',
          columns: 2,
          gap: '0.5rem',
          empty: 'no images',
        },
      ]),
    ).toEqual([
      {
        from: 'images.[*]',
        show: 'image',
        layout: 'grid',
        columns: 2,
        gap: '0.5rem',
        empty: 'no images',
      },
    ])
  })

  it('columns requires layout="grid" even with fan-out', () => {
    expect(
      fail([{ from: 'images.[*]', show: 'image', columns: 2, layout: 'row' }]),
    ).toMatch(/"columns" only allowed when layout="grid"/)
  })

  it('bogus layout value', () => {
    expect(
      fail([{ from: 'images.[*]', show: 'image', layout: 'masonry' }]),
    ).toMatch(/"layout" must be /)
  })
})

describe('container — row / column / grid', () => {
  it('canonical row', () => {
    const input = [
      {
        kind: 'row',
        children: [{ from: 'prompt' }, { from: 'thumb', show: 'image' }],
      },
    ]
    expect(ok(input)).toEqual(input)
  })

  it('{ row: [...] } is container shortcut sugar', () => {
    expect(ok([{ row: ['prompt', { image: 'thumb' }] }])).toEqual([
      {
        kind: 'row',
        children: [{ from: 'prompt' }, { from: 'thumb', show: 'image' }],
      },
    ])
  })

  it('{ grid: [...], columns: 3 } passes options through', () => {
    expect(ok([{ grid: ['a', 'b'], columns: 3, gap: '0.5rem' }])).toEqual([
      {
        kind: 'grid',
        columns: 3,
        gap: '0.5rem',
        children: [{ from: 'a' }, { from: 'b' }],
      },
    ])
  })

  it('container shortcut value must be array', () => {
    expect(fail([{ row: 'oops' }])).toMatch(
      /container shortcut "row" expects an array/,
    )
  })

  it('object with no tag, no from, no kind, no children → error', () => {
    expect(fail([{ width: '1fr' }])).toMatch(/missing "from", "kind", or tag key/)
  })

  it('canonical grid with columns + gap', () => {
    const input = [
      {
        kind: 'grid',
        columns: 3,
        gap: '1rem',
        children: [{ from: 'a' }, { from: 'b' }, { from: 'c' }],
      },
    ]
    expect(ok(input)).toEqual(input)
  })

  it('children without kind defaults to flow', () => {
    expect(ok([{ children: ['a', 'b'] }])).toEqual([
      { kind: 'flow', children: [{ from: 'a' }, { from: 'b' }] },
    ])
  })

  it('explicit flow container is accepted', () => {
    expect(ok([{ kind: 'flow', children: ['a', 'b'] }])).toEqual([
      { kind: 'flow', children: [{ from: 'a' }, { from: 'b' }] },
    ])
  })

  it('flow tag-key shortcut', () => {
    expect(ok([{ flow: ['a', { image: 'thumb' }] }])).toEqual([
      {
        kind: 'flow',
        children: [{ from: 'a' }, { from: 'thumb', show: 'image' }],
      },
    ])
  })

  it('rejects columns on non-grid container', () => {
    expect(
      fail([{ kind: 'row', columns: 2, children: [] }]),
    ).toMatch(/"columns" only allowed on grid/)
  })

  it('rejects bad column count', () => {
    expect(
      fail([{ kind: 'grid', columns: 0, children: [] }]),
    ).toMatch(/"columns" must be a positive integer/)
  })

  it('children must be an array', () => {
    expect(fail([{ kind: 'row', children: 'oops' }])).toMatch(
      /"children" is required and must be an array/,
    )
  })

  it('nested array literal becomes implicit flow', () => {
    expect(
      ok([{ kind: 'row', children: [['a', 'b'], 'c'] }]),
    ).toEqual([
      {
        kind: 'row',
        children: [
          {
            kind: 'flow',
            children: [{ from: 'a' }, { from: 'b' }],
          },
          { from: 'c' },
        ],
      },
    ])
  })

  it('error path points at the bad nested child', () => {
    const err = fail([
      { kind: 'row', children: ['ok', { from: 'images.[:]', show: 'image' }] },
    ])
    expect(err).toMatch(/nodes\[0\]\.children\[1\]/)
    expect(err).toMatch(/invalid selector/)
  })

  it('non-container kind rejected', () => {
    expect(fail([{ kind: 'image', from: 'x' }])).toMatch(
      /"kind" must be one of flow \| row \| column \| grid/,
    )
  })
})

describe('rejects unrecognized kinds and stray fields', () => {
  it('non-container kind on object with column-like fields', () => {
    expect(fail([{ column: 'x', kind: 'pdf' }])).toMatch(
      /"kind" must be one of flow \| row \| column \| grid/,
    )
  })

  it('stray `column` field on a canonical atom', () => {
    expect(fail([{ kind: 'text', from: 'prompt', column: 'x' }])).toMatch(
      /"kind" must be one of flow \| row \| column \| grid/,
    )
  })
})

describe('idempotency', () => {
  it('parsing canonical output yields the same rules', () => {
    const sugar = [
      {
        kind: 'row',
        children: [
          { from: 'prompt', width: '1fr' },
          {
            from: 'images.[*].[path]',
            show: 'image',
            width: '360px',
            layout: 'grid',
            columns: 2,
          },
        ],
      },
      {
        from: 'clip_path',
        show: 'video',
        src: '../clips/{value}',
        label: 'Source clip',
      },
      {
        from: 'metadata',
        show: 'highlight',
        lang: 'json',
        label: 'Raw metadata',
      },
    ]
    const first = ok(sugar)
    const second = ok(JSON.parse(JSON.stringify(first)))
    expect(second).toEqual(first)
  })
})

describe('reference example from spec §8', () => {
  it('sugar form desugars to the documented canonical', () => {
    const sugar = [
      {
        row: [
          'prompt',
          {
            image: 'images.[*].[path]',
            width: '360px',
            layout: 'grid',
            columns: 2,
          },
        ],
      },
      { video: 'clip_path', src: '../clips/{value}', label: 'Source clip' },
      { highlight: 'metadata', lang: 'json', label: 'Raw metadata' },
      { image: 'thumbnails.[0]', label: 'Cover image' },
      'description.[0:200]',
    ]
    expect(ok(sugar)).toEqual([
      {
        kind: 'row',
        children: [
          { from: 'prompt' },
          {
            from: 'images.[*].[path]',
            show: 'image',
            width: '360px',
            layout: 'grid',
            columns: 2,
          },
        ],
      },
      {
        from: 'clip_path',
        show: 'video',
        src: '../clips/{value}',
        label: 'Source clip',
      },
      {
        from: 'metadata',
        show: 'highlight',
        lang: 'json',
        label: 'Raw metadata',
      },
      { from: 'thumbnails.[0]', show: 'image', label: 'Cover image' },
      { from: 'description.[0:200]' },
    ])
  })
})
