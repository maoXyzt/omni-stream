// Must stay in sync with MAX_PUT_BYTES in src/main.rs:44.
// The backend reads the entire body into memory before writing, so this is a
// hard server-side limit that the frontend enforces early to avoid a wasted
// network round-trip on oversized files.
export const MAX_PUT_BYTES = 16 * 1024 * 1024
