# OmniStream 开发指南

面向需要从源码构建、或参与前后端开发的同学。仅安装与使用请看仓库根目录的 [README.md](../README.md)；发版流程见 [how_to_release.md](how_to_release.md)。

## 1. 环境要求

- **Rust 1.91+**（Cargo edition `2024`；MSRV 跟随依赖逐步抬升，详见 `Cargo.toml` 的 `rust-version`）
- **Node v24.15.0**（`frontend/.node-version` 已声明，建议用 `fnm` 自动切换）
- **pnpm 10.18.3**（`frontend/package.json` 的 `packageManager` 字段锁定，corepack 或 `npm i -g pnpm@10` 都行）

## 2. 首次准备

```bash
git clone https://github.com/maoXyzt/omni-stream.git
cd omni-stream/frontend && pnpm install && cd ..
cp config.example.toml config.toml   # 按需编辑
```

## 3. 构建

推荐使用仓库根目录的 `start.sh`（会自动执行 `fnm use` 切换 Node 版本）。

### 3.1 `start.sh` 子命令

| 命令 | 作用 |
|------|------|
| `./start.sh` \| `./start.sh run` | 构建当前前端与含 DuckDB 的 release 后端，然后启动后端 |
| `./start.sh build` | 等同 `build --all` |
| `./start.sh build --all` \| `-a` | 前端 `pnpm build` + 含 DuckDB 的后端 release 构建 |
| `./start.sh build --frontend` \| `-f` | 仅前端静态产物 |
| `./start.sh build --backend` \| `-b` | 仅含 DuckDB 的后端 release 二进制 |
| `./start.sh -h` | 打印完整帮助 |

脚本导出两个环境变量（均可在运行前覆盖）：

- `OMNI_BACKEND_URL=http://127.0.0.1:28080` — Vite dev server 反代目标，与后端默认监听地址一致
- `CARGO_TARGET_DIR=/tmp/cargo_build_target` — 把编译产物移出仓库目录以减少磁盘占用

> **注意**：`start.sh` 默认把 release 二进制写到 `/tmp/cargo_build_target/release/omni-stream`。手动运行 Cargo 且未设置 `CARGO_TARGET_DIR` 时，产物才位于 `./target/release/`。

### 3.2 手动命令（debug 构建 / CI）

```bash
# 仅前端
cd frontend && pnpm build && cd ..

# 后端 debug 构建
cargo build --bin omni-stream

# 后端 release 构建
cargo build --release --bin omni-stream

# 跑测试
cargo test --bin omni-stream
```

## 4. 可选 Feature：DuckDB（SQL 查询 & JSONL/TSV/CSV 转换）

`duckdb` feature 默认**关闭**（`Cargo.toml` 中 `default = []`），原因是 bundled DuckDB 需要编译 C++ 代码。`cargo install omni-stream` 和未显式传入 feature 的手动 Cargo 命令不会启用；本地 `start.sh` 会显式启用。

**启用后新增的能力：**
- `POST /api/query` — Parquet 预览内嵌 SQL tab 的后端（DuckDB 执行只读查询；COPY 及写语句被拒）
- `POST /api/convert` — JSONL / NDJSON / TSV / CSV → Parquet 一键转换

这两个端点还需满足**三重门**才会激活：`duckdb feature 编入` + `auth.enabled = true` + `[sql] enabled = true`（详见 [edit_features_guide.md](edit_features_guide.md)）。

### 本地启用 DuckDB

```bash
# 后端 release 构建（含 duckdb）
cargo build --release --features duckdb --bin omni-stream

# 或直接运行（含 duckdb）
cargo run --features duckdb --bin omni-stream
```

首次构建会从源码编译 libduckdb C++（约 5–10 分钟），后续增量编译无额外开销。`httpfs` 扩展在运行时按需安装并缓存到 `~/.duckdb`，需要网络访问。

## 5. 开发模式（前后端分跑）

需要改前端并使用 HMR 时，开两个终端：

```bash
# 终端 A：构建当前前端与含 DuckDB 的 release 后端，然后启动后端
./start.sh run

# 终端 B：Vite dev server（默认端口 5173），/api/* 反代到后端
./start.sh run --frontend   # 或 -f
```

浏览器打开 `http://127.0.0.1:5173/`。如果后端不在默认端口，覆盖环境变量：

```bash
export OMNI_BACKEND_URL=http://127.0.0.1:8080
./start.sh run -f
```

Vite 的 proxy 规则在 `frontend/vite.config.ts` 中定义（`/api` → `OMNI_BACKEND_URL`）。

## 6. 测试与检查

### 后端

```bash
# 运行所有测试（不含 duckdb 相关）
cargo test

# 含 SQL/convert 套件（需 duckdb feature）
cargo test --features duckdb

# Clippy（CI 采用的严格模式）
cargo clippy --all-targets --features duckdb -- -D warnings

# 格式化（commit 前必须通过）
cargo fmt
```

> CI 的 lint job 还会执行 `cargo check --locked`（不带 duckdb）来守护 crates.io 默认构建不报错。

### 前端

```bash
cd frontend

pnpm lint           # ESLint
pnpm test           # Vitest（单次运行）
pnpm test:watch     # Vitest 监听模式
pnpm build          # tsc -b（类型检查）+ vite build
```

前端没有单独的 `type-check` script；`pnpm build` 里的 `tsc -b` 即承担类型检查。

## 7. HTTP API 速览

| 方法 | 路径 | 说明 | 鉴权组 |
|------|------|------|--------|
| GET | `/api/server` | 服务器信息（版本、auth_enabled、sql_enabled、public_read） | 读组 |
| GET | `/api/storages` | 存储列表及描述符 | 读组 |
| GET | `/api/list` | 文件目录列表（分页）| 读组 |
| GET | `/api/stat/{*key}` | 文件元信息 | 读组 |
| GET | `/api/proxy/{*key}` | 文件内容代理（支持 Range）| 读组 |
| GET | `/api/thumb/{*key}` | 缩略图（WebP，需 `thumbnails.enabled`）| 读组 |
| GET | `/raw/{storage}` / `/raw/{storage}/{*path}` | 可导航文件挂载（inline 服务；`?ls` 列目录）| 读组 |
| POST | `/api/query` | DuckDB 只读 SQL ⚠️（COPY/写语句被拒）| 读组 |
| POST | `/api/convert` | JSONL/NDJSON/TSV/CSV → Parquet 转换 ⚠️ | 写组 |
| GET | `/*` | SPA fallback（返回嵌入的前端）| 始终开放 |

⚠️ 仅在 `duckdb` feature 编入且满足三重门时注册。

**鉴权分组**：
- **读组**：默认 `public_read = true` 时无需 token；`public_read = false`（全锁定）时每个请求都要 token。
- **写组**：`auth.enabled = true` 时始终要 token，不受 `public_read` 影响。
- `/api/query` 虽是只读端点，但需要 `auth.enabled = true` 才会激活，激活后归入读组（默认模式下无需 token）。
- SPA fallback（`/`、`/assets/*`）始终开放，无 token 时前端会引导输入。

## 8. 项目结构

```text
omni-stream/
├── start.sh                  # 本地 build / run 入口脚本
├── Cargo.toml                # features（duckdb）、依赖、MSRV
├── config.example.toml       # 配置文件模板
├── pyproject.toml            # maturin 打包（PyPI binary wheel）
├── .github/
│   └── workflows/
│       └── build.yml         # 唯一 CI：lint/test/多平台编译/wheel/发布
├── src/
│   ├── main.rs               # 入口：CLI 分发、Config::load、路由注册、AppState
│   ├── config.rs             # Config / StorageConfig / S3Config / LocalConfig
│   │                         #   ThumbConfig / SqlConfig / AuthConfig
│   ├── error.rs              # AppError + IntoResponse；duckdb 下额外变体
│   ├── handlers.rs           # HTTP 处理器（list/stat/proxy/thumb/server/storages/raw）
│   │                         #   + AppState（持有 registry、thumb_state、sql_enabled、public_read）
│   ├── auth.rs               # Bearer-token 鉴权中间件
│   ├── thumbs.rs             # 缩略图生成与 LRU 缓存（含 cache CLI 子命令底层逻辑）
│   ├── cli_style.rs          # CLI 输出着色封装（nu_ansi_term）
│   ├── storage/
│   │   ├── mod.rs            # StorageBackend trait + FileMeta / FileEntry / ListResult 等
│   │   ├── factory.rs        # create_registry：从 Config 构建后端注册表
│   │   ├── s3.rs             # S3Backend（aws-sdk-s3，path-style 自动启用）
│   │   └── local.rs          # LocalFsBackend（safe_join 路径越权防护、Range 解析）
│   └── sql/                  # ← 整块受 #[cfg(feature = "duckdb")] 门控
│       ├── mod.rs            # SqlState / SqlTarget / query_handler（POST /api/query）
│       ├── convert.rs        # convert_handler（POST /api/convert）JSONL/NDJSON/TSV/CSV → Parquet
│       ├── exec.rs           # 查询执行与结果序列化（run_query）
│       ├── session.rs        # DuckDB 会话沙箱（allowed_directories / S3 凭证注入）
│       └── validate.rs       # SQL 词法白名单校验（粗筛，非安全边界）
├── frontend/
│   ├── .node-version         # v24.15.0（fnm 自动切换）
│   ├── vite.config.ts        # proxy /api → OMNI_BACKEND_URL，outDir=dist
│   └── src/
│       ├── main.tsx          # 挂载 <App>
│       ├── App.tsx           # QueryClientProvider + BrowserRouter + 路由表
│       │                     # 路由：/ → StorageRedirect
│       │                     #       /s/:storage/* → FileList（主文件浏览）
│       │                     #       /r/:storage/* → RowsPage（卡片视图）
│       │                     # （SQL 已内嵌在 Parquet 预览的 SQL tab，无独立路由）
│       ├── api/
│       │   ├── client.ts     # axios 实例、Bearer token 注入、ApiError 封装
│       │   ├── storage.ts    # listStorages / getServerInfo / listFiles / statFile
│       │   │                 #   proxyUrl / thumbUrl / rawUrl
│       │   ├── query.ts      # executeQuery → POST /api/query（DuckDB SQL）
│       │   └── convert.ts    # convertToParquet → POST /api/convert
│       ├── hooks/            # 自定义 hooks（useStorages / useServerInfo / useListFiles
│       │                     #   useFileStat / useViewMode / useSortDir / useTreeExpanded
│       │                     #   useRowsViewConfig 等，多数持久化到 localStorage）
│       ├── components/
│       │   ├── FileList.tsx  # 主文件浏览页（列表/网格视图，URL ?view= 同步）
│       │   │                 #   含 Auth Token 按钮（auth 开启但尚无 token 时显示）
│       │   ├── RowsPage.tsx  # Rows view 卡片页
│       │   ├── PreviewModal.tsx  # 全屏预览弹窗，按类型分发预览器
│       │   ├── PathBreadcrumb.tsx
│       │   ├── PathNavigator.tsx # Go-to-path 跳转（含 s3:// URI 解析）
│       │   ├── Sidebar.tsx       # 目录树侧栏
│       │   ├── FileGrid.tsx / FileTile.tsx
│       │   ├── StorageSwitcher.tsx / TokenPrompt.tsx
│       │   ├── EntryContextMenu.tsx / ViewToggle.tsx 等
│       │   │                 #   EntryContextMenu 含 "Render in new tab"（.html 用 /raw 打开）
│       │   ├── preview/      # 各类文件预览器
│       │   │   ├── registry.ts   # 预览类型注册表（扩展名 → 预览器）
│       │   │   ├── TextPreview.tsx    # 文本（Range 分块加载，语法高亮）；CSV/TSV 转换按钮
│       │   │   ├── ParquetPreview.tsx # Parquet（hyparquet 纯 JS）；含 SQL tab 切换
│       │   │   ├── ParquetSqlTab.tsx  # 内嵌 DuckDB SQL 编辑器 tab（sql_enabled 时出现）
│       │   │   ├── DataTable.tsx      # 查询/预览共享结果表格
│       │   │   ├── CsvPreview.tsx
│       │   │   ├── ImagePreview.tsx / VideoPreview.tsx / AudioPreview.tsx / PdfPreview.tsx
│       │   │   ├── GenericPreview.tsx # 兜底（下载 + 元信息）
│       │   │   └── RowsView.tsx 及相关 widget（卡片视图渲染引擎）
│       │   └── ui/           # shadcn/ui 基础组件（button/dialog/tooltip/toast 等）
│       ├── lib/              # 纯逻辑工具（无 React 依赖，多数含 .test.ts）
│       │   ├── highlight.ts  # highlight.js 按需加载（语言延迟 import）
│       │   ├── parquet.ts    # hyparquet 按需加载
│       │   ├── csv-parser.ts # RFC 4180 CSV/TSV 流式解析
│       │   ├── text-chunks.ts # Range 分块文本读取（CHUNK_BYTES = 1 MiB）
│       │   ├── rows-*.ts     # Rows view 引擎（schema/selector/eval/paths/applicability）
│       │   ├── path.ts / route-path.ts / resolve-uri.ts / storage-display.ts
│       │   └── utils.ts / format.ts / sort.ts / thumbnail.ts 等
│       └── types/
│           └── storage.ts    # 所有共享类型（FileEntry / StorageDescriptor / ServerInfo
│                             #   ConvertResult / QueryResult 等）
└── docs/
    ├── design.md                       # 项目架构与 trait 设计
    ├── development_guide.md            # 本文档
    ├── configuration_module_design.md  # 配置模块设计
    ├── edit_features_guide.md          # 编辑功能（SQL/Convert）开启与使用指南
    ├── how_to_release.md               # 发版流程
    ├── storage_trait_design.md         # StorageBackend trait 设计
    ├── parquet_rows_view_spec.md       # Rows view 技术规格
    └── parquet_rows_view_user_guide.md # Rows view 用户指南（配置写作手册）
```

## 9. 打包与发布概览

### CI 自动构建（`build.yml`）

触发条件：push `main` / `v*` tag / PR（纯 `.md`/`docs/` 改动不触发）。

| Job | 作用 |
|-----|------|
| `frontend` | pnpm install → lint → `pnpm build` → 上传 dist artifact |
| `lint` | cargo fmt --check → clippy `--features duckdb -D warnings` → test `--features duckdb` → check（无 feature，守护 crates.io 默认构建） |
| `backend` | 三平台矩阵 release 编译（linux-gnu + duckdb ✅ / darwin + duckdb ✅ / linux-musl 无 duckdb ❌） |
| `wheels` | maturin 打 PyPI binary wheel（各平台，musl 不带 duckdb） |
| `release` | 建 GitHub Release，上传二进制（仅 tag） |
| `publish` | `cargo publish` 到 crates.io（仅 tag） |
| `publish-pypi` | 上传 wheels 到 PyPI（仅 tag，OIDC Trusted Publisher） |

### 本地打 PyPI Wheel

```bash
# 需要先 `pip install maturin`
maturin build --release --features duckdb
```

产物为 `target/wheels/omni_stream-*.whl`（平台原生 binary wheel，`bindings="bin"` 模式）。详细发版步骤见 [how_to_release.md](how_to_release.md)。
