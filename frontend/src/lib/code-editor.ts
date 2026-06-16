import EditorImport from 'react-simple-code-editor'

// react-simple-code-editor 0.14.x ships a CJS bundle that sets
// `exports.default = Editor`. Depending on the bundler's ESM interop the bare
// default import arrives either as the component itself or wrapped as
// `{ default: <Component> }` — and in the wrapped case React rejects it with
// "Element type is invalid: …got: object" (the minified prod form is React
// error #130). Unwrap once here so every `<Editor …>` call site across the app
// renders correctly in dev and prod alike.
export const Editor =
  (EditorImport as unknown as { default?: typeof EditorImport }).default ??
  EditorImport
