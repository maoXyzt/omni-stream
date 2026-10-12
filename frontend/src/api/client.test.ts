import { describe, expect, it } from 'vitest'

import { ApiError, formatApiErrorMessage } from './client'

describe('API permission errors', () => {
  it('shows an actionable message for unreadable filesystem paths', () => {
    const payload = {
      code: 'FILESYSTEM_PERMISSION_DENIED',
      message: 'The server does not have permission to access this path.',
      hint: 'Check the storage root and file permissions, then try again.',
    }

    expect(formatApiErrorMessage(403, payload.message, payload)).toContain('Check the storage root')
    expect(new ApiError(403, payload.message, payload).message).toContain('file permissions')
  })

  it('keeps ordinary API error messages unchanged', () => {
    expect(formatApiErrorMessage(404, 'File not found', { code: 'NOT_FOUND' })).toBe('File not found')
  })
})
