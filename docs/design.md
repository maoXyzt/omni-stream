# OmniStream 开发设计文档

## 1. 项目概览

* **项目名称**: OmniStream
* **目标**: 构建一个单二进制文件、高性能、支持 S3 与本地文件系统的流式存储代理服务。
* **架构**: 采用“Trait 抽象 + 依赖注入”模式，支持通过配置文件动态切换存储后端。

## 2. 核心技术栈

* **后端**: `Rust` + `Axum` + `Tokio` + `aws-sdk-s3`
* **配置**: `serde` + `toml` + `config` + `directories` (遵循 XDG 规范)
* **前端集成**: `rust-embed` (静态资源嵌入)
* **错误处理**: `thiserror` + `anyhow`

## 3. 系统架构 (存储抽象层)

所有后端必须实现以下 `StorageBackend` trait：

```rust
#[async_trait]
pub trait StorageBackend: Send + Sync {
    async fn get_file(&self, path: &str, opts: GetOptions) -> Result<StorageResponse, AppError>;
    async fn list_files(&self, prefix: &str, token: Option<String>) -> Result<ListResult, AppError>;
    async fn stat(&self, path: &str) -> Result<FileMeta, AppError>;
}
```

## 4. 目录结构规范

```text
omni-stream/
├── src/
│   ├── main.rs          # 服务启动、路由注册、AppState 注入
│   ├── config.rs        # 配置结构定义、XDG 路径解析
│   ├── error.rs         # 自定义 AppError 枚举 (实现 IntoResponse)
│   ├── handlers.rs      # Axum 处理函数 (Proxy & List)
│   └── storage/         # 存储抽象逻辑
│       ├── mod.rs       # Trait 与共享数据结构定义
│       ├── s3.rs        # S3Backend 实现
│       └── local.rs     # LocalFsBackend 实现
├── frontend/            # 前端 React/Vue 工程
└── config.example.toml  # 配置文件模板
```

## 5. 开发任务指令清单 (Agent Prompt)

### Task 1: 基础工程与配置初始化

* **任务**: 定义 `Config`、`ServerConfig` 及 `StorageConfig` 结构，配置文件采用 `config.toml`。支持 `[[storages]]` 多后端定义与 `active` 激活标记；使用 `directories` 库定位 `~/.config/omni-stream/config.toml`；使用 `config` crate 合并环境变量（前缀 `OMNI_`）与文件配置。

### Task 2: 存储抽象层实现

* **任务**:
    1. 在 `storage/mod.rs` 中定义 `StorageBackend` trait。
    2. 在 `storage/factory.rs` 提供后端工厂逻辑：优先选择 `active == true` 的存储配置，若不存在则回退到第一项。
    3. 在 `storage/s3.rs` 实现 `S3Backend`，使用 `aws-sdk-s3` 处理 `get_object` (含 Range) 和 `list_objects_v2` (含分页)。
    4. 在 `storage/local.rs` 实现 `LocalFsBackend`，使用 `tokio::fs` 处理文件读写。

### Task 3: 路由处理逻辑

* **任务**:
    1. 实现 `GET /api/list`：支持 `prefix` 和 `page_token` 参数。
    2. 实现 `GET /api/proxy/:key`：转发 Range 头，调用 `get_file`，利用 `axum::body::Body::from_stream` 返回流。
    3. 确保所有 IO 错误通过 `error.rs` 转换为正确的 HTTP 状态码。

### Task 4: 前端嵌入与主服务

* **任务**:
    1. 使用 `rust-embed` 嵌入前端 `dist` 目录。
    2. 设置 fallback 路由，将所有非 `/api/` 的请求匹配到静态文件，实现 SPA 友好路由。
    3. 将 `Arc<dyn StorageBackend>` 注入 `AppState`。

## 6. 关键开发规范 (MUST FOLLOW)

1. **内存安全**: 流式传输严禁一次性读取整个文件，必须使用异步生成器 (Async Stream)。
2. **配置规范**: 配置文件格式为 TOML，默认路径为 `$XDG_CONFIG_HOME/omni-stream/config.toml`，并支持环境变量前缀 `OMNI_` 覆盖（如 `OMNI_SERVER_PORT` -> `server.port`）。
3. **错误处理**: 不要使用 `unwrap()`，所有 IO 异常必须映射为 `AppError`。
4. **接口一致性**: 无论底层是 S3 还是本地 FS，`list_files` 的分页返回逻辑必须保持一致。
