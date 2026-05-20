# OmniStream

[中文](README.md) · **English**

**A single-binary, streaming file browser and previewer** — point it at any local directory or S3-compatible object storage (MinIO / OSS / Ceph / R2 / …) and it instantly exposes them as a browsable, previewable HTTP service. Open it in a browser to walk directories, view images, stream video, and read code — no client to install, no extra frontend or reverse proxy to wire up. The backend is built on `axum + tokio + aws-sdk-s3`, with one `StorageBackend` trait abstracting over every supported backend.

**A ready-to-use React SPA is bundled into the binary.** Once started, opening `http://<host>:<port>/` in a browser lets you walk directories, lazy-load thumbnails, and preview files in place — no extra static-file server or object browser required. Preview supports:

- **Images** — png / jpg / gif / webp / avif / bmp / svg / ico
- **Video** — mp4 / webm / mov / mkv / m4v / ogv, with `Range`-based seeking
- **Text / code** — syntax highlighting by extension: json / yaml / toml / md /
  rs / ts / py / go / sql / shell / proto, and many more
- **Anything else** — generic fallback: icon + metadata + the browser's built-in viewer

> Previewing files on S3 / S3-compatible storage requires the configured access key to hold both **`s3:GetObject`** (preview / download / HEAD) and **`s3:ListBucket`** (directory browsing / thumbnail listing). Missing either yields a 403 on the corresponding action. The local filesystem backend has no such requirement, but is restricted to the directory configured as `local.root_path`.

HTTP API (the bundled SPA is built on top of these — `curl` or your own client works just as well):

- `GET /api/list?prefix=&page_token=&skip_pages=` — browse a directory; optional `skip_pages` makes the server walk N pages internally and return the target page plus every intermediate token, so jumping to page N takes one round-trip instead of N
- `GET /api/stat/{*key}` — fetch file metadata
- `GET /api/proxy/{*key}` — stream the file, transparently forwarding `Range`, returning 200 / 206 as appropriate
- Embedded SPA fallback — anything not under `/api/*` falls back to `index.html`, so client-side routing just works

---

## 1. Install

**Recommended**: install via cargo. The binary lands in `~/.cargo/bin/` (already on `$PATH`), so you can invoke it directly as `omni-stream`:

```bash
cargo install omni-stream    # requires Rust 1.91+
```

Or download a pre-built binary from GitHub Releases: <https://github.com/maoXyzt/omni-stream/releases/latest>.
Three targets are published — `x86_64-unknown-linux-gnu` / `x86_64-unknown-linux-musl` /
`aarch64-apple-darwin`. (Windows users can build from source). For pre-built binaries,
extract, mark `omni-stream` executable, and put it on `$PATH` if you like.

> Building from source, hacking on the frontend / backend, or contributing? See [docs/development_guide.md](docs/development_guide.md). The release process lives in [docs/how_to_release.md](docs/how_to_release.md).

## 2. Configuration

`config.toml` lookup order (first hit wins):

1. `$OMNI_CONFIG` (absolute path, highest priority)
2. `$XDG_CONFIG_HOME/omni-stream/config.toml`
3. `directories::ProjectDirs` platform default (macOS: `~/Library/Application Support/omni-stream/`; Linux: `~/.config/omni-stream/`)
4. `./config.toml` (current directory)

`config.example.toml` in the repo root works as a template. A minimal config:

```toml
[server]
host = "127.0.0.1"
port = 8080

[[storages]]
name = "local-data"
type = "local"
active = true
local = { root_path = "/var/lib/omni-stream" }
```

Or S3 / S3-compatible (MinIO / OSS):

```toml
[[storages]]
name = "production-s3"
type = "s3"
active = true
s3 = { endpoint = "http://minio.local:9000", bucket = "data", access_key = "...", secret_key = "...", region = "us-east-1" }
```

> Multiple `[[storages]]` entries can coexist; on startup the one with `active = true` wins, and if none is active the first entry is used.
> The frontend also lets you switch between them at runtime.

**Environment overrides** (prefix `OMNI_`, separator `_`):

| Variable | Effect |
| --- | --- |
| `OMNI_SERVER_HOST` | overrides `server.host` |
| `OMNI_SERVER_PORT` | overrides `server.port` |
| `OMNI_AUTH_ENABLED` | overrides `auth.enabled` (`true` / `false`) |
| `OMNI_AUTH_TOKEN` | overrides `auth.token` (recommended for keeping the secret out of the config file) |
| `OMNI_CONFIG` | force a specific absolute `config.toml` path |
| `RUST_LOG` | tracing filter, e.g. `info,tower_http=debug,aws=info` |

### Authentication (optional)

By default `/api/*` is open — only suitable for trusted LAN environments. To enable Bearer token auth, add to your config:

```toml
[auth]
enabled = true
token = "any-long-random-string"
```

Or rely entirely on environment variables (keep the secret out of the config file):

```bash
OMNI_AUTH_ENABLED=true OMNI_AUTH_TOKEN=$(openssl rand -hex 32) ./omni-stream
```

Once enabled:

- All `/api/*` requests must carry `Authorization: Bearer <token>`, otherwise the server returns `401` plus `WWW-Authenticate: Bearer realm="omni-stream"`.
- Token comparison uses constant-time byte equality, so length / content differences cannot leak via timing.
- The embedded SPA (`/`, `/assets/*`) stays open — the browser has to load the page first before the user can enter a token. The first API call gets a 401, the SPA pops up a token input, stores it in `localStorage`, and attaches it to subsequent requests.
- TLS is intentionally out of scope for this process. To expose it on an untrusted network, put nginx / caddy / Cloudflare in front and let them handle HTTPS.

### Config CLI

If you'd rather not copy `config.example.toml` by hand, the binary ships three `config` subcommands:

```bash
# List every candidate location in priority order, and mark which one the
# loader will pick.
omni-stream config list

# Lay down the bundled config.example.toml at one of the candidate paths
# (interactive selection, with a "custom path" option).
omni-stream config init

# Parse + validate. Surfaces missing fields, wrong types, or an empty
# `storages` list. Without an argument it checks the active path; pass a
# path to validate it directly.
omni-stream config check
omni-stream config check ./my-config.toml
```

The template `config init` writes is the verbatim `config.example.toml` from
the repo, embedded into the binary at compile time via `include_str!` — no
external file required.

Subcommand output uses ANSI colours and emoji icons to keep interactive
terminals scannable, but follows the [NO_COLOR](https://no-color.org/)
convention — `NO_COLOR=1` or piping to a file / pipe automatically falls
back to plain ASCII. Set `FORCE_COLOR=1` to force colour on inside scripts.

## 3. Run

If you installed via `cargo install`, `omni-stream` is already on `$PATH`:

```bash
# Use the config.toml found by the §2 lookup order
omni-stream

# Or point at a specific one
OMNI_CONFIG=/etc/omni-stream/config.toml omni-stream

# Or override just the port
OMNI_SERVER_PORT=8081 omni-stream

# Turn on request logging while debugging
RUST_LOG=info,tower_http=debug omni-stream
```

Tarballs from GitHub Releases don't add themselves to `$PATH`, so either run `./omni-stream` from the extracted directory or move it somewhere like `/usr/local/bin/`.

After startup, opening `http://<host>:<port>/` in a browser lands you on the embedded SPA. `Ctrl-C` / SIGTERM triggers a graceful shutdown (`axum::serve` + `with_graceful_shutdown`).

## 4. HTTP Error Semantics

| Trigger | HTTP | AppError |
| --- | --- | --- |
| Auth enabled and token missing / wrong | 401 | (middleware — bypasses AppError) |
| File not found | 404 | `NotFound` |
| Credential lacks GetObject / S3 AccessDenied | 403 | `Forbidden` |
| Out-of-range / malformed Range | 416 | `InvalidRange` |
| Path contains `..` or other escape attempts / requesting a directory as a file | 400 | `InvalidPath` / `Unsupported` |
| Other I/O / SDK / network errors | 500 | `Io` / `Backend` |

Response bodies are uniformly `{"error": "...", "message": "..."}` JSON.
