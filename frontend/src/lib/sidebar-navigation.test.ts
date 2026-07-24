import { describe, expect, it } from 'vitest'

import { getSidebarEntryPresentation } from '@/lib/sidebar-navigation'

describe('getSidebarEntryPresentation', () => {
  it('derives labels and current-folder state for quick access entries', () => {
    expect(
      getSidebarEntryPresentation(
        { storage: 'photos', key: '2026/', type: 'folder' },
        'photos',
        '2026/events/',
      ),
    ).toEqual({
      label: '2026',
      location: 'photos · 2026/',
      isActive: true,
      isCurrent: false,
    })

    expect(
      getSidebarEntryPresentation(
        { storage: 'photos', key: '', type: 'folder' },
        'photos',
        '',
      ),
    ).toMatchObject({ label: 'photos', isActive: true, isCurrent: true })

    expect(
      getSidebarEntryPresentation(
        { storage: 'photos', key: 'cover.jpg', type: 'file' },
        'photos',
        '',
      ),
    ).toMatchObject({ isActive: false, isCurrent: false })
  })
})
