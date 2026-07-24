export function shouldKeepPreviousRowsPage(
  previousQueryKey: readonly unknown[] | undefined,
  storage: string | undefined,
  fileKey: string,
): boolean {
  return (
    previousQueryKey?.[1] === (storage ?? null) &&
    previousQueryKey[2] === fileKey
  )
}
