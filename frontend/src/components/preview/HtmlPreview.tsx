import { useMemo } from 'react'

import { rawUrl } from '@/api/storage'
import { htmlPreviewDocument } from '@/lib/html-preview'
import { basenameOf } from '@/lib/path'

import type { PreviewerProps } from './types'

interface Props extends PreviewerProps {
  body: string
}

export function HtmlPreview({ body, fileKey, src, storage }: Props) {
  const resourceUrl = new URL(
    storage ? rawUrl(fileKey, storage) : src,
    window.location.href,
  ).href
  const document = useMemo(
    () => htmlPreviewDocument(body, resourceUrl),
    [body, resourceUrl],
  )

  // Reuse the authenticated text fetch: even an S3 object labelled text/plain
  // renders as HTML. Never combine allow-scripts with allow-same-origin here:
  // the preview must not read the app's DOM or its stored bearer token.
  return (
    <iframe
      title={`HTML preview: ${basenameOf(fileKey)}`}
      srcDoc={document}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  )
}
