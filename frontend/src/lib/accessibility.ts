export function getPreviewReturnFocus(
  previousFocus: HTMLElement | null,
  fallbackFocus: HTMLElement | null,
): HTMLElement | null {
  if (previousFocus?.isConnected) return previousFocus
  if (!fallbackFocus?.isConnected) return null
  return (
    fallbackFocus.querySelector<HTMLElement>('[data-roving-key]') ??
    fallbackFocus
  )
}

export function getUploadStatusMessage(
  uploading: boolean,
  doneCount: number,
  errorCount: number,
  pendingCount: number,
  uploadableCount: number,
): string {
  if (uploading) {
    return `Uploading files. ${doneCount} of ${uploadableCount} complete.`
  }
  if (doneCount + errorCount === 0 || pendingCount !== errorCount) return ''
  return `Upload finished. ${doneCount} file${doneCount === 1 ? '' : 's'} uploaded${errorCount > 0 ? `, ${errorCount} failed` : ''}.`
}
