import { describe, expect, it } from 'vitest'

import { buildTitle } from '@/lib/document-title'

describe('buildTitle', () => {
  it('falls back to bare brand when nothing is known', () => {
    expect(buildTitle('/', undefined)).toBe('OmniStream')
  })

  it('renders just the host on the root redirect once /api/server resolves', () => {
    expect(buildTitle('/', 'myhost')).toBe('myhost · OmniStream')
  })

  it('renders storage@host at the storage root', () => {
    expect(buildTitle('/s/my-bucket', 'myhost')).toBe('my-bucket@myhost · OmniStream')
  })

  it('renders storage/context first inside a directory', () => {
    expect(buildTitle('/s/my-bucket/data/2025/06', 'myhost')).toBe(
      'my-bucket/data · 06 · myhost · OmniStream',
    )
  })

  it('renders the rows view the same way as the file list view', () => {
    expect(buildTitle('/r/my-bucket/data/file.csv', 'myhost')).toBe(
      'my-bucket/data · file.csv · myhost · OmniStream',
    )
  })

  it('drops storage@ prefix when no host is known yet', () => {
    expect(buildTitle('/s/my-bucket/a/b', undefined)).toBe('my-bucket/a · b · OmniStream')
  })

  it('shortens FQDN hostnames to the first label', () => {
    expect(buildTitle('/s/bkt', 'dev.internal.corp.example.com')).toBe('bkt@dev · OmniStream')
  })

  it('keeps IPv4 hostnames verbatim instead of dropping octets', () => {
    expect(buildTitle('/s/bkt', '192.168.1.100')).toBe('bkt@192.168.1.100 · OmniStream')
  })

  it('keeps IPv6 hostnames verbatim', () => {
    expect(buildTitle('/s/bkt', 'fe80::1')).toBe('bkt@fe80::1 · OmniStream')
  })

  it('decodes percent-encoded route segments', () => {
    expect(buildTitle('/s/bkt/my%20folder/a%20b.txt', 'h')).toBe(
      'bkt/my folder · a b.txt · h · OmniStream',
    )
  })

  it('strips trailing slashes when computing the leaf', () => {
    expect(buildTitle('/s/bkt/data/2025/', 'h')).toBe('bkt/data · 2025 · h · OmniStream')
  })

  it('returns the raw segment when decoding fails', () => {
    // "%E0%A4%A" is a truncated UTF-8 sequence; decodeURIComponent throws.
    expect(buildTitle('/s/bkt/%E0%A4%A', 'h')).toBe('bkt/%E0%A4%A · h · OmniStream')
  })

  it('falls back to brand-only for unrecognized routes', () => {
    expect(buildTitle('/unknown/path', 'h')).toBe('h · OmniStream')
  })
})
