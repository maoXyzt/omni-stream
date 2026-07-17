import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  getPreviewReturnFocus,
  getUploadStatusMessage,
} from '@/lib/accessibility'

import { PreviewSpinner } from './PreviewSpinner'

describe('P0 preview safety', () => {
  it('announces the shared preview loading state', () => {
    const markup = renderToStaticMarkup(<PreviewSpinner />)

    expect(markup).toContain('role="status"')
    expect(markup).toContain('Loading preview')
  })

  it('falls back to the current file list when the opener was removed', () => {
    const connectedOpener = { isConnected: true } as HTMLElement
    const removedOpener = { isConnected: false } as HTMLElement
    const firstEntry = { isConnected: true } as HTMLElement
    const fileList = {
      isConnected: true,
      querySelector: () => firstEntry,
    } as unknown as HTMLElement

    expect(getPreviewReturnFocus(connectedOpener, fileList)).toBe(
      connectedOpener,
    )
    expect(getPreviewReturnFocus(removedOpener, fileList)).toBe(firstEntry)
  })

  it('announces failures only after no uploads are waiting', () => {
    expect(getUploadStatusMessage(false, 1, 1, 1, 2)).toBe(
      'Upload finished. 1 file uploaded, 1 failed.',
    )
    expect(getUploadStatusMessage(false, 1, 0, 1, 2)).toBe('')
    expect(getUploadStatusMessage(false, 0, 2, 2, 2)).toBe(
      'Upload finished. 0 files uploaded, 2 failed.',
    )
  })
})
