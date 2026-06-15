import { describe, expect, it } from 'vitest'

import { buildFaviconHref } from '@/lib/favicon'
import type { StorageDescriptor } from '@/types/storage'

const local: StorageDescriptor = {
  name: 'local-fs',
  type: 'local',
  valid: true,
  writeable: false,
  local: { root_path: '/data' },
}

const s3Single: StorageDescriptor = {
  name: 'my-bucket',
  type: 's3',
  valid: true,
  writeable: false,
  s3: { bucket: 'my-bucket', region: 'us-east-1' },
}

const s3Multi: StorageDescriptor = {
  name: 'all-buckets',
  type: 's3',
  valid: true,
  writeable: false,
  s3: { bucket: null },
}

const roster = [local, s3Single, s3Multi]

describe('buildFaviconHref', () => {
  it('falls back to the brand favicon on the root redirect', () => {
    expect(buildFaviconHref('/', roster)).toBe('/favicon.svg')
  })

  it('falls back when the storages query has not resolved yet', () => {
    expect(buildFaviconHref('/s/local-fs', undefined)).toBe('/favicon.svg')
  })

  it('falls back when the route names a storage not in the roster', () => {
    expect(buildFaviconHref('/s/ghost', roster)).toBe('/favicon.svg')
  })

  it('returns the local variant on a local storage route', () => {
    expect(buildFaviconHref('/s/local-fs/data/2025', roster)).toBe('/favicon-local.svg')
  })

  it('returns the s3 variant on a single-bucket S3 route', () => {
    expect(buildFaviconHref('/s/my-bucket', roster)).toBe('/favicon-s3.svg')
  })

  it('returns the s3 variant on a multi-bucket S3 route', () => {
    expect(buildFaviconHref('/s/all-buckets/some-bucket/key', roster)).toBe('/favicon-s3.svg')
  })

  it('applies to the rows view the same as the list view', () => {
    expect(buildFaviconHref('/r/local-fs/data/file.csv', roster)).toBe('/favicon-local.svg')
    expect(buildFaviconHref('/r/my-bucket/data/file.csv', roster)).toBe('/favicon-s3.svg')
  })

  it('decodes percent-encoded storage names', () => {
    const weird: StorageDescriptor = {
      name: 'my local',
      type: 'local',
      valid: true,
      writeable: false,
      local: { root_path: '/x' },
    }
    expect(buildFaviconHref('/s/my%20local/x', [weird])).toBe('/favicon-local.svg')
  })

  it('returns the brand favicon for unrecognized routes', () => {
    expect(buildFaviconHref('/unknown/path', roster)).toBe('/favicon.svg')
  })
})
