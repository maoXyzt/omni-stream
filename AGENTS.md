# AGENTS.md

本文件旨在为辅助开发工具（Coding Agents）提供项目上下文、开发范式与核心原则。

**原则**: 在处理任务时，请确保代码符合高并发、低内存占用的原则，始终优先考虑 trait 的可扩展性。

## 1. 项目概况

**OmniStream** 是一个高性能、单二进制文件的统一存储流式代理服务。

* **架构模式**: Trait-based 插件化后端 (S3/LocalFS) + Axum 异步 Web 服务。
* **核心准则**: 极简部署、高性能流式 IO、XDG 配置规范、零内存溢出风险。

## 2. 核心架构约束 (MUST FOLLOW)

* **存储解耦**: 严禁在 `handlers.rs` 中直接调用具体后端的实现。必须通过 `dyn StorageBackend` 进行调用。
* **流式传输**: 任何文件读取逻辑（特别是 `get_file`）必须使用异步流 (Async Stream)，严禁将文件数据 `collect()` 到 `Vec<u8>` 中。
* **错误映射**: 所有 `std::io::Error` 或 `aws_sdk_s3::Error` 必须统一转换为 `crate::error::AppError`，并实现 `IntoResponse`。
* **配置规范**: 配置读取逻辑优先级为：`CLI Args` > `Env Vars` > `$XDG_CONFIG_HOME/omni-stream/config.toml`。

## 3. 编码约定

* **异步生态**: 必须使用 `tokio` 运行时。所有 IO 操作均需在 `.await` 后执行，防止阻塞 Reactor。
* **安全性**: 外部输入（如 `path` 参数）必须经过安全清理，防止“路径遍历” (Path Traversal) 攻击。
* **日志**: 使用 `tracing`。在处理 API 请求时，必须使用 `instrument` 宏追踪请求生命周期。
* **Clippy 校验**: 修改 Rust 代码后，必须通过 `cargo clippy` 校验（建议：`cargo clippy --all-targets -- -D warnings`）。

## 4. 任务处理规范

当你收到新的开发指令时，请遵循以下流程：

1. **分析**: 判断该需求是否影响 `StorageBackend` trait 定义。若有影响，优先修改 trait 及所有后端实现。
2. **实现**: 按照模块结构（`src/storage`, `src/handlers`, `src/config`）增量提交代码。
3. **验证**: 检查代码是否包含 `unwrap()` 或 `expect()`。**严禁在生产代码中使用这些函数，必须使用 `?` 配合 `AppError`。
4. **测试**: 若是新增功能，请务必提供对应的测试模块（Unit Test）。

## 5. 项目模块映射

| 路径 | 职责 |
| :--- | :--- |
| `src/storage/` | 存储后端抽象逻辑，任何新增存储后端均需在此实现 Trait |
| `src/handlers.rs` | HTTP 接口层，不包含存储具体实现 |
| `src/error.rs` | 统一的错误处理中心 |
| `src/config.rs` | 配置解析，适配 XDG 规范 |

## 6. 文档维护

* **多语言版本同步**: 仓库内部分文档可能存在中英双语版本（命名约定：英文版加 `-en` 后缀，如 `README.md` ↔ `README-en.md`）。修改任意一份时必须在同一次提交里同步更新另一份，确保章节结构、示例命令、技术术语完全一致——不要让两份内容长期漂移。若确实只能临时改一份，请在另一份顶部加一行 stale 提示并在 commit message 中说明原因。
* **新增文档默认中文**: 仓库主语言是中文，新增文档默认只写中文版即可；只有当某份文档明确需要面向英文受众时（如顶层 README）才补 `-en` 版本，并立即归入上述同步规则。
