# OmniStream

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/maoXyzt/omni-stream)

**中文** · [English](README.md)

**单二进制的流式文件浏览与预览服务**——把任意本地目录或 S3 兼容对象存储
（MinIO / OSS / Ceph / R2 等）一键暴露为可浏览、可预览的 HTTP 服务。后端基于
`axum + tokio + aws-sdk-s3`，通过 `StorageBackend` trait 统一抽象多种存储
后端；内嵌 React SPA 前端，启动后浏览器打开 `http://<host>:<port>/` 就能浏览
目录、按需加载缩略图、就地预览文件。预览支持：

- **图片** —— png / jpg / gif / webp / avif / bmp / svg / ico
- **视频** —— mp4 / webm / mov / mkv / m4v / ogv，按 `Range` 流式拖拽
- **文本 / 代码** —— 按扩展名做语法高亮：json / yaml / toml / md /
  rs / ts / py / go / sql / shell / proto 等
- **表格数据** —— Parquet（hyparquet 纯 JS 解码，可切换内嵌 **DuckDB SQL 查询 tab**）/ CSV / TSV；
  另支持 Rows View 卡片渲染（详见 [docs/parquet_rows_view_user_guide.md](docs/parquet_rows_view_user_guide.md)）
- **其它格式** —— 通用 fallback：图标 + 元信息 + 浏览器内置 viewer

> 预览 S3 / S3-兼容存储上的文件时，所配 access key 必须有 **`s3:GetObject`**
> （文件预览 / 下载 / HEAD）和 **`s3:ListBucket`**（目录浏览 / 缩略图列表）
> 权限——少一项对应操作就 403。如果省略 `s3.bucket` 走多 bucket 模式
> （见下文），还需要 **`s3:ListAllMyBuckets`** 才能在根目录列出所有 bucket。
> 写操作（`/api/convert` 转 Parquet）还需要 **`s3:PutObject`** 权限。
> 本地文件系统后端无此要求，但只能访问 `local.root_path` 配置的根目录。

HTTP 接口（前端 SPA 都基于此调用，也可以直接用 curl / 自写客户端）：

- `GET /api/server` / `GET /api/storages` —— 服务器信息（版本、auth_enabled、sql_enabled、public_read）与存储列表
- `GET /api/list?prefix=&page_token=&skip_pages=` —— 浏览目录；可选 `skip_pages` 让后端服务端 walk N 页，响应会带回中间页的 token 数组，前端一次往返就能跳到第 N 页
- `GET /api/stat/{*key}` —— 取文件元信息
- `GET /api/proxy/{*key}` —— 流式拉取，全程透传 `Range`，自动 200 / 206
- `GET /api/thumb/{*key}` —— 按需生成 WebP 缩略图（需 `[thumbnails] enabled = true`）
- `POST /api/query` —— DuckDB **只读** SQL（SELECT / DESCRIBE / EXPLAIN 等；COPY 及写语句被拒；需 `--features duckdb` 构建 + `auth.enabled = true`）
- `POST /api/convert` —— JSONL / NDJSON / TSV / CSV → Parquet 转换（写操作，auth 开启时始终需 token）
- `GET /raw/{storage}` / `GET /raw/{storage}/` / `GET /raw/{storage}/{*path}` —— 可导航文件挂载：inline 提供文件（HTML 直接在浏览器渲染），根路径或加 `?ls` 返回 JSON 目录列表，支持 copyparty 风格自包含 dashboard
- 嵌入式 SPA fallback —— 任何非 `/api/*`、非 `/raw/*` 路径回落到 `index.html`，前端路由自洽

> 写/SQL 功能的前置条件与完整用法见 [docs/edit_features_guide.md](docs/edit_features_guide.md)。

---

## 1. 安装

**推荐**：用 cargo 装到 `~/.cargo/bin/`：

```bash
cargo install omni-stream    # 需 Rust 1.91+
```

**Python 用户**（无需 Rust 工具链，从 PyPI 安装）：

```bash
uv tool install omni-stream  # 推荐：装到独立隔离环境里的全局 CLI
# 或者一次性运行不安装
uvx omni-stream --help
# 不用 uv 的话，直接 pip 装到当前 venv 里
pip install omni-stream
```

PyPI 上的 wheel 直接打包了预编译二进制，装完即可像普通命令行工具
那样直接运行 `omni-stream`，不会启动 Python 解释器。同样覆盖 3 个平台：
`x86_64-unknown-linux-gnu`（manylinux）、`x86_64-unknown-linux-musl`
（musllinux）、`aarch64-apple-darwin`。

> 没装过 uv：`curl -LsSf https://astral.sh/uv/install.sh | sh`（详见
> <https://docs.astral.sh/uv/>）。也可以用 `pipx install omni-stream` 把 CLI
> 装到隔离环境，wheel 是同一份。

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
port = 28080

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
s3 = { endpoint = "http://minio.local:9000", bucket = "data", access_key = "...", secret_key = "..." }
```

local 后端可选 `follow_symlinks`（默认 `true`；`false` 时符号链接作为条目出现但读取返回 Forbidden，且该 storage 完全拒绝 DuckDB/SQL 功能）：

```toml
[[storages]]
name = "local-data"
type = "local"
active = true
local = { root_path = "/var/lib/omni-stream", follow_symlinks = false }  # 默认 true
```

> `s3.region` 默认 `us-east-1`，对 MinIO / LocalStack / AWS us-east-1 桶都
> 够用，可以省略。**只在两种情况下需要显式配置**：(1) 目标桶在 AWS 上但不
> 是 us-east-1——SigV4 必须用桶实际所在的 region，否则 AWS 返回
> `AuthorizationHeaderMalformed`；(2) 网关对 region 有严格校验（大部分网
> 关都不校验）。
> `s3.force_path_style` 默认 `true`（MinIO 等自托管网关必须用 true）；部分
> AOSS/OSS 等虚拟主机风格的网关需设为 `false`。

`s3.bucket` 是可选字段。**省略它（或显式写成 `"*"`）会进入多 bucket 模式**：
访问该 storage 的根目录时后端发起 `ListBuckets`，凭据可见的每个 bucket 都
会作为一个顶层目录展示，点进去再按常规 prefix 列表浏览。需要凭据具备
`s3:ListAllMyBuckets` 权限，配置如：

```toml
[[storages]]
name = "all-prod-s3"
type = "s3"
s3 = { endpoint = "http://minio.local:9000", access_key = "...", secret_key = "..." }
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
| `OMNI_AUTH_PUBLIC_READ` | 覆盖 `auth.public_read`（`true` / `false`） |
| `OMNI_CONFIG` | 强制使用某个绝对路径的 `config.toml` |
| `RUST_LOG` | tracing 过滤，例如 `info,tower_http=debug,aws=info` |

### 鉴权（可选）

默认状态下 API 是完全开放的——只适合局域网信任环境。如果要开启 Bearer token 鉴权，在配置文件中添加：

```toml
[auth]
enabled = true
token = "any-long-random-string"
```

或者只用环境变量（不把 secret 放进配置文件）：

```bash
OMNI_AUTH_ENABLED=true OMNI_AUTH_TOKEN=$(openssl rand -hex 32) ./omni-stream
```

启用后，**默认行为是读写分离**（`public_read = true`，默认值）：

- **浏览 / 预览 / 下载**（`/api/list`、`/api/stat`、`/api/proxy`、`/api/thumb`、`/raw`）保持开放，无需 token。
- **写操作**（`/api/convert` 转 Parquet）始终需要 `Authorization: Bearer <token>`。
- **SQL 查询**（`/api/query`）归入读组，默认也无需 token；但端点本身只在 `auth.enabled = true` 时才激活（不支持完全开放 API）。
- 前端：写操作收到 `401` 时会弹出 token 输入框，存到 `localStorage` 后自动重试；
  工具栏另有 **Auth Token** 按钮，可在发起写操作前提前输入 token。

如需**全锁定**（读操作也要 token），在配置中加 `public_read = false`：

```toml
[auth]
enabled = true
token = "any-long-random-string"
public_read = false   # 每个 API 请求都要带 token
```

> **注意**：`/raw` 文件挂载依赖 Bearer header 鉴权，浏览器导航 / fetch 无法注入 header，
> 因此在 `public_read = false`（全锁定）模式下 `/raw` 实际不可用。默认的
> `public_read = true` 模式下 `/raw` 正常工作。

嵌入的前端 SPA（`/`、`/assets/*`）始终开放。TLS 自行用 nginx / caddy 等反代解决。

### 缩略图（可选）

默认关闭；开启后网格视图将用 WebP 缩略图代替原图预览，可大幅减少流量：

```toml
[thumbnails]
enabled = true
# cache_path = "~/.cache/omni-stream/thumbs"  # 默认；可自定义缓存目录
# quality = 70        # WebP 质量 1-100，默认 70
# max_cache_bytes = 1073741824  # 默认 1 GiB
```

完整选项见 `config.example.toml` 的 `[thumbnails]` 段。

### SQL 查询与格式转换（可选，需 duckdb 构建）

如果二进制以 `--features duckdb` 构建（PyPI wheel 已内置；`cargo install` 默认不含），
并同时满足 `auth.enabled = true`，则可在 `[sql]` 段调整 DuckDB 行为：

```toml
[sql]
# enabled = true            # 默认；kill-switch 独立于构建 feature
# memory_limit = "512MB"    # 默认；每个查询连接的 DuckDB 内存上限
# threads = 1               # 默认；每个查询连接的 DuckDB 线程数；调大可提升吞吐但增加峰值内存
# query_timeout_secs = 300    # 默认（5 分钟）；交互式 SELECT 超时返回 408
# convert_timeout_secs = 1800 # 默认（30 分钟）；后台 JSONL/CSV→Parquet 转换超时
# max_rows = 10000            # 默认；结果超出此数时截断（truncated = true）
```

前置条件与具体用法（Parquet SQL tab、格式转换按钮）详见 [docs/edit_features_guide.md](docs/edit_features_guide.md)。

### 配置文件 CLI

不想手动复制 `config.example.toml` 的话，二进制自带三个 `config` 子命令：

```bash
# 按优先级列出所有候选位置，并标出当前命中的那一份
omni-stream config list

# 把内嵌的 config.example.toml 写到候选位置之一（交互式选择，含「自定义路径」选项）
omni-stream config init

# 解析 + 校验。缺字段 / 类型错 / storages 为空都会指出来。
# 不带路径就检查当前命中那份；也可以显式传一个文件路径。
omni-stream config check
omni-stream config check ./my-config.toml
```

`config init` 写出的模板就是仓库里的 `config.example.toml`，已嵌入二进制，
不依赖外部文件。

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
| SQL 执行报错 / 被只读校验拒绝（duckdb） | 400 | `Query` / `QueryRejected` |
| convert 目标已存在且未带 `overwrite=true`（duckdb） | 409 | `Conflict` |
| SQL 查询超时（duckdb，`query_timeout_secs`） | 408 | `QueryTimeout` |
| storage 配置存在但启动初始化失败 | 503 | `StorageInvalid` |
| 其它 IO / SDK / 网络错误 | 500 | `Io` / `Backend` |

错误体统一是 `{"error": "...", "message": "..."}` JSON。
