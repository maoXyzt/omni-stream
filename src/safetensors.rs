//! Bounded, header-only inspection of Safetensors files.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::error::AppError;

/// Counts, dimensions and byte sizes are decimal strings to preserve u64
/// precision in browser clients. Tensor counts are bounded small integers.
#[derive(Debug, Serialize)]
pub struct TensorMetadata {
  pub name: String,
  pub dtype: String,
  pub shape: Vec<String>,
  pub elements: String,
  pub bytes: String,
}

#[derive(Debug, Serialize)]
pub struct DtypeSummary {
  pub dtype: String,
  pub tensor_count: usize,
  pub elements: String,
  pub bytes: String,
}

#[derive(Debug, Serialize)]
pub struct SafetensorsMetadata {
  pub metadata: BTreeMap<String, String>,
  pub file_bytes: String,
  pub header_bytes: usize,
  pub tensor_count: usize,
  pub total_elements: String,
  pub weight_bytes: String,
  pub dtypes: Vec<DtypeSummary>,
  pub tensors: Vec<TensorMetadata>,
}

const MAX_TENSORS: usize = 50_000;
const MAX_RANK: usize = 32;

/// Parse the JSON header without touching the tensor data buffer.
///
/// The offsets are checked against the complete file size so the endpoint can
/// report trustworthy byte totals even though it only fetched the header.
pub fn parse_header(header: &[u8], file_bytes: u64) -> Result<SafetensorsMetadata, AppError> {
  let header_len = u64::try_from(header.len())
    .map_err(|_| invalid("Safetensors header length does not fit in u64"))?;
  let data_start = 8_u64
    .checked_add(header_len)
    .ok_or_else(|| invalid("Safetensors header length overflow"))?;
  let data_bytes = file_bytes
    .checked_sub(data_start)
    .ok_or_else(|| invalid("file is shorter than its Safetensors header"))?;

  let value: Value = serde_json::from_slice(header)
    .map_err(|e| invalid(format!("invalid Safetensors header JSON: {e}")))?;
  let object = value
    .as_object()
    .ok_or_else(|| invalid("Safetensors header must be a JSON object"))?;

  let mut metadata = BTreeMap::new();
  let mut tensors = Vec::with_capacity(object.len());
  let mut ranges = Vec::with_capacity(object.len());

  for (name, value) in object {
    if name == "__metadata__" {
      let entries = value
        .as_object()
        .ok_or_else(|| invalid("Safetensors __metadata__ must be an object"))?;
      for (key, value) in entries {
        let value = value
          .as_str()
          .ok_or_else(|| invalid(format!("Safetensors metadata '{key}' must be a string")))?;
        metadata.insert(key.clone(), value.to_owned());
      }
      continue;
    }

    if tensors.len() >= MAX_TENSORS {
      return Err(invalid(format!(
        "Safetensors header contains more than {MAX_TENSORS} tensors"
      )));
    }
    let tensor = value
      .as_object()
      .ok_or_else(|| invalid(format!("tensor '{name}' must be an object")))?;
    let dtype = tensor
      .get("dtype")
      .and_then(Value::as_str)
      .ok_or_else(|| invalid(format!("tensor '{name}' has no string dtype")))?;
    if dtype_bits(dtype).is_none() {
      return Err(invalid(format!(
        "tensor '{name}' has unsupported dtype '{dtype}'"
      )));
    }

    let shape_value = tensor
      .get("shape")
      .and_then(Value::as_array)
      .ok_or_else(|| invalid(format!("tensor '{name}' has no shape array")))?;
    if shape_value.len() > MAX_RANK {
      return Err(invalid(format!(
        "tensor '{name}' rank exceeds the {MAX_RANK} dimension limit"
      )));
    }
    let mut shape = Vec::with_capacity(shape_value.len());
    let mut elements = 1_u64;
    for dimension in shape_value {
      let dimension = dimension.as_u64().ok_or_else(|| {
        invalid(format!(
          "tensor '{name}' shape must contain non-negative integers"
        ))
      })?;
      elements = elements
        .checked_mul(dimension)
        .ok_or_else(|| invalid(format!("tensor '{name}' element count overflows u64")))?;
      shape.push(dimension.to_string());
    }

    let offsets = tensor
      .get("data_offsets")
      .and_then(Value::as_array)
      .ok_or_else(|| invalid(format!("tensor '{name}' has no data_offsets array")))?;
    if offsets.len() != 2 {
      return Err(invalid(format!(
        "tensor '{name}' data_offsets must contain exactly two integers"
      )));
    }
    let start = offsets[0]
      .as_u64()
      .ok_or_else(|| invalid(format!("tensor '{name}' start offset is invalid")))?;
    let end = offsets[1]
      .as_u64()
      .ok_or_else(|| invalid(format!("tensor '{name}' end offset is invalid")))?;
    if end < start || end > data_bytes {
      return Err(invalid(format!(
        "tensor '{name}' data_offsets [{start}, {end}] exceed the {data_bytes}-byte data buffer"
      )));
    }
    let bytes = end - start;
    let bits = dtype_bits(dtype).ok_or_else(|| invalid("unsupported dtype"))?;
    let expected_bits = u128::from(elements) * u128::from(bits);
    let expected_bytes = if bits < 8 {
      expected_bits.div_ceil(8)
    } else {
      expected_bits / 8
    };
    if expected_bytes != u128::from(bytes) {
      return Err(invalid(format!(
        "tensor '{name}' shape and dtype disagree with data_offsets"
      )));
    }
    tensors.push(TensorMetadata {
      name: name.clone(),
      dtype: dtype.to_owned(),
      shape,
      elements: elements.to_string(),
      bytes: bytes.to_string(),
    });
    ranges.push((start, end, name.clone()));
  }

  ranges.sort_by_key(|(start, end, _)| (*start, *end));
  let mut cursor = 0_u64;
  for (start, end, name) in &ranges {
    if *start != cursor {
      return Err(invalid(format!(
        "tensor '{name}' leaves a gap or overlaps another tensor at byte {cursor}"
      )));
    }
    cursor = *end;
  }
  if cursor != data_bytes {
    return Err(invalid(format!(
      "tensor data covers {cursor} bytes, but the file contains {data_bytes} data bytes"
    )));
  }

  let mut total_elements = 0_u64;
  let mut weight_bytes = 0_u64;
  let mut summaries = BTreeMap::<String, (usize, u64, u64)>::new();
  for tensor in &tensors {
    let elements = tensor
      .elements
      .parse::<u64>()
      .map_err(|_| invalid("internal Safetensors element count conversion failed"))?;
    let bytes = tensor
      .bytes
      .parse::<u64>()
      .map_err(|_| invalid("internal Safetensors byte count conversion failed"))?;
    total_elements = total_elements
      .checked_add(elements)
      .ok_or_else(|| invalid("total Safetensors element count overflows u64"))?;
    weight_bytes = weight_bytes
      .checked_add(bytes)
      .ok_or_else(|| invalid("total Safetensors byte count overflows u64"))?;
    let summary = summaries.entry(tensor.dtype.clone()).or_default();
    summary.0 += 1;
    summary.1 = summary
      .1
      .checked_add(elements)
      .ok_or_else(|| invalid("Safetensors dtype element count overflows u64"))?;
    summary.2 = summary
      .2
      .checked_add(bytes)
      .ok_or_else(|| invalid("Safetensors dtype byte count overflows u64"))?;
  }

  let dtypes = summaries
    .into_iter()
    .map(|(dtype, (tensor_count, elements, bytes))| DtypeSummary {
      dtype,
      tensor_count,
      elements: elements.to_string(),
      bytes: bytes.to_string(),
    })
    .collect();

  Ok(SafetensorsMetadata {
    metadata,
    file_bytes: file_bytes.to_string(),
    header_bytes: header.len(),
    tensor_count: tensors.len(),
    total_elements: total_elements.to_string(),
    weight_bytes: weight_bytes.to_string(),
    dtypes,
    tensors,
  })
}

fn invalid(message: impl Into<String>) -> AppError {
  AppError::InvalidModel(message.into())
}

/// Bits per element for the dtypes currently defined by the Safetensors
/// format. The value is used as a whitelist; byte totals come from offsets so
/// packed 4-bit/6-bit formats and padding remain accurate.
fn dtype_bits(dtype: &str) -> Option<u16> {
  Some(match dtype {
    "BOOL" | "U8" | "I8" => 8,
    "F8_E5M2" | "F8_E4M3" | "F8_E4M3FN" | "F8_E4M3FNUZ" | "F8_E5M2FNUZ" | "F8_E8M0FNU" => 8,
    "F4" => 4,
    "F6_E2M3" | "F6_E3M2" => 6,
    "U16" | "I16" | "F16" | "BF16" => 16,
    "U32" | "I32" | "F32" => 32,
    "U64" | "I64" | "F64" | "C64" => 64,
    "C128" => 128,
    _ => return None,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reports_embedding_metadata_without_tensor_data() {
    let header = br#"{"__metadata__":{"format":"pt"},"qwen3vl_32b":{"dtype":"BF16","shape":[50,5120],"data_offsets":[0,512000]}}"#;
    let report = parse_header(header, 8 + header.len() as u64 + 512_000).unwrap();
    assert_eq!(report.metadata["format"], "pt");
    assert_eq!(report.tensor_count, 1);
    assert_eq!(report.total_elements, "256000");
    assert_eq!(report.weight_bytes, "512000");
    assert_eq!(report.tensors[0].name, "qwen3vl_32b");
    assert_eq!(report.tensors[0].shape, ["50", "5120"]);
    assert_eq!(report.dtypes[0].dtype, "BF16");
    assert_eq!(report.dtypes[0].bytes, "512000");
  }

  #[test]
  fn accepts_scalar_tensor_and_empty_metadata() {
    let header = br#"{"scalar":{"dtype":"F32","shape":[],"data_offsets":[0,4]}}"#;
    let report = parse_header(header, 8 + header.len() as u64 + 4).unwrap();
    assert_eq!(report.tensors[0].shape, Vec::<String>::new());
    assert_eq!(report.tensors[0].elements, "1");
  }

  #[test]
  fn accepts_empty_tensor_before_data_at_same_offset() {
    let header = br#"{"a":{"dtype":"U8","shape":[1],"data_offsets":[0,1]},"z":{"dtype":"U8","shape":[0],"data_offsets":[0,0]}}"#;
    assert!(parse_header(header, 8 + header.len() as u64 + 1).is_ok());
  }

  #[test]
  fn rejects_shape_byte_mismatch() {
    let header = br#"{"a":{"dtype":"F32","shape":[2],"data_offsets":[0,4]}}"#;
    assert!(parse_header(header, 8 + header.len() as u64 + 4).is_err());
  }

  #[test]
  fn accepts_packed_low_bit_tensor_with_partial_byte() {
    let header = br#"{"a":{"dtype":"F4","shape":[3],"data_offsets":[0,2]}}"#;
    assert!(parse_header(header, 8 + header.len() as u64 + 2).is_ok());
  }

  #[test]
  fn rejects_non_contiguous_tensor_offsets() {
    let header = br#"{"a":{"dtype":"U8","shape":[2],"data_offsets":[1,3]}}"#;
    let error = parse_header(header, 8 + header.len() as u64 + 3).unwrap_err();
    assert!(error.to_string().contains("gap or overlaps"));
  }
}
