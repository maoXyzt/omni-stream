# Parquet Rows 视图设计文档

## 1. 概述

OmniStream 的 `ParquetPreview` 模态有两个 Tab：

* **Schema** — 展示列类型；
* **Data** — 100 行 / 页的紧凑表格。

对 ML/数据集场景（一行里同时包含长 prompt、原图、编辑图）来说，表格视图把每一行
都压成一条 line-clamp 的窄行，看起来非常吃力。**Rows 视图**作为一个**与文件浏览器
同级的顶层页面**（路由 `/r/:storage/*`，平行于文件列表的 `/s/:storage/*`），把每一行
渲染成卡片，并允许用户通过一份 **JSON 规则**自定义"哪列应当以什么形式显示"。

设计要点：

* 进入 Rows 视图是一次完整的页面切换 —— 浏览器 Back 把你送回文件列表 + 模态预览；
* URL 是 **路径** 而不是 **查询参数**：`/r/mybucket/data/train.parquet`，分享更直观；
* 规则通过 lz-string 压缩后挂在 `?rows=…`，与所在文件路径耦合，避免跨文件配置漂移。

## 2. 用户视角

### 2.1 顶层布局

```
/r/mybucket/datasets/train.parquet?rows=N4Igz…
┌──────────────────────────────────────────────────────────────────────┐
│ [← Files]  train.parquet                            ┌── Rows view ──┐│
│            mybucket · datasets/train.parquet        └──────────────-─┘│
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│ [Rules ▢]   3 of 1,234 rows loaded                                   │
│                                                                      │
│ ┌─ row 1 ─────────────────────────────────────────────────────┐      │
│ │ prompt                                                       │      │
│ │   ┌────────────────────────────────────────────────────────┐ │      │
│ │   │ A cat sitting on a windowsill at sunset…               │ │      │
│ │   └────────────────────────────────────────────────────────┘ │      │
│ │ image            image_edit                                  │      │
│ │   ┌─────────┐      ┌─────────┐                               │      │
│ │   │ <img>   │      │ <img>   │                               │      │
│ │   └─────────┘      └─────────┘                               │      │
│ └──────────────────────────────────────────────────────────────┘      │
│                  ┌─ row 2 ─ … ─┐                                     │
│                  [  Load 20 more  ]                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 进入 Rows 视图

唯一的"入门按钮"在 parquet 预览模态里：

* 在文件列表里点 `*.parquet` → 打开 `PreviewModal` → 顶部 TabsList 右侧有一个
  **`Browse as cards`** 按钮，点击它调用 `navigate(/r/<storage>/<file>)`，
  把当前 URL 里的 `?rows=…`（如果有）一并 forward 到新路由。

直接打开 / 分享的 URL 同样有效：

* `/r/<storage>/<file>` — 空规则的 Rows 页面；
* `/r/<storage>/<file>?rows=<lz-string>` — 完整视图（分享他人时用的形态）。

页面顶部的 **`← Files`** 按钮回到 parquet 所在目录的文件列表；浏览器 Back 同样可用。

### 2.3 其它

* 卡片之间垂直堆叠，`main` 容器原生滚动。
* 底部 `Load N more` 按钮按 **20 行 / 批** 增量加载；到达文件末尾后显示 `End of file`。
* 右上角 `Rules` 按钮打开 **JSON 编辑器对话框**，Save 即写入 URL。
* 无规则时，主区显示 "No rules configured" 空态卡 + CTA，用户必然要打开 Rules 对话框
  才能看到任何内容。

## 3. 规则 Schema

```ts
type Rule =
  | { column: string; kind: 'text';  label?: string }
  | { column: string; kind: 'image'; label?: string; pathPrefix?: string }

type RulesConfig = Rule[]
```

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `column` | 全部 | parquet 列名 |
| `kind` | 全部 | `"text"` 或 `"image"`，决定渲染组件 |
| `label` | 全部 | 卡片中显示的标题，缺省取 `column` |
| `pathPrefix` | `image` | 与单元格值拼接后作为存储路径解析 |

最小示例：

```json
[
  { "column": "prompt", "kind": "text" },
  { "column": "image", "kind": "image", "pathPrefix": "./" },
  { "column": "image_edit", "kind": "image", "pathPrefix": "../edits/" }
]
```

### 3.1 渲染规则

* `text`：使用 `formatCell(value)` 转字符串后放进多行 `<pre>`（保留换行、限高滚动）。
  `formatCell` 复用自 `src/lib/parquet.ts`，已经处理 bigint / `Uint8Array` / `Date` /
  STRUCT / LIST 的展示。
* `image`：把 `pathPrefix + value` 经 §3.2 的相对路径解析后得到的存储 key，通过
  `proxyUrl(key, storage)`（`src/api/storage.ts`）拼出 `/api/proxy/{key}?storage=…` 作为
  `<img src>`。`<img onError>` 触发后切换为"failed to load"提示，**不**回退到浏览器
  默认的破图图标。
* `image` 列单元格容忍三种形态：纯字符串、`{path}`、`{uri}`、`{url}`、`{src}` 结构体；
  其它形态返回 `null` 并显示 "no image path" 提示。
* 规则引用的列在当前文件中**不存在**时，渲染一条虚线占位的
  `column "foo" not in this file` 提示，而不是留空。这样跨文件复用同一份 URL 不会让
  视图静默"消失"。

### 3.2 图片路径解析

`pathPrefix` 的语义是 **相对于当前 parquet 文件所在的目录** —— 数据集惯例本来就
是"图片散落在 parquet 旁边的目录里"，让规则不必每次都重复整个 dataset 前缀。

| `pathPrefix` 写法 | 含义 |
| --- | --- |
| 缺省 / `""` / `"./"` | 与 parquet 同目录 |
| `"../"` | parquet 的上级目录 |
| `"../edits/"` | parquet 的上级目录下的 `edits/` |
| `"sub/"` | 相对路径 = 同目录下的 `sub/` |
| `"/datasets/foo/"` | 以 `/` 开头 = 从存储根开始的绝对路径 |

解析函数 `resolveStorageKey(parquetKey, prefix, value)` 内部：

1. 把 `prefix + value` 当成一个完整路径串；
2. 若以 `/` 开头：从空 stack 开始（绝对）；否则把 `parquetKey` 的父目录拆成 stack
   起点（相对）；
3. 按 `/` 切片遍历：`""` 与 `"."` 跳过，`".."` 弹一层；
4. **`..` 弹到空 stack 时** 直接报错 `path escapes storage root`，**不**继续静默
   解析。比起让 proxy 返回 404，前端就告诉用户"这条规则越界了"更直观，也避免出现把
   bug 误以为是缺图的情况。

错误形态会被渲染成红色虚线占位卡（`AlertCircle` 图标），把违规路径以 monospace
展示出来，便于排错。这样**前端层就拒绝了路径穿越**，后端的 wildcard 校验只是兜底
而非主防线。

### 3.3 校验

`validateRules(input: unknown)` 同时承担两类校验：

* URL 解码后 — 损坏的链接 / 越权的字段都会落到 `decodeError`，在 Rows 页面顶部
  展示一条 `destructive` Alert，便于诊断而非静默回退到空规则。
* 用户在编辑器里 Save 时 — 错误以行号 / 字段名形式弹出（`rule #2: "kind" must be
  "text" or "image"`），编辑器不会关闭也不会写 URL。

## 4. URL 设计

### 4.1 路由总览

应用一共有四个路由（`src/App.tsx`）：

| 路由 | 组件 | 用途 |
| --- | --- | --- |
| `/` | `StorageRedirect` | 重定向到默认存储的根目录 |
| `/s/:storage/*` | `FileList` | 文件浏览器（splat = 目录前缀） |
| `/r/:storage/*` | `RowsPage` | **Rows 视图**（splat = parquet 文件 key） |
| `*` | — | fallback 到 `/` |

`/r/...` 与 `/s/...` 完全平行 —— 都是一级页面，存储名是路径段而不是查询参数。
这也是这个文档里反复提到 "**与 FileList 同级**" 的字面意思。

### 4.2 完整 URL 形态

```
/r/<storage>/<encoded-file-key>
  ?rows=<lz-string-compressed JSON rules>
```

具体例子：

```
/r/mybucket/datasets/train.parquet
   ?rows=N4IgzghgTgrgsgFwgFwgGYHsBOBLABBLAA…
```

或者无规则（直接打开会落在空态 CTA）：

```
/r/mybucket/datasets/train.parquet
```

路径段编码遵守 `proxyUrl()` 的做法：对每个 `/` 切片单独 `encodeURIComponent`，
保留 `/` 字面以便后端的 wildcard `:storage/*` 能正确切分。

### 4.3 `?rows=` Rules 压缩

```
?rows=<LZString.compressToEncodedURIComponent(JSON.stringify(rules))>
```

* **库**：`lz-string@1.5`（~3kB gzipped）。
  `compressToEncodedURIComponent` / `decompressFromEncodedURIComponent` 直接产生
  URL-safe 字符串，无需再做 `encodeURIComponent`。
* **写入策略**：仅在用户点击 Rules 对话框的 `Save` 时写入，`replace: true`，
  不污染浏览器历史栈。
* **空规则**：`setRules([])` 会把 `?rows=` 从 URL 中**删除**而非写入空数组的压缩
  字符串，URL 初态保持干净。

### 4.4 从 ParquetPreview 跳转到 Rows 页面

`ParquetPreview` 里 `Browse as cards` 按钮的核心逻辑：

```ts
const openRowsPage = () => {
  if (!storage) return
  const rules = searchParams.get(ROWS_PARAM)
  const trail = fileKey.split('/')
    .filter(s => s.length > 0)
    .map(encodeURIComponent)
    .join('/')
  const query = rules ? `?${ROWS_PARAM}=${rules}` : ''
  navigate(`/r/${encodeURIComponent(storage)}/${trail}${query}`)
}
```

* `fileKey` 已经是完整的存储 key（来自 `PreviewerProps`），不再依赖 `prefix` 拼接；
* `?rows=` 是 forward 而不是 replicate：用户如果之前没设过规则，目标 URL 也不会
  无意义地塞一个空参数；
* 由于切的是路由而不是 query，浏览器 history 会留一条 entry，Back 自然回到模态预览。

### 4.5 ParquetPreview 自己的 Tab URL

预览模态用 `?tab=` 在 Schema / Data 之间分享状态：

* `?tab=data` → Data Tab；
* 缺省 / `?tab=schema` → Schema Tab（默认值不写入 URL）；
* 任何不被识别的 `?tab=` 值（包括 `?tab=rows`，因为 Rows 不再是模态内的 Tab）静默
  降级到 Schema，不报错也不跳转。

### 4.6 为何不用 localStorage

* **链接即视图**：可被分享 / 收藏 / 嵌入文档 / 进 PR description；
* **多 Tab 隔离**：浏览器多个 Tab 各自独立，不会互相覆盖；
* **状态可见**：清空只需删 `?rows=` 即可，没有"残留在 storage 里"的隐藏状态。

## 5. 模块布局

```
frontend/
├── src/App.tsx                       # 路由表
├── src/components/
│   ├── RowsPage.tsx                  # 顶层页面：路由 + parquet 加载 + 错误处理
│   │                                 #   与 FileList.tsx 同级
│   └── preview/
│       ├── ParquetPreview.tsx        # Schema / Data Tab + Browse as cards 按钮
│       └── RowsView.tsx              # 卡片 feed + Rules 对话框
│                                     #   被 RowsPage 用作正文
└── src/hooks/
    └── use-rows-view-config.ts       # URL ⇄ Rule[] 双向绑定 + 校验
```

`RowsPage` 是路由承接组件，`RowsView` 是把已加载好的 `ParquetSource` 翻译成
卡片视图的纯渲染组件 —— 这条边界让前者管"获取数据 + 页面 chrome"，后者管"
渲染 + 用户交互"，两者职责清晰可分别测试。

### 5.1 `useRowsViewConfig`

```ts
function useRowsViewConfig(): {
  rules: Rule[]
  decodeError: string | null
  setRules: (next: Rule[]) => void
  clear: () => void
  hasUrlConfig: boolean
}
```

* 内部使用 `react-router-dom` 的 `useSearchParams`（项目已在 `FileList.tsx` 中使用）；
* `rules` 经 `useMemo` 缓存，参数没变就不会重复 `JSON.parse`；
* `setRules` 是写入入口，封装压缩 + URL 写入；
* 同时导出 `validateRules`，供对话框 Save 校验复用。

### 5.2 `RowsPage`

```ts
function RowsPage(): JSX.Element
```

* **路由解析**：`useParams()` 读取 `storage` 与 splat（`params['*']`），把后者
  去掉前导 `/` 后即是完整的 parquet `fileKey`。
* **加载**：用 `proxyUrl(fileKey, storage)` 拼出 `src`，调 `loadParquetSource`
  把 footer 拉下来；同时用 `loadTokenRef` 防止 `src` 变化时的竞态。
* **错误兜底**：
  * 存储名不在 `useStorages()` 返回的列表里 → `<Navigate to="/" replace />`；
  * `fileKey` 为空（用户访问 `/r/<storage>/`）→ 重定向到对应的文件列表；
  * Parquet 加载 401 → 渲染 `<TokenPrompt>`，与 `FileList` 同一交互；
  * 其它加载错误 → 红色 Alert，message 直接显示后端原因。
* **页面 chrome**：
  * 顶栏：`← Files` 按钮（`navigate('/s/<storage>/<parent dir>/')`）+ 文件名 +
    存储名/完整 key + `Rows view` 徽标；
  * 主区：`<RowsView>` 承担全部内容渲染，铺满剩余高度。

### 5.3 `RowsView`

组件树：

```
<RowsView>
 ├─ Toolbar (row counter + Rules button)
 ├─ {decodeError && <Alert variant="destructive">}
 ├─ {rules.length === 0 ? <EmptyState /> : <CardList />}
 │     <CardList>
 │       ├─ <RowCard> × N
 │       │   ├─ <TextWidget>
 │       │   ├─ <ImageWidget>
 │       │   └─ <MissingColumnHint>
 │       └─ <Button>Load N more</Button>
 └─ <RulesDialog>
      ├─ <textarea>            (draft JSON)
      ├─ {validationError && <Alert>}
      └─ <DialogFooter>        Clear / Cancel / Save
```

* 数据是 `useState<Record<string, unknown>[]>`，按需 append；
* `loadTokenRef` 模式：每次 `source` 变更都生成新 token，旧的异步结果无法覆盖新
  状态。这也是项目内"在 React 里取消异步请求"的既有约定（`ParquetPreview` 用法
  一致）。
* **重要**：`RowsView` 不自己调用 `loadParquetSource`，而是从 `RowsPage` 接收
  已经构造好的 `ParquetSource`（`{ file: AsyncBuffer, metadata }`），保证整个
  页面只有一次 footer 读取。每次 `Load more` 只通过 `readParquetRows` 走 Range
  请求拉取所需 row group 的页面。
* `RowsView` 是纯粹的"已加载 parquet → 卡片视图"的渲染层，可单独复用 —— 比如未来
  需要在另一个上下文里展示卡片视图（评论 / 嵌入 iframe / 报告等），不用搬整个
  `RowsPage`。

### 5.4 `ParquetPreview` 内的 Rows 入口

`ParquetPreview` 维持 Schema / Data 两个 Tab。TabsList 右侧的 `Browse as cards`
按钮（`LayoutList` 图标）调 `navigate('/r/<storage>/<file>?rows=...')`，并把当前
URL 上的 `?rows=` 一并 forward。`disabled={!storage}` 防止在罕见的 storage 缺失
时跳到不存在的路由。

`resolveActiveTab` 只识别 `'schema'` / `'data'`；任何其他 `?tab=` 值都静默降级
到 Schema。模态里完全不引用 `RowsView`，卡片视图只活在 `/r/...` 路由下。

## 6. 关键决策与取舍

| 决策 | 选项 | 取舍 |
| --- | --- | --- |
| 视图位置 | Tab vs 顶层路由 | 顶层路由。Rows 视图有自己的配置面板、自己的滚动空间、需要纵向铺满视口，模态吃不下。`/r/:storage/*` 让 URL 是文件路径而不是 query，浏览器 Back 把用户送回文件列表 + 模态，分享链接也更短更直观。footer 重复读取的成本（一次小 Range 请求）远低于"模态吃不下整页视图"的体验损失。 |
| 配置语言 | JSON vs YAML vs 表单生成器 | JSON。项目已不缺 JSON 处理；shadcn 没有 Select/Combobox，做表单要先扩 UI 库；YAML 需要额外依赖。 |
| 配置载体 | URL vs localStorage vs 混合 | URL only。可分享、可书签、清空容易；副作用是新开 Tab 总是空态，这正是"显式分享"语义。 |
| 编辑器位置 | 顶部内联面板 vs 模态对话框 | 模态对话框。卡片视图本身就要占满页面，编辑器内联会抢空间；模态与已有 `CellValueDialog` 同构。 |
| 图片来源 | 仅存储路径 vs +绝对 URL | 仅存储路径。覆盖文档中给出的全部示例；绝对 URL 可后续按"前缀以 `http://` 开头则视为字面 URL"扩展，不破坏现有规则文件。 |
| 加载策略 | 一次性 / 分页跳转 / 增量 Load more / 无限滚动 | Load more。简单、可预测，不需要 `IntersectionObserver`；行高差异大时无限滚动的滚动条会反复跳动。 |
| 列丢失 | 跳过 vs 占位提示 | 占位提示。规则跨文件复用时，"缺什么"的可见性比"看起来正常"重要。 |
| URL 写入时机 | 实时 debounce vs Save 显式 | Save 显式。模态本身就有"草稿"语义，关闭对话框等于放弃；同时减少 history entries。 |
| URL 压缩 | 原始 JSON vs lz-string vs gzip | lz-string。已经被广泛用于"把 JSON 塞进 URL"，输出原生 URL-safe，体积上比 base64(gzip) 更小。 |
| 路由风格 | `/r/<storage>/<file>` vs `/rows/<storage>/<file>` vs query param | 单字母 `/r/`。与已有 `/s/` 文件浏览器对仗（storage / rows），URL 短、可记；"rows" 全词 8 个字符放在路径里有点重，query param 又会让 Rows 看着像 FileList 的附属功能。 |
| 文件 key 位置 | 路径 splat vs query param | 路径 splat。`/r/mybucket/datasets/train.parquet` 看一眼就知道指向哪个文件；query param `?file=...` 会被各种工具截断或转义，分享体验差。 |
| ParquetPreview 入口形态 | 内嵌渲染 vs 跳转按钮 | 跳转按钮。Rows 视图"整页接管"的体感与模态的"原地变身"不匹配；按钮 + 路由 navigate 让转场更可预期，浏览器 history 也更干净。 |
| ParquetPreview 内的 Tab URL | URL 受控 vs 仅 mount 时读 URL | URL 受控。让浏览器 Back 走 Tab 历史、让分享链接精确落点。 |
| `?tab=` 默认值入参 | 总是写 vs 默认 Tab 不写 | 默认 Tab 不写。Schema 是"普通访问"的状态，URL 不应因此变长。 |
| 未识别 `?tab=` 值 | 报错 vs 重定向 vs 静默降级 | 静默降级到 Schema。让任何非预期值平稳回到默认 Tab，比把用户拦在错误页或强制 redirect 更稳妥。 |

## 7. 验证清单

* `tsc -b` + `eslint .` 全绿；
* **路由与跳转**（§4 重点）：
  * 文件列表中点 `train.parquet` → 模态打开，Tabs 为 `Schema | Data`，右侧出现
    `Browse as cards` 按钮；
  * 点 `Browse as cards` → URL 变为 `/r/<storage>/datasets/train.parquet`，模态
    消失，进入 Rows 页面；
  * 浏览器 Back → 回到 `/s/<storage>/datasets/?preview=train.parquet`，模态恢复；
  * 直接在地址栏输入 `/r/<storage>/datasets/train.parquet` → 同样进入 Rows 页面；
  * 在 Rows 页面顶部点 `← Files` → 回到 `/s/<storage>/datasets/`。
* **空态 / 规则编辑**：
  * Rows 页面第一次打开 → "No rules configured" 空态卡 + CTA；
  * 打开 Rules 对话框，粘贴非法 JSON → 出现校验 Alert，URL 未变；
  * 粘贴合法 rules（一个 text 列 + 一个 image 列），Save → 地址栏 query 变为
    `?rows=…`，卡片渲染正确；
  * 滚到底部点 `Load N more` → 后续 20 行 append，已渲染的卡片不重排；
  * 手动把 `?rows=` 从地址栏删除并刷新 → 回到空态。
* **规则 Forward**（§4.4）：
  * 在模态预览里手工拼一个带 `?rows=…` 的 URL（例如先去 Rows 页面 Save 规则、
    再 Back 回模态），点 `Browse as cards` → 目标 Rows 页面继承同一份 `?rows=…`；
  * 分享给他人的 Rows 页面 URL，对方打开看到的视图一致。
* **ParquetPreview Tab URL**：
  * 在 Schema Tab → 地址栏**没有** `?tab=`；
  * 切到 Data → URL 变成 `?tab=data`；切回 Schema → `?tab=` 被删除；
  * 复制带 `?tab=data` 的 URL 到新 Tab → 自动落在 Data Tab；
  * 手工把 URL 改成 `?tab=foo`（或任何非 schema/data 的值）→ 静默降级到 Schema。
* **跨文件**：从一个 parquet 的 Rows 页面，编辑地址栏文件路径到另一个 schema 不同
  的 parquet：
  * 规则保留；命中的列渲染正常，缺失的列显示 `column "foo" not in this file`。
* **路径解析**（§3.2）：
  * 打开 `dataset/train.parquet`，规则 `pathPrefix: "./"` + 值 `"img/001.png"` →
    实际加载 `dataset/img/001.png`；
  * 改 `pathPrefix: "../"` + 值 `"shared/cover.png"` → 实际加载 `shared/cover.png`
    （走到 parquet 的上级目录）；
  * 改 `pathPrefix: "../../../"` → image 占位变为红色 `path escapes storage root` 提示，
    `<img>` 根本不会发起请求；
  * 改 `pathPrefix: "/other/foo/"` + 值 `"a.png"` → 加载 `/other/foo/a.png`（绝对路径
    从存储根）。
* **错误兜底**：故意把 `pathPrefix` 指到不存在的目录 → image 占位变为 `failed to load
  <key>`，不出现破图图标；手工把 `?rows=` 改成乱码 → 顶部出现红色 "Couldn't read
  rules from URL" Alert，规则按空处理。

## 8. 后续可能的扩展

* **绝对 URL** 支持：`pathPrefix` 以 `http://` / `https://` 开头时跳过 `proxyUrl`，
  直接拼接作为图片地址（现状只支持存储根 `/...` 的绝对路径）。
* **更多 widget kind**：`json`（pretty-print）、`link`（可点击外链）、`markdown`、
  `video` —— 走和 `image` 一样的"列值 → URL"模型即可。
* **多预设**：URL 可加 `&rowsPreset=name`，把 `?rows=` 的内容写到本地 IndexedDB 当作
  命名预设；当前 URL-only 方案是这一扩展的真子集。
* **导出 / 导入**：在对话框里加一个 "Copy share link" 按钮，把当前 `?rows=` 的完整
  地址写入剪贴板。
