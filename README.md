# OmniStream

单二进制、流式存储代理服务。后端用 `axum + tokio + aws-sdk-s3` 写成，
通过 `StorageBackend` trait 同时支持本地文件系统与 S3 兼容对象存储；
前端是嵌入式 React SPA，由后端在同一端口直接吐出，无需额外静态资源服务器。

支持的能力：

- `GET /api/list?prefix=&page_token=` —— 浏览目录
- `GET /api/stat/{*key}` —— 取文件元信息
- `GET /api/proxy/{*key}` —— 流式拉取，全程透传 `Range`，自动 200 / 206
- 嵌入式 SPA fallback —— 任何非 `/api/*` 路径回落到 `index.html`，前端路由自洽

---

## 1. 环境要求

- **Rust 1.85+**（Cargo edition `2024`）
- **Node 24.15.0**（`frontend/.node-version` 已声明，建议用 `fnm` 自动切换）

## 2. 构建

```bash
# 1) 前端：构建静态产物到 frontend/dist/，rust-embed 会在编译期把它打包进二进制
cd frontend
pnpm install
pnpm build
cd ..

# 2) 后端：debug 构建 + 运行测试
cargo build --bin omni-stream
cargo test --bin omni-stream
```

发布构建：

```bash
cargo build --release --bin omni-stream
# 产物 ./target/release/omni-stream，单文件可拷贝到目标机器
```

## 3. 配置

`config.toml` 默认查找顺序（找到第一个就用它）：

1. `$OMNI_CONFIG`（绝对路径，最高优先级）
2. `$XDG_CONFIG_HOME/omni-stream/config.toml`
3. `directories::ProjectDirs` 平台默认（macOS：`~/Library/Application Support/omni-stream/`；Linux：`~/.config/omni-stream/`）
4. `./config.toml`（当前目录）

仓库根目录有 `config.example.toml` 可作模板。最小可用配置：

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

或 S3 / S3-兼容（MinIO / OSS）：

```toml
[[storages]]
name = "production-s3"
type = "s3"
active = true
s3 = { endpoint = "http://minio.local:9000", bucket = "data", access_key = "...", secret_key = "...", region = "us-east-1" }
```

> 多个 `[[storages]]` 表项可同时存在；启动时挑 `active = true` 的那一个，
> 没人 active 就用第一个。这样可以把多套环境写在同一份配置里、靠改 `active`
> 切换。

**环境变量覆盖**（前缀 `OMNI_`，分隔符 `_`）：

| 变量 | 作用 |
| --- | --- |
| `OMNI_SERVER_HOST` | 覆盖 `server.host` |
| `OMNI_SERVER_PORT` | 覆盖 `server.port` |
| `OMNI_CONFIG` | 强制使用某个绝对路径的 `config.toml` |
| `RUST_LOG` | tracing 过滤，例如 `info,tower_http=debug,aws=info` |

S3 的 `access_key` / `secret_key` 不会进 `tracing` 日志（`S3Config` 有手写的
masked `Debug`，无论怎么打印都是 `***REDACTED***`）。

## 4. 启动

```bash
# 用仓库根目录的 config.toml（如果有）
./target/release/omni-stream

# 或显式指定一份
OMNI_CONFIG=/etc/omni-stream/config.toml ./target/release/omni-stream

# 调试时打开请求日志
RUST_LOG=info,tower_http=debug ./target/release/omni-stream
```

启动后浏览器打开 `http://<host>:<port>/` 即是嵌入的前端 SPA。`Ctrl-C` /
SIGTERM 触发优雅关停（`axum::serve` + `with_graceful_shutdown`）。

## 5. 开发模式（前后端分跑）

需要修前端代码 + HMR 时：

```bash
# 终端 A：起后端（必要时剥代理 env）
env -u HTTP_PROXY -u HTTPS_PROXY \
  OMNI_CONFIG=/path/to/config.toml \
  cargo run --bin omni-stream

# 终端 B：起 Vite dev server，5173 端口；/api/* 自动 proxy 到后端
cd frontend
OMNI_BACKEND_URL=http://127.0.0.1:8080 pnpm dev
```

浏览器打开 `http://127.0.0.1:5173/`。Vite 的 `vite.config.ts` 通过
`OMNI_BACKEND_URL` 决定 proxy 目标，端口被占了改这个变量就行，无需改文件。

## 6. 项目结构

```text
omni-stream/
├── src/
│   ├── main.rs               # 入口：tracing、Config::load、AppState、路由
│   ├── config.rs             # Config / StorageConfig / S3Config / LocalConfig
│   ├── error.rs              # AppError + IntoResponse（404/403/416/400/500）
│   ├── handlers.rs           # list / stat / proxy / SPA fallback
│   └── storage/
│       ├── mod.rs            # StorageBackend trait + 共享数据结构
│       ├── factory.rs        # create_backend：选 active、校验 LocalFs root
│       ├── s3.rs             # S3Backend（path-style 自动启用、错误码分类）
│       └── local.rs          # LocalFsBackend（路径越权防护、Range 解析）
├── frontend/                 # Vite + React + shadcn/ui SPA
│   ├── src/
│   │   ├── api/              # Axios 实例 + storage API + ApiError
│   │   ├── hooks/            # useListFiles / useFileStat (TanStack Query)
│   │   ├── components/       # FileList / Breadcrumb / PreviewModal + ui/
│   │   ├── types/            # FileEntry / ListResult / FileMeta
│   │   └── main.tsx
│   └── dist/                 # `pnpm build` 产物，被 rust-embed 嵌入
├── config.example.toml
└── docs/
    ├── design.md
    └── configuration_module_design.md
```

## 7. HTTP 错误码语义

| 触发 | HTTP | AppError |
| --- | --- | --- |
| 文件不存在 | 404 | `NotFound` |
| 凭据无 GetObject 权限 / S3 AccessDenied | 403 | `Forbidden` |
| 越界 / 非法 Range | 416 | `InvalidRange` |
| 路径含 `..` 等越权片段 / 把目录当文件请求 | 400 | `InvalidPath` / `Unsupported` |
| 其它 IO / SDK / 网络错误 | 500 | `Io` / `Backend` |

错误体统一是 `{"error": "...", "message": "..."}` JSON。
