# OmniStream 编辑功能指南

OmniStream 在 0.8.0 之后陆续引入了对存储数据的**写入/转换**能力。这些功能均需满足一套统一的前置条件才会激活，本文介绍具体的开启方式和使用方法。

---

## 1. 前置条件：三重门

所有写入功能共享同一个激活条件——三项缺一不可：

| 条件 | 说明 |
|------|------|
| **DuckDB 编译特性** | 二进制必须以 `--features duckdb` 构建。PyPI wheel 已内置；`cargo install omni-stream` 默认**不**包含，需自行从源码构建。 |
| **`auth.enabled = true`** | API 必须开启 Bearer Token 鉴权。写入功能绝不在无鉴权的开放 API 上激活。 |
| **`[sql] enabled = true`** | SQL/写入端点的独立开关，默认开（`true`）。可用它单独关闭，不影响鉴权设置。 |

只要三项同时成立，前端就会自动显示写入相关的 UI 控件；否则控件不可见，API 也会拒绝调用（403）。

### 最简配置示例

```toml
[auth]
enabled = true
token = "your-long-random-token"   # 也可用环境变量 OMNI_AUTH_TOKEN

[sql]
# enabled = true   # 默认已开启，无需显式声明
```

启动时的日志会确认激活状态：

```
INFO omni_stream: SQL/convert endpoint active (DuckDB)
```

若三项未全部满足，则打印：

```
WARN omni_stream: SQL query endpoint disabled: requires auth.enabled = true and [sql] enabled
```

---

## 2. 当前可用的写入功能

### 2.1 JSONL / NDJSON → Parquet 一键转换

在文件预览页浏览 `.jsonl` 或 `.ndjson` 文件时，工具栏会出现 **"Convert to Parquet"** 按钮。点击后，服务端通过内嵌的 DuckDB 将该文件就地转换为 Parquet，写入**同一目录、同一文件名（后缀改为 `.parquet`）**。

**示例：**

```
logs/2024/events.jsonl  →  logs/2024/events.parquet
data/stream.ndjson      →  data/stream.parquet
```

**操作流程：**

1. 在文件浏览器中打开一个 `.jsonl` / `.ndjson` 文件进入预览。
2. 工具栏右侧出现 Convert to Parquet 按钮（仅当 `sql_enabled` 条件满足时可见）。
3. 点击按钮：
   - 按钮变为转圈 Spinner，期间禁止重复点击。
   - 转换成功后，页面右下角弹出成功提示，包含输出路径、写入行数和耗时，同时文件列表自动刷新，`.parquet` 文件立即出现。
   - 若目标 `.parquet` **已存在**，弹出覆盖确认框；确认后以 `overwrite=true` 重试。
   - 若存储只读或 S3 凭据无写权限，弹出可读的错误提示（如 "The storage may be read-only or your credentials lack write access"）。

**支持的存储类型：** 本地文件系统（Local）和 S3 兼容存储（含 MinIO / Ceph 等）均支持。

**超时设置：** 转换共享 `[sql].query_timeout_secs`（默认 60 秒）。超大文件可能超时，届时可在配置中适当调大：

```toml
[sql]
query_timeout_secs = 120   # 按需调整
```

---

## 3. SQL 查询编辑器（附）

写入功能依赖的 `sql_enabled` 三重门同样激活 **SQL 查询编辑器**（`POST /api/query`）。导航栏出现 "SQL" 入口后，可对任意存储执行 DuckDB SQL，包括 `SELECT`、`COPY (...) TO '...' (FORMAT PARQUET)` 等操作。SQL 编辑器的详细用法不在本文范围内，但配置上无需额外设置——开启写入功能即同时开启了 SQL 编辑器。

---

## 4. 本地 FS 的特殊注意事项

本地存储若设置了 `follow_symlinks = false`，**不支持**任何 DuckDB 功能（包括 SQL 查询和 Convert to Parquet）。原因是 DuckDB 的目录沙箱内部会跟踪符号链接，无法在这种模式下保证安全隔离。此类存储会在 API 返回 `400 Unsupported` 并附带说明。

```toml
[storages.local]
root_path = "/data"
follow_symlinks = true   # DuckDB 功能要求此项为 true（默认值）
```

---

## 5. 从源码构建（含 DuckDB 特性）

官方发布的二进制若不含 DuckDB，需自行构建：

```bash
# 仅后端（含 duckdb feature）
cargo build --release --features duckdb --bin omni-stream

# 含前端静态资源的完整产物（先构建前端，再构建后端）
cd frontend && pnpm build && cd ..
cargo build --release --features duckdb --bin omni-stream
```

构建时 DuckDB 会以源码方式编译（首次较慢，约数分钟），后续增量构建无额外开销。
