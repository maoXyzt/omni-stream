# OmniStream 发版手册

本文档仅面向仓库管理员。

仅安装与使用请看仓库根目录的 [README.md](../README.md)；开发指南见 [development_guide.md](development_guide.md)。

## 1. 总览

发版分两段：**本地** 用 `cargo release` 同时 bump 版本号 + 打 tag + 推送；**CI** 监听 `v*` tag，自动编译四个平台二进制、创建 GitHub Release、并发布到 crates.io。

```
本地: cargo release patch --execute
        │   bump Cargo.toml + Cargo.lock
        │   commit "release: 0.1.1"
        │   tag v0.1.1
        └─→ git push (branch + tag)
                            │
GitHub Actions ←────────────┘
  ├─ frontend       (pnpm build)
  ├─ backend (×4)   (linux-gnu / linux-musl / aarch64-darwin / windows-msvc)
  ├─ release        (GitHub Release + tarball/zip + sha256)
  └─ publish        (cargo publish → crates.io)
```

## 2. 一次性准备

### 2.1 安装 cargo-release

```bash
cargo install cargo-release
```

### 2.2 准备 crates.io token（仓库管理员一次性）

1. 在 <https://crates.io/settings/tokens> 创建 token，scope 勾选 `publish-update`（首次发布额外勾 `publish-new`），crate 限定为 `omni-stream`。
2. GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**：
   - Name: `CARGO_REGISTRY_TOKEN`
   - Value: 上一步生成的 token

token 只在第一次配置和需要轮换时操作，日常发版无需关心。

## 3. 发版流程

### 3.1 切换到发版分支

`cargo-release` 默认只允许从 `main` / `master` 发版。先合并 `dev` → `main`：

```bash
git checkout main
git pull
git merge --ff-only dev   # 或走 PR 合并到 main
```

> 如确需从 `dev` 直接发版，可在 `Cargo.toml` 的 `[package.metadata.release]` 加 `allow-branch = ["main", "dev"]`。

### 3.2 干跑确认

不带 `--execute` 是 dry-run，会打印将要执行的所有动作但不真改：

```bash
cargo release patch          # 0.1.0 → 0.1.1
cargo release minor          # 0.1.0 → 0.2.0
cargo release 0.5.0          # 指定版本
```

确认输出包含：

- `Cargo.toml` 与 `Cargo.lock` 的 `version` 改写
- commit message: `release: <new-version>`
- tag: `v<new-version>`
- push to `origin`

### 3.3 真正执行

```bash
cargo release patch --execute
```

执行后 `cargo-release` 会自动：

1. 改写 `Cargo.toml` + `Cargo.lock` 的 `version`
2. `git commit -m "release: <new-version>"`
3. `git tag -a v<new-version> -m "release <new-version>"`
4. `git push` + `git push --tags`

### 3.4 等 CI 跑完

1. <https://github.com/maoXyzt/omni-stream/actions> 观察 `build` workflow
2. 顺序：`frontend` → `backend (×4)` → `release` + `publish` 并行
3. 全绿后：
   - GitHub Releases 出现 `v<new-version>`，挂着 4 份压缩包 + `.sha256`
   - <https://crates.io/crates/omni-stream> 出现新版本

## 4. 防呆机制

发错版本的途径基本都被堵住：

| 风险 | 防御 |
|---|---|
| `Cargo.toml` 版本和 tag 不一致 | `cargo release` 同一动作产出两者；CI `publish` job 还会再校验一次 tag↔manifest |
| 本地误跑 `cargo publish` | `Cargo.toml` 的 `publish = false` 让 `cargo release` 跳过本地发布；只有 CI 用 `secrets.CARGO_REGISTRY_TOKEN` 推 |
| 平台编译挂掉但已发包 | `publish` job 依赖 `backend` 全绿；任何平台失败则不会触发 `cargo publish` |
| `frontend/dist/` 漏更新 | 每个 backend 和 publish job 都从 `frontend` job 上传的 artifact 拉 dist，工作流内自洽 |
| PR 引入 metadata 回归 | PR 触发 `publish-dry-run` job 跑 `cargo publish --dry-run` |

## 5. 故障排查

### `cargo release` 报 `branch 'dev' is not whitelisted`

发版分支不在 `allow-branch` 里。要么切回 `main`，要么按 §3.1 末尾说明改配置。

### CI `publish` job 报 `crate version is already uploaded`

同一 `version` 在 crates.io 上已存在。crates.io 不允许覆盖，必须 bump 一个新版本号重发。本次的 `v<x.y.z>` tag 也建议 `git tag -d v<x.y.z> && git push --delete origin v<x.y.z>` 删掉，避免 GitHub Release 卡在半成品状态。

### CI `publish` job 报 `verify-tag-version` 失败

tag 名和 `Cargo.toml` 的 `version` 对不上。一般是手动 `git tag` 而绕过了 `cargo release` 导致。删 tag 重来：

```bash
git tag -d v<wrong>
git push --delete origin v<wrong>
cargo release <correct> --execute
```

### CI `publish` 报 `frontend/dist/ does not exist`

`frontend` artifact 过期或 backend job 失败导致 publish 跳过下载。重跑 workflow 即可——`frontend` job 会重新生成 dist。

### crates.io 上能看到包但 docs.rs 一直在排队

正常现象，docs.rs 构建队列经常 30 分钟以上。如果超过几小时仍未出，去 <https://docs.rs/crate/omni-stream/latest/builds> 查具体日志（一般是 `frontend/dist/` 漏在 tarball 里导致 `rust-embed` 编译失败）。

## 6. 撤回已发版本

crates.io 不允许删除版本，只能 `yank`（标记为不推荐使用，新项目无法添加这个版本作依赖，已锁定的项目仍可下载）：

```bash
cargo yank --version 0.1.1
cargo yank --version 0.1.1 --undo   # 反悔
```

GitHub Release 可以直接在网页删除；git tag 用 `git push --delete origin v0.1.1` 移除。
