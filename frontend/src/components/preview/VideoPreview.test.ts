import { describe, expect, it } from 'vitest'

import {
  describeTranscodeFailure,
  describeVideoFailure,
} from './video-failure'

describe('describeVideoFailure', () => {
  it.each([3, 4])('explains unsupported media error %i', (code) => {
    const failure = describeVideoFailure(code)

    expect(failure.kind).toBe('unsupported')
    expect(failure.description).toContain('codec')
    expect(failure.description).toContain('local video player')
  })

  it.each([1, 2, undefined])('keeps media error %s retryable', (code) => {
    expect(describeVideoFailure(code).kind).toBe('load')
  })

  it('explains when server-side compatible playback is unavailable', () => {
    const failure = describeVideoFailure(4, false)

    expect(failure.description).toContain('FFmpeg')
  })

  it('explains a failed compatible stream without hiding the original', () => {
    const failure = describeTranscodeFailure()

    expect(failure.kind).toBe('transcode')
    expect(failure.description).toContain('download the original')
  })
})
