export interface FileEntry {
  key: string
  size: number
  last_modified: string | null
  is_dir: boolean
}

export interface ListResult {
  entries: FileEntry[]
  next_token: string | null
}

export interface FileMeta {
  path: string
  size: number
  etag: string | null
  content_type: string | null
  last_modified: string | null
  is_dir: boolean
}

export interface ApiErrorBody {
  error?: string
  message?: string
}

export interface StorageDescriptor {
  name: string
  type: 'local' | 's3'
}

export interface StoragesResponse {
  storages: StorageDescriptor[]
  default: string
}

export interface ServerInfo {
  hostname: string
}
