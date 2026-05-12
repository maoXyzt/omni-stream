# OmniStream

**中文** · [English](README-en.md)

**单二进制的流式文件浏览与预览服务**——把任意本地目录或 S3 兼容对象存储
（MinIO / OSS / Ceph / R2 等）一键暴露为可浏览、可预览的 HTTP 服务，浏览器
打开就能浏览目录、看图、刷视频、读代码，无需安装客户端，也无需另搭前端或反代。
后端基于 `axum + tokio + aws-sdk-s3`，通过 `StorageBackend` trait 统一抽象
多种存储后端。

**内嵌一份开箱即用的 React SPA 前端**，启动后，浏览器打开 `http://<host>:<port>/`
就能直接浏览目录、按需加载缩略图、就地预览文件。预览功能支持：

- **图片** —— png / jpg / gif / webp / avif / bmp / svg / ico
- **视频** —— mp4 / webm / mov / mkv / m4v / ogv，按 `Range` 流式拖拽
- **文本 / 代码** —— 按扩展名做语法高亮：json / yaml / toml / md /
  rs / ts / py / go / sql / shell / proto 等
- **其它格式** —— 通用 fallback：图标 + 元信息 + 浏览器内置 viewer

> 预览 S3 / S3-兼容存储上的文件时，所配 access key 必须有 **`s3:GetObject`**
> （文件预览 / 下载 / HEAD）和 **`s3:ListBucket`**（目录浏览 / 缩略图列表）
> 权限——少一项对应操作就 403。本地文件系统后端无此要求，但只能访问
> `local.root_path` 配置的根目录。

HTTP 接口（前端 SPA 都基于此调用，也可以直接用 curl / 自写客户端）：

- `GET /api/list?prefix=&page_token=` —— 浏览目录
- `GET /api/stat/{*key}` —— 取文件元信息
- `GET /api/proxy/{*key}` —— 流式拉取，全程透传 `Range`，自动 200 / 206
- 嵌入式 SPA fallback —— 任何非 `/api/*` 路径回落到 `index.html`，前端路由自洽

---

## 1. 安装

**推荐**：用 cargo 装，二进制自动落到 `~/.cargo/bin/`（已在 `$PATH` 中），可以直接以 `omni-stream` 命令调用：

```bash
cargo install omni-stream    # 需 Rust 1.91+
```

或从 GitHub Releases 下载已编译二进制：<https://github.com/maoXyzt/omni-stream/releases/latest>。
覆盖 3 个平台 —— `x86_64-unknown-linux-gnu` / `x86_64-unknown-linux-musl` /
`aarch64-apple-darwin` (Windows 用户可自行编译)。对于预编译二进制，解压后给 `omni-stream` 加可执行权限即可，自行决定
要不要把它放进 `$PATH`。

> 想从源码构建、修改前后端、参与开发，见 [docs/development_guide.md](docs/development_guide.md)；
> 发版流程见 [docs/how_to_release.md](docs/how_to_release.md)。

## 2. 配置

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

> 多个 `[[storages]]` 表项可同时存在；启动时挑 `active = true` 的那一个，没配 active 就用第一个。
> 前端页面上也可以切换。

**环境变量覆盖**（前缀 `OMNI_`，分隔符 `_`）：

| 变量 | 作用 |
| --- | --- |
| `OMNI_SERVER_HOST` | 覆盖 `server.host` |
| `OMNI_SERVER_PORT` | 覆盖 `server.port` |
| `OMNI_AUTH_ENABLED` | 覆盖 `auth.enabled`（`true` / `false`） |
| `OMNI_AUTH_TOKEN` | 覆盖 `auth.token`（建议把 secret 放这里而不是配置文件） |
| `OMNI_CONFIG` | 强制使用某个绝对路径的 `config.toml` |
| `RUST_LOG` | tracing 过滤，例如 `info,tower_http=debug,aws=info` |

### 鉴权（可选）

默认状态下 `/api/*` 是开放的——这只适合局域网信任环境。如果要开启 Bearer token 鉴权，在配置文件中添加：

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

## 3. 启动

走 `cargo install` 装的话，`omni-stream` 已经在 `$PATH` 里，直接：

```bash
# 用 §2 查找顺序里命中的 config.toml
omni-stream

# 或显式指定一份
OMNI_CONFIG=/etc/omni-stream/config.toml omni-stream

# 或显式指定端口
OMNI_SERVER_PORT=8081 omni-stream

# 调试时打开请求日志
RUST_LOG=info,tower_http=debug omni-stream
```

GitHub Releases 下载的 tarball 解压后没自动入 `$PATH`，要么 `./omni-stream` 当前目录跑，要么自己挪到 `/usr/local/bin/` 之类的目录。

启动后浏览器打开 `http://<host>:<port>/` 即是嵌入的前端 SPA。`Ctrl-C` /
SIGTERM 触发优雅关停（`axum::serve` + `with_graceful_shutdown`）。

## 4. HTTP 错误码语义

| 触发 | HTTP | AppError |
| --- | --- | --- |
| 鉴权开启但未带 / token 错误 | 401 | （middleware，不走 AppError） |
| 文件不存在 | 404 | `NotFound` |
| 凭据无 GetObject 权限 / S3 AccessDenied | 403 | `Forbidden` |
| 越界 / 非法 Range | 416 | `InvalidRange` |
| 路径含 `..` 等越权片段 / 把目录当文件请求 | 400 | `InvalidPath` / `Unsupported` |
| 其它 IO / SDK / 网络错误 | 500 | `Io` / `Backend` |

错误体统一是 `{"error": "...", "message": "..."}` JSON。
