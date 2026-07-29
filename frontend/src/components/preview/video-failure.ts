export interface VideoFailure {
  kind: 'unsupported' | 'load' | 'transcode'
  title: string
  description: string
}

export function describeTranscodeFailure(): VideoFailure {
  return {
    kind: 'transcode',
    title: 'Compatible playback failed.',
    description:
      'The server could not convert this video. Try again or download the original.',
  }
}

export function describeVideoFailure(code?: number): VideoFailure {
  // HTML MediaError: 3 = decode failed, 4 = source/format unsupported.
  if (code === 3 || code === 4) {
    return {
      kind: 'unsupported',
      title: "This browser can't play this video.",
      description:
        "The video may use a codec this browser doesn't support. Download it and open it in a local video player.",
    }
  }
  return {
    kind: 'load',
    title: 'Failed to load video.',
    description: 'Check your connection and try again.',
  }
}
