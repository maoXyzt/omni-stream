/**
 * Resolve a glTF sidecar relative to the model while keeping it inside the
 * same storage key namespace. Parent segments are rejected because the
 * backend wildcard route must never receive an ambiguous path.
 */
export function joinSidecarKey(fileKey: string, relativeUrl: string): string {
  const pathPart = relativeUrl.split(/[?#]/, 1)[0] ?? ''
  if (!pathPart || pathPart.startsWith('/') || pathPart.startsWith('//')) {
    throw new Error('The model references an unsupported absolute sidecar URL.')
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(pathPart)) {
    throw new Error('The model references an unsupported external sidecar URL.')
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathPart)
  } catch {
    throw new Error('The model references a malformed sidecar URL.')
  }
  if (
    decodedPath.includes('\\') ||
    decodedPath.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(decodedPath) ||
    [...decodedPath].some((char) => {
      const code = char.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f
    })
  ) {
    throw new Error('The model references an invalid sidecar path.')
  }

  const directory = fileKey.slice(0, fileKey.lastIndexOf('/') + 1)
  const segments = decodedPath.split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('The model references a sidecar outside its directory.')
  }
  if (segments.length === 0) {
    throw new Error('The model references an empty sidecar path.')
  }
  return `${directory}${segments.join('/')}`
}
