# OmniStream 前端开发 AGENTS.md

## 1. 项目概况

* **目标**: 构建一个单页面应用 (SPA) 用于浏览与管理存储后端的文件。
* **构建工具**: `Vite` (严禁使用 `Next.js`)。
* **部署模式**: 前端资源构建后通过 `rust-embed` 嵌入到 Rust 二进制文件中，与后端同源部署。

## 2. 技术栈栈选型 (必须遵守)

* **Core**: `React 18+`, `TypeScript (Strict Mode)`。
* **UI System**: `shadcn/ui` (基于 `Radix UI` 与 `Tailwind CSS`)。
* **Icons**: `lucide-react`。
* **Data Fetching**: `TanStack Query` (React Query)。
* **HTTP Client**: `Axios`。
* **Routing**: `React Router v7`。

## 3. 工程规范

* **API 交互**: 所有 API 请求路径必须为相对路径 (例如 `/api/list`，`/api/proxy/:key`)。
* **组件管理**:
  * 基础 UI 组件存放于 `src/components/ui/` (由 `shadcn/ui` 生成)。
  * 业务组件存放于 `src/components/`。
  * 禁止安装大型 UI 库包，仅按需添加 `shadcn/ui` 组件源码。
* **样式处理**: 使用 `Tailwind CSS` 进行布局，所有类名冲突处理需通过 `lib/utils.ts` 中的 `cn()` 工具函数实现。
* **包管理**: 统一使用 `pnpm` 进行依赖安装、脚本执行与锁文件维护。

## 4. 目录结构

```text
frontend/src/
├── api/             # Axios 实例配置、API 请求函数
├── components/
│   ├── ui/          # shadcn/ui 基础组件
│   └── ...          # 业务逻辑组件
├── hooks/           # TanStack Query Hook 封装
├── lib/             # 工具函数 (cn, utils)
├── types/           # TypeScript 接口定义
└── main.tsx         # 入口点
```

## 5. 开发任务流水线 (Agent Instructions)

### Task 1: 环境初始化

* 安装 `vite`, `react`, `typescript`, `tailwindcss`, `shadcn/ui`。
* 配置 `vite.config.ts`，确保 `build.outDir` 指向后端项目的 `frontend/dist`。

### Task 2: 核心 API 层

* 配置 `Axios` 实例：基础路径为空字符串，统一处理 HTTP 错误（如 401, 404）。
* 基于 `TanStack Query` 编写 Hook：`useListFiles(prefix: string, token: string)` 和 `useFileStat(key: string)`。

### Task 3: 核心业务视图

* **FileList**: 使用 `shadcn/ui` 的 `Table` 组件实现。支持通过 `prefix` 状态切换目录。
* **Breadcrumb**: 基于 `shadcn/ui` 的 `Breadcrumb` 组件实现路径导航。
* **PreviewModal**: 基于 `Dialog` 组件。根据文件扩展名，逻辑分支处理：图片显示 (`img`) 与 视频显示 (`video`，支持 Range 请求)。

## 6. 开发范式 (MUST FOLLOW)

* **流式处理**: 对于视频预览，利用浏览器对 `<video>` 标签的 `Range` 请求支持。若发生鉴权问题，优先通过 URL 参数传递 Token。
* **防御性渲染**: 必须为所有 API 请求提供 `Skeleton` (骨架屏) 和 `ErrorState` (错误提示)，严禁直接渲染 `undefined` 数据。具体的 Loading 行为细则见 §7。
* **类型定义**: API 返回的 `FileMeta` 等对象必须有明确的 TypeScript 接口定义。
* **生产约束**: 禁止引入任何需要 SSR 或 Node.js Server 运行时的依赖，确保产物为纯静态文件。

## 7. Loading 状态处理规范 (MUST FOLLOW)

* **状态字段**: 首次加载用 `isPending` + `Skeleton`；后台刷新用 `isFetching`，保留旧 UI 仅加轻量提示（顶部进度、`Loader2`、`opacity-60`）。禁止使用 `isLoading`，禁止用 `useState` 镜像 Query 状态。
* **Skeleton 形状**: 行数、列数、宽高、圆角须与真实内容近似以防 CLS；作用域限定在依赖该请求的子区域，无关区域保持可交互。可参考 `FileList.tsx` 中按视图模式拆分的三种骨架。
* **分页 / 过滤**: 列表类 Query 必须配 `placeholderData: keepPreviousData`（见 `src/hooks/use-storage.ts`）；翻页 /「加载更多」按钮在 `isFetching` 期间 `disabled`，文案换为 `Loader2` + 动名词。
* **三态收敛**: 视图按 `isPending → error → empty → data` 顺序短路返回，三态互斥；错误态就近用 `<Alert variant="destructive">` 展示，并暴露 `refetch()` 供重试。
* **Mutation 反馈**: 提交按钮在 `isPending` 期间 `disabled` + `Loader2`，文案改为动名词；行内编辑 / toggle / 删除走乐观更新（`onMutate` + `onError` 回滚），仅对受影响行加 `opacity-60`，避免整页遮罩。
* **指示器选型**: 整块占位用 `Skeleton`，按钮 / 小区域用 `Loader2` + `animate-spin`（`size-4`）；同一区域只允许一个指示器，禁止骨架 + spinner 并存。
* **取消与竞态**: 远程数据一律走 TanStack Query，由 `queryKey` 处理失效与取消；自管异步（WebWorker、流式解码）必须用 `AbortController` 或在 effect 清理函数里设 `cancelled` 标志位。
