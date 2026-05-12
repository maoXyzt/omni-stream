# OmniStream 开发指南

面向需要从源码构建、或参与前后端开发的同学。仅安装与使用请看仓库根目录的 [README.md](../README.md)；发版流程见 [how_to_release.md](how_to_release.md)。

## 1. 环境要求

- **Rust 1.91+**（Cargo edition `2024`；MSRV 跟随依赖逐步抬升，详见 `Cargo.toml` 的 `rust-version`）
- **Node 24.15.0**（`frontend/.node-version` 已声明，建议用 `fnm` 自动切换）
- **pnpm 10.x**（`frontend/package.json` 锁定 `pnpm@10.18.3`，corepack 或 `npm i -g pnpm@10` 都行）

## 2. 首次准备

```bash
git clone https://github.com/maoXyzt/omni-stream.git
cd omni-stream/frontend && pnpm install && cd ..
cp config.example.toml config.toml   # 按需编辑
```

## 3. 构建

推荐使用仓库根目录的 `start.sh`（脚本会自动 `fnm use`）。脚本默认导出 `OMNI_CONFIG=./config.toml`、`OMNI_BACKEND_URL=http://127.0.0.1:28080`（与 Vite 反代目标一致；若改了 `server.port` 请同步改环境变量）、`CARGO_TARGET_DIR`（默认指向临时目录以减轻仓库内 `target/` 体积）。用法：

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
cd frontend && pnpm build && cd ..   # 或仅用 ./start.sh build --frontend
cargo build --bin omni-stream
cargo test --bin omni-stream
```

仅打 release 二进制、不用脚本时：

```bash
cargo build --release --bin omni-stream
```

## 4. 开发模式（前后端分跑）

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

## 5. 项目结构

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
├── .github/workflows/build.yml  # CI: 前端打包 + 四平台后端编译 + Release + crates.io 发布
├── config.example.toml
└── docs/
    ├── design.md                    # 项目架构与 trait 设计
    ├── configuration_module_design.md
    ├── development_guide.md         # 本文档
    └── how_to_release.md            # 发版流程
```
