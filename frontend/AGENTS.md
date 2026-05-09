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
* **Routing**: `React Router v6`。

## 3. 工程规范

* **API 交互**: 所有 API 请求路径必须为相对路径 (例如 `/api/list`，`/api/proxy/:key`)。
* **组件管理**:
  * 基础 UI 组件存放于 `src/components/ui/` (由 `shadcn/ui` 生成)。
  * 业务组件存放于 `src/components/`。
  * 禁止安装大型 UI 库包，仅按需添加 `shadcn/ui` 组件源码。
* **样式处理**: 使用 `Tailwind CSS` 进行布局，所有类名冲突处理需通过 `lib/utils.ts` 中的 `cn()` 工具函数实现。

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
* **防御性渲染**: 必须为所有 API 请求提供 `Skeleton` (骨架屏) 和 `ErrorState` (错误提示)，严禁直接渲染 `undefined` 数据。
* **类型定义**: API 返回的 `FileMeta` 等对象必须有明确的 TypeScript 接口定义。
* **生产约束**: 禁止引入任何需要 SSR 或 Node.js Server 运行时的依赖，确保产物为纯静态文件。
