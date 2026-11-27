//! Quote decimal values before JSON parsing can round their significands.
use arrow_array::{Array, PrimitiveArray, types::*};
use arrow_json::writer::{Encoder, EncoderFactory, EncoderOptions, NullableEncoder};
use arrow_schema::{ArrowError, DataType, FieldRef};

#[derive(Debug)]
pub(super) struct DecimalStrings;

struct DecimalEncoder<'a, T: DecimalType>(&'a PrimitiveArray<T>);

impl<T: DecimalType> Encoder for DecimalEncoder<'_, T> {
  fn encode(&mut self, index: usize, out: &mut Vec<u8>) {
    out.push(b'"');
    out.extend_from_slice(self.0.value_as_string(index).as_bytes());
    out.push(b'"');
  }
}

impl EncoderFactory for DecimalStrings {
  fn make_default_encoder<'a>(
    &self,
    _: &'a FieldRef,
    array: &'a dyn Array,
    _: &'a EncoderOptions,
  ) -> Result<Option<NullableEncoder<'a>>, ArrowError> {
    use arrow_array::cast::AsArray;
    let encoder: Box<dyn Encoder> = match array.data_type() {
      DataType::Decimal32(..) => Box::new(DecimalEncoder(array.as_primitive::<Decimal32Type>())),
      DataType::Decimal64(..) => Box::new(DecimalEncoder(array.as_primitive::<Decimal64Type>())),
      DataType::Decimal128(..) => Box::new(DecimalEncoder(array.as_primitive::<Decimal128Type>())),
      DataType::Decimal256(..) => Box::new(DecimalEncoder(array.as_primitive::<Decimal256Type>())),
      _ => return Ok(None),
    };
    Ok(Some(NullableEncoder::new(encoder, array.nulls().cloned())))
  }
}
