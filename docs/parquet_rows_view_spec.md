# Rows View Schema 设计 Spec

## 0. 目标与非目标

**目标**

* 用**三个正交维度**描述一行卡片：
  - **Selector**：从行里抽取值的路径表达式（含字段访问、下标、切片、遍历）；
  - **Widget**：把单个值渲染成什么 UI；
  - **Container**：多 widget 之间的布局，默认 `flow`（flex-wrap 横向流），显式容器 `row` / `column` / `grid` 各起一行。
* 三个用户场景一并解掉：
  - list 字段每元素展示 —— selector 用 `.[*]`；
  - 行内多列布局 —— 默认就是 flow，多个 widget 自动横向排，超宽换行；想要"严格不换行"用 `row` 容器；
  - 视频 / 音频 / 链接 / 高亮代码 —— widget 集合扩到 7 个。
* URL 分享 wire format：LZString 压 canonical JSON 写入 `?rows=` 参数。

**非目标**

* 多个遍历步的笛卡尔积（parse-time 拒绝，未来评估）。
* Selector 中的 filter / predicate（`.[?expr]` 留作未来语法位）。
* 跨行聚合、排序、筛选。
* 可视化编辑器（schema 钉稳后单独排期）。

---

## 1. Selector — 取值表达式

Selector 是一个字符串 DSL，描述如何从一行里抽取一个或多个值。canonical form 里仍以**字符串**存储（不预解析成 AST），URL 短，错误信息能指回原始字符。

### 1.1 EBNF

```
selector    := root step*
root        := IDENT | STRING             // 列名含特殊字符时用 STRING
step        := '.' IDENT                  // field shortcut
             | '.' '[' bracketExpr ']'    // explicit bracket form
bracketExpr := '*'                        // 遍历 (fan-out)
             | INTEGER                    // index (可为负数)
             | slice
             | IDENT                      // field (与 .IDENT 等价)
             | STRING                     // 含特殊字符的 key
slice       := INTEGER? ':' INTEGER?      // 至少一边有值，'.[:]' 是错的
IDENT       := [A-Za-z_][A-Za-z0-9_]*
INTEGER     := '-'? [0-9]+
STRING      := '"' ... '"'                // JSON 风格转义 (\" \\ \n \r \t \uXXXX \/)
             | '`' ... '`'                // 反引号原文 (无转义)，JSON-嵌入友好
```

**两种 STRING 形式区别**：
* 双引号 `"..."` 支持 JSON 风格转义；放在 JSON 字符串里要二次转义，写起来累。
* 反引号 `` `...` `` 内部不解释任何转义，所见即所得；放在 JSON 字符串里**无需转义**，更适合手写或贴给 AI。
* 列名极少出现反引号，真碰到了就用双引号回退。

**转义示例**：

| selector 源字串 | 解析后的 column / key |
|----------------|----------------------|
| `"a\"b"` | `a"b` |
| `"a\\b"` | `a\b` |
| `"line1\nline2"` | `line1` + 换行 + `line2` |
| `"中"` | `中` |
| `` `a\nb` `` | `a\nb`（反引号下 `\n` 是字面量两个字符） |
| `` `with"quotes` `` | `with"quotes`（反引号内双引号无需转义） |

### 1.2 操作语义

| 形态 | 名字 | 输入 | 输出 |
|------|------|------|------|
| `IDENT` 或 `STRING` | root | 一行上下文 | 该行同名列 / 字段的值 |
| `.IDENT` 或 `.[IDENT]` 或 `.[STRING]` | field | object | object[key]，缺失为 `undefined` |
| `.[INTEGER]` | index | list / string | 元素；负数 = `len + n`；越界为 `undefined` |
| `.[a:b]` | slice | list / string | 子列表 / 子字符串；负数同 Python |
| `.[*]` | 遍历 (fan-out) | **list 专用** | 把链分裂成 N 条，下游 step 对每个元素重复执行；widget 也对每个元素渲染一次 |

**重要细则**

* `slice` 的两端**不能同时缺省**。`.[:]` 在解析期就报错；想"全部"请用 `.[*]`（遍历）。
* 一条 selector 链中**最多一个 `.[*]`**。多个遍历步是笛卡尔积，parse-time 拒绝。
* **`.[*]` 仅适用于 list**。对 string / object / 标量使用 → 渲染期视为空列表，按 `empty` 占位渲染（不允许字符串拆字符这种隐式行为，避免列类型变化导致渲染剧变）。
* 其他数据类型不匹配（对非 object 取 field、对非 list 取 index/slice 等）→ 渲染期返回 `undefined`，widget 显示对应 placeholder，**不抛出**。
* 选择器中的 `IDENT` 不区分列名 / 字段名 —— 第一个 token 是列名，后续 `.x` 是 field；语义靠位置而非命名约定。

### 1.3 例子

| selector | 含义 |
|----------|------|
| `prompt` | 列 `prompt` 的值 |
| `image.[path]` | object 列 `image` 的 `path` 字段 |
| `image.path` | 同上（field shortcut） |
| `images.[0]` | list 列 `images` 的第一个元素 |
| `images.[-1]` | 最后一个 |
| `images.[*]` | 遍历：每个元素一份渲染 |
| `images.[0:3].[*]` | 前 3 个，每个一份渲染 |
| `images.[*].[path]` | 每个元素的 `path` 字段，分别渲染 |
| `prompt.[0:200]` | prompt 的前 200 个字符 |
| `metadata.tags.[*]` | object 列 `metadata` 的 `tags` 字段（应为 list），每元素一份 |
| `` `weird.col` `` 或 `"weird.col"` | 列名含 `.` / 空格等特殊字符时用反引号或双引号包起来 |
| `` `col with space`.[*] `` | 同上 + 后续 step 正常拼 |

### 1.4 错误消息

Parser 抛出的错误**带 selector 字符串中的字符 offset**，编辑器可以高亮：

```
images.[:]: slice must have at least one bound (col 8)
images.[*].tags.[*]: at most one [*] per selector (col 17)
images.[abc:5]: slice bounds must be integers (col 8)
```

---

## 2. Widget — 渲染器

封闭集合，7 个。

| widget | 描述 | 选项 |
|--------|------|------|
| `default` | `formatCell` 风格的纯文本；primitive 原样，object/list 走多行布局；与表格 Data tab 一致 | `maxHeight` |
| `highlight` | `highlight.js` 语法高亮 | `lang` (必填), `maxHeight` |
| `image` | `<img>`；value 是 path 字符串，或 `{path|uri|url|src}` 的 object | `src` |
| `video` | `<video controls>`，支持 Range | `src` |
| `audio` | `<audio controls>` | `src` |
| `link` | `<a href>`，URL 与显示文本一致 | `src` |
| `markdown` | 最小 markdown 子集（粗/斜/标题/列表/inline code/链接），渲染前 DOMPurify 净化 | `maxHeight` |

* `default` 覆盖纯文本 / 原始字符串 / 美化 JSON 三种用例：对 object/array value 自动走 `formatCellExpanded`。
* `highlight` 的 `lang` 必填，typical values：`json`, `python`, `typescript`, `sql`, `bash`, `yaml`, `markdown`, `html`。未注册的 `lang` 退化为纯文本。
* `markdown` 实现约束：使用 `marked` (或等价) 解析 → `DOMPurify` 净化 → 注入 DOM。**GFM 表格 / fenced code 语法高亮均不启用**（要语法高亮请直接用 `highlight` widget；要表格暂时用 `default` 看 raw JSON）；不允许 raw HTML、`<script>` / `<iframe>` / 事件属性等任何脚本注入面。
* **`src` URL 模板**（image/video/audio/link 共用）：字符串里的 `{value}` 在渲染期替换成 cell 值，其余字符原样；其他 `{...}` 序列不识别，留作字面量。缺省 `src` 是 `"{value}"`（cell 值直接当路径）。渲染好的字符串再走 `resolveStorageKey`，锚到**源数据文件所在目录**（无论 parquet / jsonl / 其他行式格式），`..` 弹栈不可越过 storage root。
  典型用法：`{value}` 直用 / `./images/{value}` 移到 sibling 目录 / `https://cdn/{value}.png` 拼远程 URL。

---

## 3. 节点模型（canonical form）

```ts
type Node = AtomNode | ContainerNode

interface BaseNode {
  /// 显示在节点上方的标签
  label?: string
  /// 作为 row/grid 子节点时的轨道尺寸：'1fr' | '320px' | 'auto'
  width?: string
}

type Widget =
  | 'default'
  | 'highlight'
  | 'image'
  | 'video'
  | 'audio'
  | 'link'
  | 'markdown'

interface AtomNode extends BaseNode {
  /// Selector 字符串，见 §1
  from: string
  /// 缺省 'default'
  show?: Widget
  /// widget 选项
  lang?: string        // highlight (必填)
  src?: string         // image / video / audio / link — URL/path 模板，{value} 占位，缺省 "{value}"
  maxHeight?: string   // default / highlight / markdown
  /// selector 含 `.[*]` 时，多元素之间怎么排
  layout?: 'column' | 'row' | 'grid'
  /// layout='grid' 时的列数
  columns?: number
  gap?: string
  /// 遍历的列表为空 / 缺失时的占位文案，缺省 '(empty)'
  empty?: string
}

interface ContainerNode extends BaseNode {
  kind: 'flow' | 'row' | 'column' | 'grid'
  children: Node[]
  columns?: number     // grid only
  gap?: string
}
```

**四种 container 行为对照**：

| kind | CSS 模型 | 占空间 | 用途 |
|------|----------|--------|------|
| `flow` (默认) | `flex; flex-wrap: wrap` | 跟随父布局 | 横向排列，挤不下自动换行 |
| `row` | `flex; flex-wrap: nowrap; width: 100%` | **占满整行** | 必须放在同一行（不换行）的强约束 |
| `column` | `flex; flex-direction: column; width: 100%` | **占满整行** | 强制纵向堆叠的一段 |
| `grid` | `display: grid; grid-template-columns: repeat(N, 1fr); width: 100%` | **占满整行** | N 等分网格 |

任何**显式**容器（`row` / `column` / `grid`）都自带 `width: 100%`，**等价于"在父 flow 中起新的一行"**。不显式包容器就跟前后兄弟一起 flow 横排。

### 3.1 节点形态自描述

**顶层 JSON 数组本身就是一个 flow 容器**（横向排，超宽自动换行），不需要额外包成 `{ "kind": "flow", "children": [...] }`。下面的形态判定只对容器内部的子节点 / 顶层数组的元素生效。

不需要 `kind` 字段区分 atom：

* 有 `children` → container（`kind` 选 flow/row/column/grid，缺省 flow）；
* 有 `from` 或是裸字符串 → atom；
* 两者都没有 → 错误。

### 3.2 校验规则

#### 3.2.1 三条 cross-field 规则（**最容易漏，AI 体外校验也应重点检查**）

1. **`lang` 仅且必须**在 `show: "highlight"` 时出现。换言之：
   * 用了 highlight → 必须给 `lang`；
   * 没用 highlight → 不许给 `lang`。
2. **`src` 仅** `show ∈ {image, video, audio, link}` 时允许。其他 widget（含 default / highlight / markdown）写 `src` 直接报错。
3. **`layout` / `columns` / `gap` / `empty` 要求 selector 里含 `.[*]`**。没有遍历步意味着 atom 只产出一个值，谈不上"多元素排布"，写这些字段会被 parse-time 拒。

#### 3.2.2 其他字段级校验

| 规则 | 错误 |
|------|------|
| atom 的 `from` 必须是非空字符串且通过 §1 parser | `"from": <parser error>` |
| atom 的 `show` 必须在 widget 集合内 | `"show" must be one of [default, highlight, ...]` |
| `maxHeight` 仅 `show ∈ {default, highlight, markdown}` 允许 | `"maxHeight" not allowed on show="<x>"` |
| `columns` 仅当 `layout='grid'`（atom）或 `kind='grid'`（container）时允许 | `"columns" only allowed on grid layout` |
| `columns` 必须是正整数 | `"columns" must be a positive integer` |
| container 的 `children` 必须是数组 | `"children" must be an array` |
| container 的 `kind` 必须是 `flow` / `row` / `column` / `grid` | `"kind" must be one of flow \| row \| column \| grid` |
| 出现未知字段 | `unknown field "<x>" on <kind>` |

---

## 4. Sugar（仅输入解析）

校验器同时接受 sugar 与 canonical。保存到 URL **统一 desugar 到 canonical**。

### 4.1 裸字符串 → default-widget atom

```
"prompt"  ≡  { "from": "prompt" }
```

### 4.2 单键对象 = widget / container shortcut

对象**只含一个**「键名等于某个 widget 或 container」时展开：widget 名对应 atom，container 名对应 container。

| 写法 | canonical |
|------|-----------|
| `{ "image": "thumb" }` | `{ "from": "thumb", "show": "image" }` |
| `{ "highlight": "code", "lang": "py" }` | `{ "from": "code", "show": "highlight", "lang": "py" }` |
| `{ "video": "clip", "src": "../clips/{value}" }` | `{ "from": "clip", "show": "video", "src": "../clips/{value}" }` |
| `{ "row": [a, b] }` | `{ "kind": "row", "children": [a, b] }` |
| `{ "flow": [a, b] }` | `{ "kind": "flow", "children": [a, b] }` |
| `{ "column": [a, b] }` | `{ "kind": "column", "children": [a, b] }` |
| `{ "grid": [a, b], "columns": 2 }` | `{ "kind": "grid", "columns": 2, "children": [a, b] }` |

剩余键原样并入。**消歧规则**：若对象同时含 `show` 或 `kind` 字段，按 canonical 处理；tag-key sugar 不触发。

**冲突核对**（tag 名 vs 字段名）：widget 集 = `{default, highlight, image, video, audio, link, markdown}`；container 集 = `{flow, row, column, grid}`；字段集 = `{from, show, lang, src, maxHeight, layout, columns, gap, empty, label, width, children, kind}`。三个集合**完全不相交**，单键 sugar 无歧义。

### 4.3 顶层 / 嵌套数组 → flow 容器

* 顶层数组的元素**逐个 desugar**，作为 canonical `Node[]` 序列化；UI 渲染时这些节点处在隐式的 flow 容器里（横向排列、超宽换行）。
* 嵌套位置出现的数组（如 `{row: ["a", "b"]}` 里的 `children`、container 的 children）**隐式视为 flow 容器**。

### 4.4 已评估、故意排除的 sugar

* ❌ **自动遍历**（atom 的 `from` 指向 list 列就自动加 `.[*]`）：列类型变了会静默改变渲染。强制显式 `.[*]`。
* ❌ **path-keyed 形态** `{ "row.0": ... }`：插入 / 重排成本高。
* ❌ **多个 widget tag 共存**（如 `{ image: "...", highlight: "..." }`）：parse-time 拒绝。

---

## 5. 解析流程

```
input (unknown)
  │
  └─ parseNode (递归)
       │
       ├─ string → atom with default widget
       │
       ├─ array → column container
       │
       ├─ object with `children` → container
       │
       ├─ object with single widget-tag key → atom with that widget
       │
       └─ object with `from` (+ optional `show`) → atom
            │
            └─ parseSelector(from) → 校验 selector 语法
                 │
                 └─ 收集 selector 中 `.[*]` 是否出现 → 用于 layout 字段允许性校验
```

错误带 path：`nodes[1].children[0]: invalid selector "images.[:]" — slice must have at least one bound (col 8)`.

---

## 6. URL 存储

```
?rows = LZString.compressToEncodedURIComponent(JSON.stringify(canonicalNodes))
```

* `from` 字段存的是 selector **源字符串**（不是 AST），URL 短、可读、可粘贴。
* canonical Node 序列化时**仅写非默认字段**（`show: 'default'` 不写，省字符）。

---

## 7. 完整示例

**Sugar 形态**（用户在编辑器里写的）：

```jsonc
[
  // flow 默认：prompt + 缩略图自动横向排，挤不下换行
  { "from": "prompt", "width": "1fr" },
  { "image": "thumbnails.[0]", "width": "120px" },

  // 显式 row：强制 N 张图同一行，超宽 overflow（不换行）
  { "row": [
    { "image": "images.[0]" },
    { "image": "images.[1]" },
    { "image": "images.[2]" }
  ]},

  // 显式 grid：每张图遍历一份，固定列数
  { "image": "images.[*].[path]", "layout": "grid", "columns": 3 },

  // 显式 column：把 video + 它的标签纵向粘在一起
  { "column": [
    { "video": "clip_path", "src": "../clips/{value}" },
    { "highlight": "metadata", "lang": "json" }
  ]},

  // 长文本截断单独一行
  "description.[0:200]"
]
```

**Canonical 形态**（URL 里的）：

```json
[
  { "from": "prompt", "width": "1fr" },
  { "from": "thumbnails.[0]", "show": "image", "width": "120px" },
  {
    "kind": "row",
    "children": [
      { "from": "images.[0]", "show": "image" },
      { "from": "images.[1]", "show": "image" },
      { "from": "images.[2]", "show": "image" }
    ]
  },
  {
    "from": "images.[*].[path]",
    "show": "image",
    "layout": "grid",
    "columns": 3
  },
  {
    "kind": "column",
    "children": [
      { "from": "clip_path", "show": "video", "src": "../clips/{value}" },
      { "from": "metadata", "show": "highlight", "lang": "json" }
    ]
  },
  { "from": "description.[0:200]" }
]
```

---

## 8. 实现拆分

1. **selector 模块**：tokenizer + recursive-descent parser + AST + offset-aware errors + 单测。约 100 行 + 测试。
2. **schema 层**：types + `parseRules` + sugar desugar + widget tag-key 单键展开 + 形状校验。约 150 行 + 测试。
3. **渲染层**：`RowsView.tsx` 替换为递归 `renderNode(node, row, context)`；新增 `WidgetDefault` / `WidgetHighlight` / `WidgetImage` / `WidgetVideo` / `WidgetAudio` / `WidgetLink` / `WidgetMarkdown`；container 三种；selector 求值器（输入 row + AST → value or value[]，遇遍历步返回 array）。
4. **编辑器**：现有 textarea + JSON 校验 + selector 错误指到字符 offset。后续 YAML / 结构化编辑器单独排。
