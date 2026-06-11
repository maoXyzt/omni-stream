# OmniStream

[中文](README.md) · **English**

**A single-binary, streaming file browser and previewer** — point it at any local directory or S3-compatible object storage (MinIO / OSS / Ceph / R2 / …) and it instantly exposes them as a browsable, previewable HTTP service. The backend is built on `axum + tokio + aws-sdk-s3`, with one `StorageBackend` trait abstracting over every supported backend; a React SPA is bundled in, so opening `http://<host>:<port>/` lets you walk directories, lazy-load thumbnails, and preview files in place. Preview supports:

- **Images** — png / jpg / gif / webp / avif / bmp / svg / ico
- **Video** — mp4 / webm / mov / mkv / m4v / ogv, with `Range`-based seeking
- **Text / code** — syntax highlighting by extension: json / yaml / toml / md /
  rs / ts / py / go / sql / shell / proto, and many more
- **Tabular data** — Parquet (pure-JS decode via hyparquet, with an embedded **DuckDB SQL query tab**) / CSV / TSV;
  also supports Rows View card rendering (see [docs/parquet_rows_view_user_guide.md](docs/parquet_rows_view_user_guide.md))
- **Anything else** — generic fallback: icon + metadata + the browser's built-in viewer

> Previewing files on S3 / S3-compatible storage requires the configured access key to hold both **`s3:GetObject`** (preview / download / HEAD) and **`s3:ListBucket`** (directory browsing / thumbnail listing). Missing either yields a 403 on the corresponding action. If you omit `s3.bucket` to use multi-bucket mode (see below), the credentials must additionally hold **`s3:ListAllMyBuckets`** so the root listing can enumerate every visible bucket. Write operations (`/api/convert` converting to Parquet) additionally require **`s3:PutObject`**. The local filesystem backend has no such requirement, but is restricted to the directory configured as `local.root_path`.

HTTP API (the bundled SPA is built on top of these — `curl` or your own client works just as well):

- `GET /api/server` / `GET /api/storages` — server info (version, auth_enabled, sql_enabled, public_read) and storage list
- `GET /api/list?prefix=&page_token=&skip_pages=` — browse a directory; optional `skip_pages` makes the server walk N pages internally and return the target page plus every intermediate token, so jumping to page N takes one round-trip instead of N
- `GET /api/stat/{*key}` — fetch file metadata
- `GET /api/proxy/{*key}` — stream the file, transparently forwarding `Range`, returning 200 / 206 as appropriate
- `GET /api/thumb/{*key}` — on-demand WebP thumbnail (requires `[thumbnails] enabled = true`)
- `POST /api/query` — DuckDB **read-only** SQL (SELECT / DESCRIBE / EXPLAIN etc.; COPY and mutating statements are rejected; requires `--features duckdb` build + `auth.enabled = true`)
- `POST /api/convert` — JSONL / NDJSON / TSV / CSV → Parquet conversion (write operation — always requires a token when auth is on)
- `GET /raw/{storage}` / `GET /raw/{storage}/` / `GET /raw/{storage}/{*path}` — navigable file mount: serves files inline (HTML renders live in the browser); the root and trailing-slash forms list the storage root as JSON; append `?ls` to any path for a directory listing; supports copyparty-style self-contained dashboards
- Embedded SPA fallback — anything not under `/api/*` or `/raw/*` falls back to `index.html`, so client-side routing just works

> For prerequisites and full usage of SQL queries and file conversion, see [docs/edit_features_guide.md](docs/edit_features_guide.md).

---

## 1. Install

**Recommended**: install via cargo (lands in `~/.cargo/bin/`):

```bash
cargo install omni-stream    # requires Rust 1.91+
```

**Python users** (no Rust toolchain required — install from PyPI):

```bash
uv tool install omni-stream  # recommended: global CLI in an isolated venv
# or run one-off without installing
uvx omni-stream --help
# without uv, install into the active venv with plain pip
pip install omni-stream
```

The PyPI wheels bundle the prebuilt binary directly, so once installed
`omni-stream` runs as a normal CLI — Python is not invoked. Same three
platforms as the GitHub Releases tarballs: `x86_64-unknown-linux-gnu`
(manylinux), `x86_64-unknown-linux-musl` (musllinux), `aarch64-apple-darwin`.

> Don't have uv yet? `curl -LsSf https://astral.sh/uv/install.sh | sh` (full
> docs at <https://docs.astral.sh/uv/>). You can also use
> `pipx install omni-stream` for an isolated global install — same wheel.

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
port = 28080

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
s3 = { endpoint = "http://minio.local:9000", bucket = "data", access_key = "...", secret_key = "..." }
```

The local backend supports `follow_symlinks` (default `true`; when `false`, symlinks appear as entries but reads return Forbidden, and that storage refuses all DuckDB/SQL operations):

```toml
[[storages]]
name = "local-data"
type = "local"
active = true
local = { root_path = "/var/lib/omni-stream", follow_symlinks = false }  # default true
```

> `s3.region` defaults to `us-east-1`, which is fine for MinIO / LocalStack
> and AWS us-east-1 buckets — leave it out by default. **Only set it when:**
> (1) the target AWS bucket lives outside us-east-1, since SigV4 has to use
> the bucket's actual region (otherwise AWS returns
> `AuthorizationHeaderMalformed`); or (2) the S3-compatible gateway
> validates the region strictly (most don't).
> `s3.force_path_style` defaults to `true` (required for MinIO and most self-hosted gateways);
> set it to `false` for virtual-host-style gateways (some AOSS/OSS).

`s3.bucket` is optional. **Omit it (or set it to `"*"`) to enable multi-bucket
mode**: the storage root performs `ListBuckets`, and every bucket the
credentials can see appears as a top-level directory; navigating into one
drills down with the usual prefix listing. The credentials must hold the
`s3:ListAllMyBuckets` IAM permission. Example:

```toml
[[storages]]
name = "all-prod-s3"
type = "s3"
s3 = { endpoint = "http://minio.local:9000", access_key = "...", secret_key = "..." }
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
| `OMNI_AUTH_PUBLIC_READ` | overrides `auth.public_read` (`true` / `false`) |
| `OMNI_CONFIG` | force a specific absolute `config.toml` path |
| `RUST_LOG` | tracing filter, e.g. `info,tower_http=debug,aws=info` |

### Authentication (optional)

By default the API is completely open — only suitable for trusted LAN environments. To enable Bearer token auth, add to your config:

```toml
[auth]
enabled = true
token = "any-long-random-string"
```

Or rely entirely on environment variables (keep the secret out of the config file):

```bash
OMNI_AUTH_ENABLED=true OMNI_AUTH_TOKEN=$(openssl rand -hex 32) ./omni-stream
```

Once enabled, the **default behavior splits read and write access** (`public_read = true`, the default):

- **Browse / preview / download** (`/api/list`, `/api/stat`, `/api/proxy`, `/api/thumb`, `/raw`) stay public — no token required.
- **Write operations** (`/api/convert` for Parquet conversion) always require `Authorization: Bearer <token>`.
- **SQL queries** (`/api/query`) are in the read group and require no token by default; however the endpoint only activates when `auth.enabled = true` (it never runs on a fully open API).
- Frontend: a 401 on a write triggers a token-entry dialog; the token is stored in `localStorage` and the request is automatically retried. The toolbar also has an **Auth Token** button to pre-enter the token before any write.

To **lock down reads as well** (every API request requires the token), set `public_read = false`:

```toml
[auth]
enabled = true
token = "any-long-random-string"
public_read = false   # every request requires the token
```

> **Note**: the `/raw` file mount relies on Bearer-header auth; browsers can't inject headers on navigation / fetch, so `/raw` is not practically usable under full lockdown (`public_read = false`). The default `public_read = true` keeps `/raw` accessible.

The embedded SPA (`/`, `/assets/*`) is always open. TLS is out of scope — put nginx / caddy in front for HTTPS.

### Thumbnails (optional)

Disabled by default; when enabled, the grid view uses WebP thumbnails instead of full-resolution originals, significantly reducing bandwidth:

```toml
[thumbnails]
enabled = true
# cache_path = "~/.cache/omni-stream/thumbs"  # default; override to set a custom cache dir
# quality = 70        # WebP quality 1-100, default 70
# max_cache_bytes = 1073741824  # default 1 GiB
```

For the full set of options see the `[thumbnails]` section in `config.example.toml`.

### SQL queries and format conversion (optional — requires duckdb build)

If the binary was built with `--features duckdb` (PyPI wheels include it; `cargo install` does not by default) and `auth.enabled = true`, the `[sql]` section lets you tune DuckDB behavior:

```toml
[sql]
# enabled = true            # default; kill-switch independent of the build feature
# memory_limit = "512MB"    # default; DuckDB memory limit per query connection
# threads = 2               # default; DuckDB threads per query connection
# query_timeout_secs = 300  # default (5 min); query interrupted past this, returns 408
# max_rows = 10000          # default; results beyond this are truncated (truncated = true)
```

For prerequisites and full usage (Parquet SQL tab, format conversion button), see [docs/edit_features_guide.md](docs/edit_features_guide.md).

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
the repo, embedded into the binary — no external file required.

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
| SQL execution error / rejected by read-only validator (duckdb) | 400 | `Query` / `QueryRejected` |
| Convert target already exists and `overwrite=true` not set (duckdb) | 409 | `Conflict` |
| SQL query timed out (duckdb, `query_timeout_secs`) | 408 | `QueryTimeout` |
| Storage exists in config but failed to initialize at startup | 503 | `StorageInvalid` |
| Other I/O / SDK / network errors | 500 | `Io` / `Backend` |

Response bodies are uniformly `{"error": "...", "message": "..."}` JSON.
