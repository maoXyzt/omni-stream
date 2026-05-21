# OmniStream 配置模块设计文档

## 1. 概述

OmniStream 使用 **TOML** 作为标准配置文件格式。系统支持定义多个存储后端，并通过 `active` 属性在运行时动态指定当前生效的后端。

## 2. 配置文件格式 (`config.toml`)

```toml
[server]
port = 8080
host = "0.0.0.0"

[[storages]]
name = "production-s3"
type = "s3"
active = true
s3 = { endpoint = "...", bucket = "...", access_key = "...", secret_key = "...", region = "..." }

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
local = { root_path = "/data/files" }
```

`s3.bucket` 为可选字段，缺省 / 空串 / `"*"` 三种写法语义等价：均触发多 bucket
模式。给出具体 bucket 名时，`S3Backend` 行为与本特性引入前完全一致，无回归。

## 3. 加载逻辑与优先级

1. **环境变量**: 前缀 `OMNI_` (例如 `OMNI_SERVER_PORT` 覆盖 `server.port`)。
2. **配置文件**: `$XDG_CONFIG_HOME/omni-stream/config.toml`。
3. **默认值**: 服务器基础配置使用硬编码默认值。

## 4. 模块实现要求

### 4.1 `src/config.rs` (数据结构)

* 使用 `serde` 和 `toml` 定义 `Config`, `ServerConfig`, `StorageConfig`, `S3Config`, `LocalConfig`。
* `StorageType` 枚举必须使用 `#[serde(rename_all = "lowercase")]`。
* 实现 `load()` 函数，利用 `config` crate 合并文件配置与环境变量。

### 4.2 `src/storage/factory.rs` (后端工厂)

* 实现工厂函数: `pub fn create_backend(cfg: &Config) -> Box<dyn StorageBackend>`。
* **查找逻辑**: 优先匹配 `active == true` 的存储项；若不存在，默认使用列表第一项。
* 返回 trait 对象 `Box<dyn StorageBackend>`。

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
