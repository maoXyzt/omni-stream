import type { StorageDescriptor } from '@/types/storage'

/// True when the configured storage exposes top-level buckets directly
/// (S3 in multi-bucket mode — `s3.bucket` is `null` server-side, surfaced
/// as `null` on the descriptor). In this mode the very first path
/// segment IS the bucket name and the root listing renders buckets as
/// entries, so the UI swaps the folder icon for a bucket icon at that
/// depth. Local FS storages and S3 storages pinned to a single bucket
/// never qualify — for them every directory is just a folder.
export function isMultiBucketS3(
  storage: StorageDescriptor | undefined,
): boolean {
  if (!storage || storage.type !== 's3') return false
  return storage.s3?.bucket === null
}

/// Companion to `isMultiBucketS3` for individual list entries: returns
/// true only for directory entries that sit at the storage root of a
/// multi-bucket S3 — those entries are the buckets themselves. Used by
/// FileList / FileTile / Sidebar to decide whether to render the bucket
/// or the folder icon.
export function isBucketEntry(
  storage: StorageDescriptor | undefined,
  prefix: string,
  isDir: boolean,
): boolean {
  if (!isDir) return false
  if (!isMultiBucketS3(storage)) return false
  return prefix === ''
}
