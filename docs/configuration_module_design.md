# OmniStream 配置模块设计文档

## 1. 概述

OmniStream 使用 **TOML** 作为标准配置文件格式。系统支持定义多个存储后端，并通过 `active` 属性在运行时动态指定当前生效的后端。

## 2. 配置文件格式 (`config.toml`)

> 完整字段说明与默认值见仓库根目录的 `config.example.toml`（已嵌入二进制，可用
> `omni-stream config init` 生成）。

```toml
[server]
# host = "127.0.0.1"  # 默认
# port = 28080        # 默认

[auth]
# enabled = false                              # 默认；true 时开启 Bearer token 鉴权
# token = "replace-with-a-long-random-string"  # enabled=true 时必填
# public_read = true  # 默认；true=仅写操作需 token，false=全锁定（每个请求都需 token）

[[storages]]
name = "production-s3"
type = "s3"
active = true
s3 = { endpoint = "...", bucket = "...", access_key = "...", secret_key = "...", region = "...", force_path_style = true }  # 虚拟主机网关（部分 AOSS/OSS）设 false

# 省略 bucket（或设为 "*"）开启多 bucket 模式：根目录展开 ListBuckets，
# 每个可见 bucket 作为顶层目录显示。需要 s3:ListAllMyBuckets 权限。
[[storages]]
name = "all-prod-s3"
type = "s3"
s3 = { endpoint = "...", access_key = "...", secret_key = "...", region = "..." }

[[storages]]
name = "local-data"
type = "local"
active = false
local = { root_path = "/data/files", follow_symlinks = true }  # false 时 symlink 读取返回 Forbidden 且拒绝 DuckDB/SQL

[thumbnails]
# enabled = false           # 默认；true=开启按需 WebP 缩略图缓存
# cache_path = "~/.cache/omni-stream/thumbs"  # 默认
# quality = 70              # WebP 质量 1-100
# max_cache_bytes = 1073741824  # 默认 1 GiB；LRU 超限时清理

[sql]
# enabled = true            # 默认 kill-switch；需同时满足 duckdb feature + auth.enabled
# memory_limit = "512MB"    # 默认；每个 DuckDB 查询连接的内存上限
# threads = 2               # 默认；每个连接的 DuckDB 线程数
# query_timeout_secs = 300    # 默认（5 分钟）；交互式 SELECT 超时返回 408
# convert_timeout_secs = 1800 # 默认（30 分钟）；后台 JSONL/CSV→Parquet 转换超时
# max_rows = 10000            # 默认；结果超出此数时截断
```

`s3.bucket` 为可选字段，缺省 / 空串 / `"*"` 三种写法语义等价：均触发多 bucket
模式。给出具体 bucket 名时，`S3Backend` 行为与本特性引入前完全一致，无回归。

## 3. 加载逻辑与优先级

`config.toml` 按以下顺序查找（找到第一个即用它）：

1. `$OMNI_CONFIG`（绝对路径环境变量，最高优先级，即使文件不存在也不 fallback）
2. `$XDG_CONFIG_HOME/omni-stream/config.toml`
3. `directories::ProjectDirs` 平台默认（macOS：`~/Library/Application Support/omni-stream/`；Linux：`~/.config/omni-stream/`）
4. `./config.toml`（当前目录）

文件读取后再以 **环境变量** 覆盖（前缀 `OMNI_`，分隔符 `_`，例如 `OMNI_SERVER_PORT` 覆盖 `server.port`，`OMNI_AUTH_PUBLIC_READ` 覆盖 `auth.public_read`）。最后应用 **内置默认值**（未配置字段的兜底）。

## 4. 模块实现要求

### 4.1 `src/config.rs` (数据结构)

* 使用 `serde` 和 `toml` 定义 `Config`, `ServerConfig`, `StorageConfig`, `S3Config`, `LocalConfig`, `AuthConfig`, `ThumbConfig`, `SqlConfig`。
* `StorageType` 枚举必须使用 `#[serde(rename_all = "lowercase")]`。
* 实现 `load()` 函数，利用 `config` crate 合并文件配置与环境变量。
* `AuthConfig` 和 `S3Config` 手动实现 `Debug`，避免 token / 凭据泄漏到日志。

### 4.2 `src/storage/factory.rs` (后端工厂)

* 实现工厂函数: `pub async fn create_registry(cfg: &Config) -> anyhow::Result<BackendRegistry>`。
* **查找逻辑**: 优先匹配 `active == true` 的存储项；若不存在，默认使用列表第一项。
* 采用**宽松启动策略**：default storage 必须初始化成功（否则 bail!）；其余 storage 初始化失败则记 warn 并归入 `invalid` 表，访问时返回 503 `StorageInvalid`。
* 返回 `BackendRegistry`（包含 `backends`、`invalid`、`order`、`default_name` 字段），详见 `docs/storage_trait_design.md §6`。

## 5. 开发任务清单

### 任务 1: 数据建模

* 在 `src/config.rs` 定义 TOML 架构对应的结构体。
* 确保 `StorageConfig` 中的 `r#type` 字段能正确匹配枚举。

### 5.2 任务 2: 配置加载器

* 使用 `directories` crate 解析 `$XDG_CONFIG_HOME`。
* 使用 `config` crate 实现配置合并。
* 解析失败或字段缺失时，记录带有上下文的详细错误日志并终止运行。

### 5.3 任务 3: 后端工厂实现

* 实现 `create_backend` 以匹配并实例化对应的后端。
* 确保 `S3Backend` 或 `LocalFsBackend` 能根据配置正确初始化。

## 6. 开发规范 (必须遵守)

* **安全性**: 手动实现 `S3Config` 的 `Debug` trait，确保 `access_key` 和 `secret_key` 在日志中被掩码处理。
* **错误处理**: 严禁使用 `unwrap()`。整个加载与初始化流程需返回 `anyhow::Result` 或自定义的 `AppError`。
* **路径校验**: 初始化 `LocalFsBackend` 时，必须校验 `root_path` 是否存在且具备读写权限。
* **不可变性**: 配置对象在初始化后应视作不可变，通过 `Arc` 在应用内共享。
