# OmniStream Frontend

OmniStream 的 SPA：浏览存储后端（本地 FS / S3）目录、按需缩略图、就地预览。
React 19 + TypeScript + Vite，构建产物嵌入 Rust 二进制随后端一起发布。

> 工程规范（必须遵守）见 `AGENTS.md`：技术栈选型、Loading 状态约定、组件位置、
> 包管理器等。README 只讲「怎么动手开发」与「东西放在哪」。

---

## 1. 速查

```fish
# 安装
pnpm install

# 开发 (默认代理 /api → http://127.0.0.1:28080)
pnpm dev
OMNI_BACKEND_URL=http://127.0.0.1:18080 pnpm dev   # 后端换端口时

# 校验
pnpm exec tsc -p tsconfig.app.json --noEmit        # 类型
pnpm lint                                          # ESLint
pnpm test                                          # 一次性 Vitest
pnpm test:watch                                    # Watch 模式

# 生产构建 (产物落到 frontend/dist/，被 rust-embed 嵌入二进制)
pnpm build
```

提交前至少跑通 typecheck + lint；改动涉及 `lib/rows-*` / `csv-parser` 时把
`pnpm test` 也跑了。

---

## 2. 与后端的关系

* 同源部署：Rust 后端 (`src/handlers.rs`) 用 `rust-embed` 把 `frontend/dist/`
  打进二进制，所有非 `/api/*` 路径回落到 `index.html`，前端路由完全自洽。
* 开发模式：Vite dev server 通过 `vite.config.ts` 把 `/api/*` 代理到
  `OMNI_BACKEND_URL`（默认 `http://127.0.0.1:28080`）；前端代码只用相对路径。
* 路由表（API）：见 `src/api/storage.ts`，包含 `/api/list`、`/api/stat/{*key}`、
  `/api/proxy/{*key}`、`/api/thumb/{*key}`、`/api/storages`、`/api/server`。
* 鉴权：Bearer token 存在 `localStorage['omni-stream:auth-token']`，由
  `apiClient` 的请求拦截器自动加到 `Authorization` 头；收到 401 自动清除（见
  `src/api/client.ts:64-78`）。`TokenPrompt` 组件负责录入。

---

## 3. 目录布局

```
src/
├── api/
│   ├── client.ts        # axios 实例 + ApiError + token 存取
│   └── storage.ts       # listFiles / statFile / proxyUrl / thumbUrl / listStorages
├── components/
│   ├── ui/              # shadcn/ui 源码（基于 Radix + Tailwind）
│   ├── preview/         # 预览器：Image / Video / Text / Csv / Parquet / Rows…
│   │                    #   registry.ts 是扩展名 → previewer 的注册表
│   ├── FileList.tsx     # 主视图：列表/网格/分屏 + 分页 + 过滤
│   ├── FileTile.tsx     # 网格单元（被 memo 包裹，10k 行也不卡）
│   ├── FileGrid.tsx     # 网格容器
│   ├── Sidebar.tsx      # 折叠树
│   ├── PathBreadcrumb.tsx / PathNavigator.tsx
│   ├── StorageSwitcher.tsx / StorageRedirect.tsx
│   ├── EntryContextMenu.tsx   # 文件 / 目录右键菜单（所有视图共享）
│   ├── PreviewModal.tsx       # 全屏预览弹窗
│   ├── RowsPage.tsx           # /r/:storage/* 表格视图（CSV / Parquet）
│   ├── TokenPrompt.tsx        # 鉴权弹窗
│   └── ViewToggle.tsx / GridFitToggle.tsx
├── hooks/               # 一律 use- 前缀；TanStack Query / 持久化偏好
│   ├── use-storage.ts   # useStorages / useServerInfo / useListFiles / useStatFile
│   ├── use-view-mode.ts / use-grid-fit.ts / use-sort-dir.ts
│   ├── use-sidebar-collapsed.ts / use-resizable-width.ts / use-tree-expanded.ts
│   ├── use-media-query.ts / use-line-numbers.ts
│   └── use-rows-presets.ts / use-rows-view-config.ts
├── lib/                 # 纯函数 + 单测
│   ├── utils.ts         # cn() —— Tailwind className 合并
│   ├── format.ts        # 字节数 / 时间 / 类型标签
│   ├── sort.ts
│   ├── highlight.ts     # highlight.js 懒加载语言包
│   ├── csv-parser.ts    + .test.ts
│   ├── parquet.ts       # hyparquet 包装
│   ├── rows-*.ts        + .test.ts   (table 视图核心逻辑)
│   └── text-chunks.ts   # 大文本按 Range 分块加载
├── types/
│   └── storage.ts       # FileEntry / ListResult / StorageDescriptor / FileMeta…
├── App.tsx              # QueryClientProvider + BrowserRouter + 路由表
├── main.tsx
└── index.css            # Tailwind v4 入口 + CSS 变量
```

* 路径别名 `@/*` → `src/*`（见 `tsconfig.app.json` / `vite.config.ts` /
  `vitest.config.ts`，三处必须保持一致）。
* `components/ui/` 下的文件由 `shadcn` CLI 生成 —— 不要手动重命名/拆分内部 API；
  扩展样式去 `components/` 里再包一层。

---

## 4. 路由

| Path | 组件 | 说明 |
|---|---|---|
| `/` | `StorageRedirect` | 跳到默认 storage 的根目录 |
| `/s/:storage/*` | `FileList` | 主浏览界面，`*` 为目录前缀 |
| `/r/:storage/*` | `RowsPage` | 表格预览 (CSV / Parquet)，`*` 为文件 key |
| 其它 | `<Navigate to="/" replace />` | |

URL 是单一事实源：当前页 (`?page=`)、分屏选中的文件、过滤词都走 query params，
**禁止** 用 `useState` 镜像 URL 状态（参考 `FileList.tsx` 的 `pageParam` /
`searchParams` 用法）。这样刷新、分享、浏览器前进后退都自洽。

---

## 5. 数据获取约定

* TanStack Query 全局 Provider 在 `App.tsx`；默认 `retry: 1`、关闭窗口
  focus refetch。
* 想增加一个 endpoint：在 `api/storage.ts` 写 fetcher，在 `hooks/use-storage.ts`
  封装 `useQuery`。**永远不要** 在组件里直接 `axios.get`。
* QueryKey 形如 `['list', storage, prefix, pageToken]`——把所有影响请求的
  入参都包进 key，否则切换 storage / prefix 时会拿到脏缓存。
* `useStorages()` `staleTime: Infinity`，可以在任何组件里随取随用，零成本。
* 列表类查询带 `placeholderData: keepPreviousData`，翻页 / 过滤切换时旧数据
  保留可见，避免骨架闪烁。
* Loading 三态：`isPending → error → empty → data` 顺序短路返回，互斥。
  细则见 `AGENTS.md` §7。

---

## 6. URL / Key 处理

* 后端 `*key` 路由要求 **保留斜杠**：`api/storage.ts:encodeKey()` 按 `/` 分段
  再 `encodeURIComponent`，自己写新 endpoint 时直接复用。
* 目录的 `entry.key` 末尾有 `/`，文件没有 —— 这是后端约定，绝对路径、面包屑、
  basename 计算都依赖它。要 strip 时用 `key.replace(/\/+$/, '')`。
* S3 多 bucket 模式 (`storage.s3.bucket === null`)：URL 第一段就是 bucket
  名。`FileList.tsx` 的 `currentBucket` 是这个模式的兜底处理示例。

---

## 7. UI / 样式

* Tailwind v4 通过 `@tailwindcss/vite` 插件加载，没有 `tailwind.config.js`；
  CSS 变量 / 主题色定义在 `src/index.css`。
* 拼 className 一律走 `cn()` (`@/lib/utils`)，否则条件 class 会被
  tailwind-merge 误判。
* 图标只用 `lucide-react`，禁止引入其它图标库。
* Tailwind JIT 不会扫到运行时拼接的字符串——`object-${fit}` 这种写法不工作，
  必须把完整 class 字面量写出来再用三元/查表选（见 `FileTile.tsx:147`）。
* 新增 shadcn 组件：`pnpm dlx shadcn@latest add <name>`，生成的源码进
  `components/ui/`。`components.json` 里的 `style: "radix-nova"` 不要改。
* 暗色模式跟随系统，无切换 UI（如需要，先动 `index.css` 的 CSS 变量）。

---

## 8. 预览器扩展

新增可预览类型 = 在 `src/components/preview/registry.ts` 的 `PREVIEW_TYPES`
里加一项：

```ts
{
  kind: 'pdf',
  extensions: ['pdf'],
  icon: FileText,
  Component: PdfPreview,    // 实现签名见 ./types.ts 的 PreviewType
}
```

* `Component` 收到 `{ fileKey, src, storage }`；`src` 就是 `proxyUrl()`。
* 大文件别一次性拉：参考 `TextPreview` 的 chunked Range 加载、`VideoPreview`
  让浏览器 `<video>` 自己处理 Range、`ParquetPreview` 用 `hyparquet`
  按 row-group 解码。

`VISUAL_GROUPS`（同文件靠下）给文件列表提供图标 + 颜色映射，覆盖面比
`PREVIEW_TYPES` 更广（音频/压缩包等显示图标但不可预览）。

---

## 9. 状态持久化

* 用户偏好（视图模式、网格 fit、分栏宽度、侧栏展开树等）走 `localStorage`，
  key 都集中在对应的 `use-*` hook 里。
* 命名规约：`omni-stream:<feature>` 或 `omni-stream:<feature>:<storage>`
  （storage scoped 的偏好用后者）。
* 跨存储清理：见 `App.tsx` 的 `TreeExpandedJanitor`——`useStorages` 解析后
  把已删 storage 的 localStorage 残留打掉。新增 storage scoped 偏好时跟着
  补对应的 janitor。

---

## 10. 测试

* `vitest`，`environment: 'node'`（纯函数测试，无 DOM）。
* 文件命名 `*.test.ts` / `*.test.tsx`，跟被测文件同目录。
* 当前覆盖：`lib/csv-parser`、`lib/rows-*`（解析 / schema / 选择器）。
* 组件层暂无测试 —— 改 `FileList` / `Sidebar` / preview 这类视图时手动验证
  golden path + 边界，必要时启动 dev server 在浏览器里试。

---

## 11. 常见坑

* **`pnpm dev` 起来后接口 502 / Connection refused** —— 后端没起，或端口不是
  默认的 `28080`，用 `OMNI_BACKEND_URL` 指过去。
* **改了组件但页面没刷新** —— Vite HMR 偶尔丢失 React 状态，按 `R` 手动
  refresh；如果改的是 `index.css` 里的 CSS 变量，必须 hard reload。
* **`pnpm build` 报 `tsc` 错** —— `noUnusedLocals` / `noUnusedParameters` 都
  开着，留临时变量会炸；用 `_` 前缀放过。
* **import 报 "verbatimModuleSyntax"** —— 只引入类型时必须 `import type {…}`，
  否则会把整个模块塞进 bundle。
* **`react-hooks/exhaustive-deps` 报 stale closure** —— 优先把依赖加上而不是
  禁规则；真要禁，在该行加 `// eslint-disable-next-line` 并附注释说明。
* **`storage` 参数到处传** —— 因为同一个 storage roster 下可能有多个 backend，
  所有读 API 都接受 `?storage=<name>`；调 fetcher 时漏传会落到 default
  storage，调试时容易看不出来。
