# OmniStream 存储抽象设计文档

## 1. 概述

OmniStream 把任意 "可寻址的文件树"（本地文件系统、S3 / S3-兼容对象存储等）
抽象成一个统一的 `StorageBackend` trait，HTTP 层 (`src/handlers.rs`) 只面向
trait 编程，对底层差异完全无感。新增一种后端 = 实现一份 trait + 在工厂里注册，
其余路径不变。

设计的核心约束（AGENTS.md §2）：

* **流式 IO**：`get_file` 必须返回 `Stream<Bytes>`，严禁 `collect()` 到 `Vec<u8>`。
* **错误统一化**：所有后端错误经 `AppError` 映射，再由 `IntoResponse` 转 HTTP。
* **存储解耦**：handler 层不引用任何具体后端类型，全部通过 `Arc<dyn StorageBackend>`。
* **路径安全**：外部输入必须在 backend 内做路径校验（local fs 必须拒绝 `..`）。

## 2. 模块布局

```
src/storage/
├── mod.rs          // trait + 公共类型
├── factory.rs      // 注册表 (BackendRegistry / NamedBackend / Invalid…)
├── local.rs        // LocalFsBackend
└── s3.rs           // S3Backend
```

`mod.rs` 只暴露 trait 与值类型，`factory.rs` 是唯一了解所有后端具体类型的地方。
其他模块（handlers、thumbs、cli 等）一律只看到 trait 对象。

## 3. 核心 Trait

```rust
#[async_trait]
pub trait StorageBackend: Send + Sync {
    async fn get_file(&self, path: &str, opts: GetOptions)
        -> Result<StorageResponse, AppError>;

    async fn list_files(&self, prefix: &str, token: Option<String>)
        -> Result<ListResult, AppError>;

    async fn stat(&self, path: &str) -> Result<FileMeta, AppError>;
}
```

三个方法对应三类 API：

| Trait 方法 | HTTP 端点 | 用途 |
| --- | --- | --- |
| `get_file` | `/api/proxy/{*key}` | 流式取文件，透传 `Range` |
| `list_files` | `/api/list?prefix=&page_token=&skip_pages=` | 目录列举，支持分页;`skip_pages` 让 handler 服务端 walk N 页 |
| `stat` | `/api/stat/{*key}` | 文件元信息 |

### 3.1 `Send + Sync`

后端被 `Arc<dyn StorageBackend>` 包裹，跨 axum 处理器线程共享，所以必须
线程安全。两种现有实现都是「只读 + 无状态」（持有 client 句柄 / 根路径），
天然满足。

### 3.2 异步通过 `async_trait`

Rust 当前的 native async trait 还不支持 dyn 分发（trait object），
`#[async_trait]` 把每个 async fn 改写成返回 `Pin<Box<dyn Future>>` 的同步签名，
代价是每次调用一次堆分配——对 HTTP-request 粒度的开销可忽略，换来 dyn 兼容。

### 3.3 路径类型：`&str` 而非 `&Path`

* S3 后端的 key 本质就是字符串；
* Local 后端在 `resolve()` 里再转 `PathBuf` 做安全校验；
* HTTP 路径段直接以字符串形式从 axum 取出，不引入额外的转换层。

因此 trait 的边界一律使用 `&str`，统一两种后端的调用约定。

## 4. 关键类型

### 4.1 `GetOptions`

```rust
#[derive(Debug, Clone, Default)]
pub struct GetOptions {
    pub range: Option<String>,   // 原样转发 HTTP `Range` 头
}
```

预留为结构体而非裸 `Option<&str>`，方便未来加 `if-none-match` / 选定版本号 /
解码偏好等参数，不破坏 trait 签名。

### 4.2 `StorageResponse`

```rust
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send>>;

pub struct StorageResponse {
    pub body: ByteStream,
    pub content_length: Option<u64>,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_range: Option<String>,
    pub is_partial: bool,           // 触发 206 vs 200
}
```

* `body` 用 `ByteStream` 类型别名，避免每个使用点都写一长串泛型；流的 item
  统一为 `io::Error`，S3 SDK 的错误在 backend 内已被映射过。
* `is_partial = true` ⇒ handler 写 `206 Partial Content` + `Content-Range`；
  否则写 `200 OK`。这两条由 backend 在解析 / 转发 `Range` 时决定，
  handler 层只是镜像。

### 4.3 `FileMeta` / `FileEntry` / `ListResult`

```rust
pub struct FileMeta {       // stat 返回
    pub path: String,
    pub size: u64,
    pub etag: Option<String>,
    pub content_type: Option<String>,
    pub last_modified: Option<String>,
    pub is_dir: bool,
}

pub struct FileEntry {      // list 中的单项
    pub key: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub is_dir: bool,
}

pub struct ListResult {
    pub entries: Vec<FileEntry>,
    pub next_token: Option<String>,        // None ⇒ 最后一页
    pub walked_tokens: Vec<String>,        // 仅 handler walk 时填充，见 §4.4
    pub total_pages: Option<u64>,          // 后端能廉价知道时填，否则 None
}
```

约定：

* **目录用尾随 `/` 标识**（`is_dir = true` 时 key 形如 `"videos/"`），与 S3 的
  CommonPrefix 行为一致；local 后端在 `relative_key()` 主动补 `/`。
* **`last_modified` 是字符串**：S3 给的是 RFC 3339（SDK 的 `DateTime` 转字符串），
  local 给的是 Unix 秒数。前端只做展示，不做时间运算，因此延后到 UI 决定如何
  格式化，trait 层不强制日期表达式一致性。
* **目录的 `size` 固定为 0**：S3 没有目录概念，CommonPrefix 没有大小；local
  目录大小语义模糊（含子项 vs 不含），统一记 0 避免给前端错觉。
* **`total_pages` 由后端按性价比决定**：Local fs 在现有 `read_dir` 扫描里顺便
  计数，几乎零成本；S3 没有便宜的 count API（数完整 chain = 拉到最后一页同
  代价），永远填 `None`。前端在 `None` 时只显示 `Page X`，有值时显示 `Page X / Y`。

### 4.4 分页 token：客户端不透明 + 服务端可选 walk

`next_token` 由后端定义、由后端解析，对客户端完全不透明：

* S3 透传 `continuation_token`（带一套 v2 → v1 marker 的兼容回退）；
* Local 用上一页最后一个 key 当游标（"keyset pagination"，O(page_size) 内存）。

客户端把 `next_token` 原样回传即可，无需理解其格式。这一约定让我们换实现
不必动 API。

**`skip_pages` 服务端 walk**：客户端跳到第 N 页时若手头没有对应的 token，
可以传 `skip_pages = N - 已知页数`，handler 在 `list_handler` 里循环调用
`list_files` N 次推进 cursor，把每一步的 `next_token` 记到响应的
`walked_tokens` 数组里，最后再返回目标页的 entries。这样跳页只要 1 次 HTTP
往返(后端内部仍是 N 次 list 调用 —— token chain 本质是顺序的,只是省了
浏览器侧 N - 1 次往返)。Handler 把 `skip_pages` clamp 到
`MAX_SKIP_PAGES = 100`,大跳由前端分批触发。trait 层不动 —— walk 是
handler 层的循环,后端只需实现 `list_files`。

## 5. 现有后端

### 5.1 `LocalFsBackend` (`local.rs`)

* 配置：`root_path`（绝对路径，支持 `~/` 展开）、`follow_symlinks`（默认 true）。
* **路径校验** 在 `resolve()` 完成：拒绝 `..` / 绝对路径 / Windows 前缀，
  防止越权读出根之外的文件。
* **Range 解析** 在后端本地完成（`parse_range`），支持 `bytes=A-B` / `bytes=A-` /
  `bytes=-N` 三种形式，越界返回 `AppError::InvalidRange` → 416。
* **list 分页** 用"max-heap + keyset 游标"实现：每次读完目录后保留按 key
  字典序最小的 `LIST_PAGE_SIZE + 1` 项，多出的 1 项告诉我们是否还有下一页。
  内存上限 O(page_size)，对超大目录友好。
* **Symlink 策略**：`follow_symlinks = false` 时，叶子是 symlink 一律返回
  `Forbidden`；目录 listing 中 symlink 以 `lstat` 元信息出现，不跟进。

### 5.2 `S3Backend` (`s3.rs`)

* 走 `aws-sdk-s3 + aws-config`，**初始化时只构造 client**，不打网络请求；
  因此一个配置错误的 endpoint 只会在第一次请求时报错，不会拦住 server 启动。
* **路径风格**：自定义 endpoint 时默认 `force_path_style = true`（MinIO /
  LocalStack / Ceph 必须用 path-style），公共 AWS 自动切回 virtual-host。
  AOSS / OSS-internal 之类只接受 virtual-host 的网关可通过配置关掉
  `force_path_style`。
* **Range 解析** 完全交给 S3 服务端，handler 把 `Range` 原样塞进 SDK 调用，
  响应里的 `Content-Range` 决定 `is_partial`。
* **目录抽象**：用 `delimiter=/` 把 `CommonPrefixes` 当目录列出，对象当文件。
* **错误映射**：`classify_s3_status()` 把 HTTP 状态码 + AWS 错误码合成
  `AppError`：404 → `NotFound`，403 / `AccessDenied` → `Forbidden`，
  416 / `InvalidRange` → `InvalidRange`，其余 → `Backend`。

## 6. 工厂与注册表 (`factory.rs`)

```rust
pub struct BackendRegistry {
    pub backends: HashMap<String, NamedBackend>,
    pub invalid: HashMap<String, InvalidStorageEntry>,
    pub order: Vec<String>,        // 配置声明顺序，包含 valid + invalid
    pub default_name: String,      // active=true 的那个，否则配置中第一项
}

pub struct NamedBackend {
    pub name: String,
    pub r#type: StorageType,
    pub backend: Arc<dyn StorageBackend>,
    pub details: StorageDetails,   // bucket/endpoint/region 或 root_path
}

pub struct InvalidStorageEntry {
    pub name: String,
    pub r#type: StorageType,
    pub reason: String,
    pub details: StorageDetails,
}

pub enum StorageDetails {
    S3 { bucket: String, endpoint: Option<String>, region: Option<String> },
    Local { root_path: String },
}
```

### 6.1 宽松启动策略

`create_registry()` 是 **lenient**：

* **默认存储（default）必须 init 成功**——server 无法在没有 default 的前提下
  服务任何不带 `?storage=` 的请求；失败直接 `bail!()`。
* **其它存储 init 失败** ⇒ 记 `tracing::warn!`，归入 `invalid` 表，
  继续启动。访问该 storage 的请求由 handler 返回 503
  (`AppError::StorageInvalid`)，UI 把它标为 `invalid`（不能选）。

这让"一份配置跨多环境"成为可能——本地 dev 环境上不可达的 S3 不会拖累
其他可用的存储。

### 6.2 `StorageDetails` 与 API 暴露

`StorageDetails` 携带"用于辨认 storage 是谁"的信息（bucket、endpoint、
root path），由 `extract_details()` 从配置抽取。**严禁包含凭据**——
access_key / secret_key 永远不会经此路径到达 API。

handler 把它拆分成扁平 JSON 暴露给 `/api/storages`，供 SPA 在选择对话框中
渲染"这条 storage 的标识信息"。

## 7. 错误模型

```rust
pub enum AppError {
    NotFound(String),            // 404
    Forbidden(String),           // 403
    InvalidRange(String),        // 416
    InvalidPath(String),         // 400
    Io(io::Error),               // 500 (其中 NotFound 子类映射为 404)
    Backend(String),             // 500
    StorageInvalid(String),      // 503  ← lenient 启动产物
    Unsupported(String),         // 400
}
```

* 任何 backend 内部错误（`std::io::Error` / `aws_sdk_s3::Error`）**必须** 在
  backend 边界映射为 `AppError`，不允许把 SDK / std 错误透露到 handler。
* `IntoResponse` 实现保证 HTTP 状态码与 JSON 错误体 `{"error":..., "message":...}`
  的一致性（`src/error.rs`）。

## 8. 设计取舍

### 8.1 流式而非缓冲

`get_file` 强制返回 `Stream<Bytes>`。理由：

* 单次下载几 GiB 不会击穿内存；
* `Range` 请求天然适配——后端 seek + take 即可，无需先读全文件再切片；
* axum 的 `Body::from_stream` 一行接入。

### 8.2 一个 trait 覆盖三种操作

而不是拆成 `Reader` / `Lister` / `Stater` 三个 trait：当前所有后端都同时
实现这三个能力，分开反而要写更多 `where T: A + B + C` 约束。如果未来出现
"只读不列"的后端，再拆 trait 也来得及。

### 8.3 路径 vs key

trait 选择 `&str path` 而不是 `PathBuf`，因为：

* S3 key 不是文件系统路径，可能含 S3 允许、Path 拒绝的字符；
* 路径校验是 backend 的责任，不应由调用方先 normalize。

### 8.4 分页 token 的语义不写在 trait 上

trait 只保证「同一个 backend 内 token 闭环可用」，不保证不同 backend 之间
token 兼容。这一约束让 local 用 keyset、S3 用 SDK continuation token 各取所
长，互不干扰。

## 9. 扩展指南：新增一种 backend

以"添加 WebDAV backend"为例：

1. **新建文件** `src/storage/webdav.rs`，定义 `WebDavBackend { client, base_url }`。
2. **实现 trait**：把三个方法对应到 WebDAV 的 `GET` / `PROPFIND` / `HEAD`，
   把响应映射成 `StorageResponse` / `ListResult` / `FileMeta`。错误用同样的
   "状态码 → `AppError`"思路集中映射，**不要** 把 reqwest 错误抛出 backend。
3. **扩展配置**：在 `src/config.rs` 的 `StorageType` 枚举加 `WebDav`，
   `StorageConfig` 加 `webdav: Option<WebDavConfig>`，`validate()` 加非空校验。
4. **扩展 details**：在 `StorageDetails` 加一个 `WebDav { base_url: String }`
   分支，`extract_details()` 补齐对应 case，handler 的 `split_details()`
   也加对应分支。配套修改前端 `StorageDescriptor`。
5. **接到工厂**：`factory.rs::build_one()` 加 `StorageType::WebDav` 分支，
   调用 `WebDavBackend::new(...)`，返回 `Arc<dyn StorageBackend>`。
6. **写测试**：mock HTTP server / 使用真实 WebDAV 服务器跑集成测试。

不需要动 handler / thumbs / 任何路由——这正是 trait 抽象的目的。

## 10. 测试约定

* **Unit tests** 用 `#[cfg(test)] mod tests` 直接放在后端文件末尾。
* **Local backend** 测试用 `std::env::temp_dir()` 建临时目录，测路径越权、
  分页、symlink、Range 边界。
* **S3 backend** 单测不打外网；端到端的 S3 行为靠"用 MinIO 跑本地实例"
  人工验证（开发指南有说明）。
* **factory** 当前未单测——构造完整 `Config` 较冗长；如果后续 lenient 策略
  改动频繁，可加 `cfg!(test)` 钩子注入 mock backend 进行更细的覆盖。
