export interface SafetensorsTensor {
  name: string
  dtype: string
  shape: string[]
  elements: string
  bytes: string
}

export interface SafetensorsDtypeSummary {
  dtype: string
  tensor_count: number
  elements: string
  bytes: string
}

export interface SafetensorsMetadata {
  metadata: Record<string, string>
  file_bytes: string
  header_bytes: number
  tensor_count: number
  total_elements: string
  weight_bytes: string
  dtypes: SafetensorsDtypeSummary[]
  tensors: SafetensorsTensor[]
}
