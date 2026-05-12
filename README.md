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

推荐使用仓库根目录的 `start.sh`（需已安装 **Rust**、**fnm** / **Node**，并在 `frontend/` 下执行过一次 `pnpm install`）。脚本默认导出 `OMNI_CONFIG=./config.toml`、`OMNI_BACKEND_URL=http://127.0.0.1:28080`（与 Vite 反代目标一致；若改了 `server.port` 请同步改环境变量）、`CARGO_TARGET_DIR`（默认可指向临时目录以减轻仓库内 `target/` 体积）。用法：

```bash
./start.sh build                 # 等同 ./start.sh build --all
./start.sh build --all           # 或 -a：release 编后端 + 前端 pnpm build（嵌入 dist）
./start.sh build --frontend      # 或 -f：仅前端静态产物
./start.sh build --backend       # 或 -b：仅 cargo release 编 omni-stream
./start.sh --help                # 打印完整子命令说明
```

发布产物为 `omni-stream` 可执行文件：若未设置 `CARGO_TARGET_DIR`，默认在 `./target/release/omni-stream`；脚本里若把 `CARGO_TARGET_DIR` 指到别处，则在对应目录的 `release/` 下。

本地调试或 CI 若需要 **debug 构建** 或跑测试，可继续用手动命令：

```bash
# 首次前端依赖
cd frontend && pnpm install && cd ..

cd frontend && pnpm build && cd ..   # 或仅用 ./start.sh build --frontend

cargo build --bin omni-stream
cargo test --bin omni-stream
```

仅打 release 二进制、不用脚本时：

```bash
cargo build --release --bin omni-stream
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
| `OMNI_AUTH_ENABLED` | 覆盖 `auth.enabled`（`true` / `false`） |
| `OMNI_AUTH_TOKEN` | 覆盖 `auth.token`（建议把 secret 放这里而不是配置文件） |
| `OMNI_CONFIG` | 强制使用某个绝对路径的 `config.toml` |
| `RUST_LOG` | tracing 过滤，例如 `info,tower_http=debug,aws=info` |

S3 的 `access_key` / `secret_key` 与 `auth.token` 都不会进 `tracing` 日志
（`S3Config` 与 `AuthConfig` 都手写了 masked `Debug`，无论怎么打印都是
`***REDACTED***`）。

### 鉴权（可选）

默认状态下 `/api/*` 是开放的——这只适合局域网信任环境。要开启 Bearer token 鉴权：

```toml
[auth]
enabled = true
token = "any-long-random-string"
```

或者只用环境变量（不把 secret 放进配置文件）：

```bash
OMNI_AUTH_ENABLED=true OMNI_AUTH_TOKEN=$(openssl rand -hex 32) ./omni-stream
```

启用后：

- 所有 `/api/*` 请求必须带 `Authorization: Bearer <token>`，否则返回 `401` +
  `WWW-Authenticate: Bearer realm="omni-stream"`。
- token 比对走常时间字节比较，不会因长度 / 内容差异泄漏时序。
- 嵌入的前端 SPA（`/`、`/assets/*`）保持开放——浏览器要先把页面拉下来，才有
  地方让用户输入 token。第一次访问 API 拿到 401，前端会弹出 token 输入框，
  存到 `localStorage`，之后的请求自动带上。
- TLS 不在本进程职责范围内。要暴露到不信任网络，请在前面挡 nginx / caddy /
  Cloudflare 反代，让其负责 HTTPS。

## 4. 启动

生产或本地直接跑已编译二进制：

```bash
# 用仓库根目录的 config.toml（如果有）
./target/release/omni-stream

# 或显式指定一份
OMNI_CONFIG=/etc/omni-stream/config.toml ./target/release/omni-stream

# 调试时打开请求日志
RUST_LOG=info,tower_http=debug ./target/release/omni-stream
```

开发时可在仓库根目录用 `start.sh` 起 `cargo run`（默认等价于 `./start.sh run`，使用 `./config.toml`）：

```bash
./start.sh        # 后端 cargo run
```

启动后浏览器打开 `http://<host>:<port>/` 即是嵌入的前端 SPA。`Ctrl-C` /
SIGTERM 触发优雅关停（`axum::serve` + `with_graceful_shutdown`）。

## 5. 开发模式（前后端分跑）

需要改前端并要 HMR 时，开两个终端，均从仓库根目录执行 `start.sh`（脚本里已对 `frontend` 执行 `fnm use`）：

```bash
# 终端 A：后端 cargo run（必要时自行剥代理，例如 env -u HTTP_PROXY -u HTTPS_PROXY）
./start.sh run

# 终端 B：仅起 Vite dev server（5173 默认端口）；/api/* 由 Vite 按 OMNI_BACKEND_URL 反代到后端
./start.sh run --frontend
# 等价简写
./start.sh run -f
```

`start.sh` 在进程环境里默认设置 `OMNI_BACKEND_URL=http://127.0.0.1:28080`，需与当前后端监听地址一致（一般对应 `config.toml` 里 `[server]` 的 `host` / `port`）。若端口不同，可在运行前导出覆盖，例如：

```bash
export OMNI_BACKEND_URL=http://127.0.0.1:8080
./start.sh run -f
```

浏览器打开 `http://127.0.0.1:5173/`。具体行为见 `frontend/vite.config.ts` 中的 proxy 配置。

## 6. 项目结构

```text
omni-stream/
├── start.sh                  # 本地 build / run / run --frontend 入口脚本
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
| 鉴权开启但未带 / token 错误 | 401 | （middleware，不走 AppError） |
| 文件不存在 | 404 | `NotFound` |
| 凭据无 GetObject 权限 / S3 AccessDenied | 403 | `Forbidden` |
| 越界 / 非法 Range | 416 | `InvalidRange` |
| 路径含 `..` 等越权片段 / 把目录当文件请求 | 400 | `InvalidPath` / `Unsupported` |
| 其它 IO / SDK / 网络错误 | 500 | `Io` / `Backend` |

错误体统一是 `{"error": "...", "message": "..."}` JSON。
