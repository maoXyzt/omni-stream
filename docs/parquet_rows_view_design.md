# Parquet Rows 视图设计文档

## 1. 概述

`ParquetPreview` 原先只有两个 Tab：

* **Schema** — 展示列类型；
* **Data** — 100 行 / 页的紧凑表格。

对 ML/数据集场景（一行里同时包含长 prompt、原图、编辑图）来说，表格视图把每一行都
压成一条 line-clamp 的窄行，看起来非常吃力。**Rows 视图**新增第三个 Tab，把
**每一行渲染成卡片**，并允许用户通过一份 **JSON 规则**自定义"哪列应当以什么形式
显示"。

规则不存 localStorage，而是 **lz-string 压缩后写入 URL 查询参数 `?rows=…`**：
一份链接即可分享同一份视图，无需手动同步配置。

## 2. 用户视角

```
┌─ Schema ─ Data ─ Rows ─┐         [ ▣ Browse as cards ]
└────────────────────────┘            ↑ 仅在非 Rows Tab 时显示

[Rules ▢]   3 of 1,234 rows loaded

┌─ row 1 ───────────────────────────────────────────────┐
│ prompt                                                │
│   ┌───────────────────────────────────────────────┐   │
│   │ A cat sitting on a windowsill at sunset…      │   │
│   └───────────────────────────────────────────────┘   │
│ image                                                 │
│   ┌─────────────┐                                     │
│   │   <img>     │                                     │
│   └─────────────┘                                     │
│ image_edit                                            │
│   ┌─────────────┐                                     │
│   │   <img>     │                                     │
│   └─────────────┘                                     │
└───────────────────────────────────────────────────────┘
                ┌─ row 2 ─ … ─┐
                [  Load 20 more  ]
```

### 2.1 进入 Rows 视图的两条路径

1. **点击 `Rows` Tab** —— 与 Schema / Data 并列，是规范的入口。
2. **点击 `Browse as cards` 按钮** —— 位于 TabsList 右侧，仅当当前不在 Rows Tab
   时显示。Rows 视图是当前唯一带"配置一次、分享链接"工作流的 Tab，需要比一个标签
   稍微更显眼的入口来宣告它的存在。

两条路径都通过同一个 `setActiveTab('rows')`，并最终落到下面要讲的 URL 写入。

### 2.2 其它

* 卡片之间垂直堆叠，外层容器原生滚动。
* 底部 `Load N more` 按钮按 **20 行 / 批** 增量加载；到达文件末尾后显示 `End of file`。
* 右上角 `Rules` 按钮打开 **JSON 编辑器对话框**，保存即写入 URL。
* URL 中带 `?tab=rows`（或老链接里只有 `?rows=…`）时，打开 ParquetPreview 会自动
  落在 Rows Tab。
* 无规则时，Rows Tab 显示 "No rules configured" 空态卡 + CTA。

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
  { "column": "image", "kind": "image", "pathPrefix": "datasets/train/" },
  { "column": "image_edit", "kind": "image", "pathPrefix": "datasets/edits/" }
]
```

### 3.1 渲染规则

* `text`：使用 `formatCell(value)` 转字符串后放进多行 `<pre>`（保留换行、限高滚动）。
  `formatCell` 复用自 `src/lib/parquet.ts`，已经处理 bigint / `Uint8Array` / `Date` /
  STRUCT / LIST 的展示。
* `image`：将 `pathPrefix + value` 作为存储 key，通过
  `proxyUrl(key, storage)`（`src/api/storage.ts`）拼出 `/api/proxy/{key}?storage=…` 作为
  `<img src>`。`<img onError>` 触发后切换为"failed to load"提示，**不**回退到浏览器
  默认的破图图标。
* `image` 列单元格容忍三种形态：纯字符串、`{path}`、`{uri}`、`{url}`、`{src}` 结构体；
  其它形态返回 `null` 并显示 "no image path" 提示。
* 规则引用的列在当前文件中**不存在**时，渲染一条虚线占位的
  `column "foo" not in this file` 提示，而不是留空。这样跨文件复用同一份 URL 不会让
  视图静默"消失"。

### 3.2 校验

`validateRules(input: unknown)` 同时承担两类校验：

* URL 解码后 — 损坏的链接 / 越权的字段都会落到 `decodeError`，在 Rows Tab 顶部展示
  一条 `destructive` Alert，便于诊断而非静默回退到空规则。
* 用户在编辑器里 Save 时 — 错误以行号 / 字段名形式弹出（`rule #2: "kind" must be
  "text" or "image"`），编辑器不会关闭也不会写 URL。

## 4. URL 设计

### 4.1 整体契约

ParquetPreview 在地址栏使用 **4 个正交的查询参数**，加上 FileList 已有的两个：

| 参数 | 谁拥有 | 取值 | 含义 |
| --- | --- | --- | --- |
| `preview` | `FileList` | 相对 key | 当前被预览的文件路径（已存在） |
| `storage` | `FileList` | 存储名 | 当前的存储后端（已存在） |
| `tab` | `ParquetPreview` | `schema` \| `data` \| `rows` | 当前 Tab；默认 Tab `schema` 不写入 |
| `rows` | `RowsView` | lz-string 压缩字符串 | 规则配置；空数组会从 URL 中删除而不是写入 |

完整的一个 "分享链接" 形态：

```
/?preview=datasets/train.parquet
 &storage=mybucket
 &tab=rows
 &rows=N4IgzghgTgrgsgFwgFwgGYHsBOBLABBLAA…
```

四个参数互相独立：删掉 `?rows=` 仍是 Rows Tab + 空规则；删掉 `?tab=rows` 仍可以
通过老链接的 `?rows=` 兜底回到 Rows。

### 4.2 Tab 解析优先级

`resolveActiveTab(searchParams: URLSearchParams): ParquetTab` 按如下顺序短路：

1. **`?tab=schema|data|rows`** —— 显式指定，胜出。"分享链接精确落点"靠这一条。
2. **`?rows=…` 存在** —— 老链接兜底，隐式解读为 `'rows'`。Tab 参数加进项目之前
   生成的链接（包括我自己测试时的链接）只有这个信号。
3. **`lastActiveTab`** —— 模块级会话缓存。切到另一个 parquet 文件时，URL 一般已
   被 FileList 清空到只剩 `?preview=`，这条让用户回到上一次看过的 Tab。
4. **`'schema'`** —— 最终默认。

### 4.3 Tab 写入策略

`setActiveTab(next)` 总是 `replace: true`：Tab 切换属于"视图状态"而不是"导航
事件"，Back 按钮的语义应当保持为"回到上一个文件 / 页面"而非"反向逐步走完所有 Tab"。

| `next` | URL 表现 |
| --- | --- |
| `schema`，且 URL **无** `?rows=` | 删除 `?tab=`（默认 Tab 不入参） |
| `schema`，但 URL **有** `?rows=` | 显式写入 `?tab=schema`，否则下一帧
  `resolveActiveTab` 会因为 `?rows=` 兜底立刻反弹到 Rows |
| `data` | `?tab=data` |
| `rows` | `?tab=rows` |

### 4.4 Rules 压缩

```
?rows=<LZString.compressToEncodedURIComponent(JSON.stringify(rules))>
```

* **库**：`lz-string@1.5`（~3kB gzipped）。
  `compressToEncodedURIComponent` / `decompressFromEncodedURIComponent` 直接产生
  URL-safe 字符串，无需再做 `encodeURIComponent`。
* **写入策略**：仅在用户点击 `Save` 时写入，同样 `replace: true`。
* **空规则**：`setRules([])` 会把 `?rows=` 从 URL 中**删除**而非写入空数组的压缩
  字符串，URL 初态保持干净。

### 4.5 跨文件行为

`?tab=` 与 `?rows=` 都与具体的 `preview` key 解耦：切到另一个 parquet 时，规则
和 Tab 选择**保留**。

* 列对不上由 3.1 的 "column not in this file" 占位提示兜底；
* 不同 schema 的 parquet 在同一份规则下还能复用（这是 URL-only 持久化的副产物——
  跨文件复用反而比"每个文件记一份"更常见）；
* 真的不想复用 Rows 视图，切到 Schema Tab 即可。

### 4.6 为何不用 localStorage

* **链接即视图**：可被分享 / 收藏 / 嵌入文档 / 进 PR description；
* **多 Tab 隔离**：浏览器多个 Tab 各自独立，不会互相覆盖；
* **状态可见**：清空只需删 `?rows=` / `?tab=`，没有"残留在 storage 里"的隐藏状态。

## 5. 模块布局

```
frontend/
├── src/components/preview/
│   ├── ParquetPreview.tsx        # +Rows Tab (TabsTrigger / TabsContent)
│   └── RowsView.tsx              # 新增：整个 Rows Tab + 规则编辑对话框
└── src/hooks/
    └── use-rows-view-config.ts   # 新增：URL ⇄ Rule[] 双向绑定 + 校验
```

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

### 5.2 `RowsView`

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
* 使用与 `ParquetPreview` 相同的 **`loadTokenRef` 模式**：每次 `source` 变更都生成
  新 token，旧的异步结果无法覆盖新状态。这也是项目内"在 React 里取消异步请求"的
  既有约定。
* **重要**：`RowsView` **不**自己调用 `loadParquetSource`，而是从父组件 `ParquetPreview`
  接收已经构造好的 `ParquetSource`（`{ file: AsyncBuffer, metadata }`），保证整个
  preview 只有一次 footer 读取。每次 `Load more` 只通过 `readParquetRows` 走
  Range 请求拉取所需 row group 的页面。

### 5.3 `ParquetPreview` 的改动

1. **类型扩展**：`type ParquetTab = 'schema' | 'data' | 'rows'`。
2. **URL ⇄ Tab 同步**：把 `<Tabs>` 从 `defaultValue`（非受控）改成
   `value` / `onValueChange`（受控）：
   * 读：每次渲染都用 `resolveActiveTab(searchParams)`（§4.2）算 active Tab；
   * 写：`onValueChange` 调用 `setActiveTab(next)`（§4.3），`{ replace: true }`。
   * `lastActiveTab` 仍是模块级 `let`，但角色降级为"无 URL 提示时的会话兜底"，
     不再作为唯一来源。
3. **入口 UI**：
   * `<TabsTrigger value="rows">Rows</TabsTrigger>` 与 `<TabsContent value="rows">`；
   * 在 `TabsList` 右侧放一个 `Browse as cards` 按钮（`LayoutList` 图标），
     仅当 `activeTab !== 'rows'` 时显示。两者共用同一个 `setActiveTab('rows')`，
     用户在 Schema/Data Tab 上扫一眼就能发现 Rows 视图的存在。
4. **传参**：把父组件已经载入的 `source`、`columns`、`numRows`、`storage` 直接
   传给 `<RowsView>`，避免重复读取 footer。

## 6. 关键决策与取舍

| 决策 | 选项 | 取舍 |
| --- | --- | --- |
| 视图位置 | 第三个 Tab vs 独立 Previewer | 第三 Tab。复用父组件已经载入的 `ParquetSource`，footer 不重复下载；视图语义"还是同一个 parquet 文件"。 |
| 配置语言 | JSON vs YAML vs 表单生成器 | JSON。项目已不缺 JSON 处理；shadcn 没有 Select/Combobox，做表单要先扩 UI 库；YAML 需要额外依赖。 |
| 配置认定 | URL vs localStorage vs 混合 | URL only。可分享、可书签、清空容易；副作用是新开 Tab 总是空态，这正是"显式分享"语义。 |
| 编辑器位置 | 顶部内联面板 vs 模态对话框 | 模态对话框。卡片视图本身就要占满 Tab，编辑器内联会抢空间；模态与已有 `CellValueDialog` 同构。 |
| 图片来源 | 仅存储路径 vs +绝对 URL | 仅存储路径。覆盖文档中给出的全部示例；绝对 URL 可后续按"前缀以 `http://` 开头则视为字面 URL"扩展，不破坏现有规则文件。 |
| 加载策略 | 一次性 / 分页跳转 / 增量 Load more / 无限滚动 | Load more。简单、可预测，不需要 `IntersectionObserver`；行高差异大时无限滚动的滚动条会反复跳动。 |
| 列丢失 | 跳过 vs 占位提示 | 占位提示。规则跨文件复用时，"缺什么"的可见性比"看起来正常"重要。 |
| URL 写入时机 | 实时 debounce vs Save 显式 | Save 显式。模态本身就有"草稿"语义，关闭对话框等于放弃；同时减少 history entries。 |
| URL 压缩 | 原始 JSON vs lz-string vs gzip | lz-string。已经被广泛用于"把 JSON 塞进 URL"，输出原生 URL-safe，体积上比 base64(gzip) 更小。 |
| Tab 同步 | URL 受控 vs 仅 mount 时读 URL | URL 受控。让浏览器 Back 走 Tab 历史、让分享链接精确落点、让 URL 始终反映用户所见，全部依赖这一点。 |
| Tab 参数命名 | `tab` vs `ptab`/`pqTab` 等命名空间 | `tab`。`?tab=` 仅在 `?preview=` 存在时有意义，作用域已被隐式限定，加前缀只是噪音。 |
| Tab 默认值入参 | 总是写 vs 默认 Tab 不写 | 默认 Tab 不写。Schema 是"普通访问"的状态，URL 不应因此变长；只有 `data`/`rows` 是值得分享的"非默认状态"。 |
| 入口可发现性 | 仅靠 Tab vs +显式按钮 | +按钮。"Browse as cards" 显式按钮（仅非 Rows Tab 显示）专门用来宣告这是一个有独立配置 + 分享语义的视图，单纯一个 Tab 容易被错过。 |
| 旧链接兼容 | 直接报废 vs 隐式当 `?tab=rows` | 隐式兼容。`?rows=` 出现时自动 fallback 到 Rows Tab，不打破任何已分享的链接；代价是 §4.3 中需要为 schema 写显式 `?tab=schema`。 |

## 7. 验证清单

* `tsc -b` + `eslint .` 全绿；
* **基础规则编辑**：打开任意 parquet：
  * 切到 Rows Tab → 看到 "No rules configured" 空态；
  * 打开 Rules 对话框，粘贴非法 JSON → 出现校验 Alert，URL 未变；
  * 粘贴合法 rules（一个 text 列 + 一个 image 列），Save → 地址栏出现 `?rows=…`，
    卡片渲染正确；
  * 滚到底部点 `Load N more` → 后续 20 行 append，已渲染的卡片不重排；
  * 手动把 `?rows=` 从地址栏删除并刷新 → 回到空态。
* **URL 与 Tab 同步**（§4 重点）：
  * 在 Schema Tab → 地址栏**没有** `?tab=`；
  * 点击 `Browse as cards` 或 Rows Tab → URL 变成 `?tab=rows`，按钮消失；
  * 切到 Data Tab → URL 变成 `?tab=data`；
  * 切回 Schema → `?tab=` 被删除（前提是 `?rows=` 也没设）；
  * 设置过 rules 后切到 Schema → URL 同时保留 `?rows=…&tab=schema`，刷新仍停在
    Schema（不会因为 `?rows=` 兜底反弹到 Rows）；
  * 复制带 `?tab=rows` 的 URL 到新 Tab → 自动落在 Rows Tab；
  * 复制只带 `?rows=…`（无 `?tab=`）的老格式 URL → 同样落在 Rows Tab（兼容）；
  * 浏览器 Back → 走文件 / 页面历史，**不**反向逐 Tab 倒退（受 `replace: true` 保护）。
* **跨文件**：切到另一个 schema 不同的 parquet：
  * 规则保留；命中的列渲染正常，缺失的列显示 `column "foo" not in this file`；
  * Tab 选择保留。
* **错误兜底**：故意把 `pathPrefix` 指到不存在的目录 → image 占位变为 `failed to load
  <key>`，不出现破图图标；手工把 `?rows=` 改成乱码 → 顶部出现红色 "Couldn't read
  rules from URL" Alert，规则按空处理。

## 8. 后续可能的扩展

* **绝对 URL** 支持：`pathPrefix` 以 `http://` / `https://` / `/` 开头时跳过 `proxyUrl`，
  直接拼接作为图片地址。
* **更多 widget kind**：`json`（pretty-print）、`link`（可点击外链）、`markdown`、
  `video` —— 走和 `image` 一样的"列值 → URL"模型即可。
* **多预设**：URL 可加 `&rowsPreset=name`，把 `?rows=` 的内容写到本地 IndexedDB 当作
  命名预设；当前 URL-only 方案是这一扩展的真子集。
* **导出 / 导入**：在对话框里加一个 "Copy share link" 按钮，把当前 `?rows=` 的完整
  地址写入剪贴板。
