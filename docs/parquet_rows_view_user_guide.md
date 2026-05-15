# Rows View 配置写作指南

> 一句话：Rows View 把数据文件（当前支持 parquet，未来可扩展到 jsonl 等行式格式）的每一行渲染成一张卡片。这份 JSON 配置告诉它**哪些列要展示**、**用什么方式展示**、**怎么排布**。本文是给"想写配置的人"或"丢给 AI 让它代写的人"看的速查手册。

---

## 1. 速查菜谱（8 个例子）

每条都是一个**完整可用**的配置。

### 1.1 只展示一列文字

```json
["prompt"]
```

### 1.2 一张图片

```json
[{ "image": "thumbnail" }]
```

### 1.3 左文右图（默认 flow 就够了）

```json
[
  { "from": "prompt", "width": "1fr" },
  { "image": "thumbnail", "width": "320px" }
]
```

如果想**强制不换行**（卡片再窄也保持一行，超出就 overflow），用显式 `row`：

```json
[{ "row": [
  { "from": "prompt", "width": "1fr" },
  { "image": "thumbnail", "width": "320px" }
] }]
```

### 1.4 列表里每张图都展示（3 列网格）

```json
[{ "image": "images.[*]", "layout": "grid", "columns": 3 }]
```

### 1.5 只展示前 3 张图

```json
[{ "image": "images.[0:3].[*]" }]
```

### 1.6 列里嵌套对象：取每个元素的 path 字段渲染成图

适用于 `images: List<{ path: string, ... }>`

```json
[{ "image": "images.[*].[path]" }]
```

### 1.7 把 metadata 列以 JSON 高亮显示

```json
[{ "highlight": "metadata", "lang": "json" }]
```

### 1.8 综合：每张卡片显示 prompt + 生成图 + 视频，各带标签

```json
[
  { "from": "prompt", "label": "Prompt" },
  { "image": "image", "label": "Generated" },
  { "video": "preview_video", "src": "../videos/{value}", "label": "Preview" }
]
```

---

## 2. Selector 语法（取值路径）

`from` 字段是一个**取值表达式**，描述怎么从一行里拿到你想展示的值。

| 写法 | 含义 |
|------|------|
| `prompt` | 取列 `prompt` 的值 |
| `image.path` 或 `image.[path]` | 列 `image` 是对象，取它的 `path` 字段 |
| `images.[0]` | 列 `images` 是列表，取第一个 |
| `images.[-1]` | 取最后一个（负数从末尾倒数） |
| `images.[*]` | 列表里**每个元素**都展示一份（关键操作） |
| `images.[0:3]` | 取前 3 个（切片，仍是列表） |
| `images.[0:3].[*]` | 前 3 个，每个展示一份 |
| `images.[5:]` | 从第 6 个开始的所有 |
| `prompt.[0:200]` | 字符串前 200 个字符 |
| `meta.tags.[*]` | 先取嵌套对象的字段，再展开列表 |
| `` `weird.col` `` 或 `"weird.col"` | 列名含 `.` / 空格等特殊字符时**包起来**（见下方铁律 4） |

**4 条铁律**：

1. 第一个 token 是**列名**，后面用 `.` 链接更深的访问。
2. 一条 selector 里 `.[*]` **最多出现一次**（多次是笛卡尔积，目前不支持）。
3. `.[:]` 不允许（含义模糊）。想"展示全部"用 `.[*]`，不是 `.[:]`。
4. **列名含特殊字符**（`.` / 空格 / `-` / `#` 等）时必须包起来：用反引号 `` `name` `` 最方便（在 JSON 里无需转义），双引号 `"name"` 也行但要 JSON-escape 成 `"\"name\""`。同样适用于嵌套字段：`` `weird.col`.[`sub.field`] ``。

---

## 3. Widget（渲染方式）

| widget | 用途 | 必填 | 可选 |
|--------|------|------|------|
| `default` | 文字 / 数字 / 对象的默认展示 | — | `maxHeight` |
| `highlight` | 代码高亮 | `lang` | `maxHeight` |
| `image` | 图片 | — | `src` |
| `video` | 视频（带控件、支持 Range） | — | `src` |
| `audio` | 音频 | — | `src` |
| `link` | 超链接 | — | `src` |
| `markdown` | Markdown 渲染（不支持 raw HTML） | — | `maxHeight` |

**`src` 是什么**：image/video/audio/link 的 URL/路径模板。字符串里的 `{value}` 在渲染时替换成 cell 的值；其他字符原样。例：

| `src` | 效果 |
|-------|------|
| 不写（缺省 `"{value}"`） | cell 值直接当作路径，相对路径锚到数据文件所在目录 |
| `"./images/{value}"` | 图片实际在源数据文件的 `images/` 子目录 |
| `"../edits/{value}"` | 在上一级的 `edits/` 目录 |
| `"https://cdn.example.com/{value}.png"` | 从 ID 列拼远程 CDN URL |
| `"/static/logo.png"` | 不含 `{value}`：所有行都展示这张固定图（cell 值被忽略）|

**`lang` 取值**：常见的 `json` / `python` / `typescript` / `sql` / `bash` / `yaml` / `markdown` / `html` 都支持，没注册的 lang 退化为纯文本。

---

## 4. 必备约定（不会变的 6 条）

1. **顶层 JSON 数组就是一个 flow 容器**：所有 widget **横向排**，挤不下自动换行。不用写 `{ "kind": "flow", "children": [...] }`。
2. **想要"新的一行"就用显式容器**：`{ "row": [...] }` / `{ "column": [...] }` / `{ "grid": [...] }` 三者都自带 `width: 100%`，在父 flow 里**强制占满整行**。`row` 还会强制内部不换行（卡片窄就 overflow）。
3. 字符串 `"foo"` ≡ `{ "from": "foo" }`，是最短的 atom 简写。
4. `{ "image": "x" }` ≡ `{ "show": "image", "from": "x" }`。所有 widget 都能这么简写。
5. `{ "row": [...] }` ≡ `{ "kind": "row", "children": [...] }`。`flow` / `column` / `grid` 同理。
6. 缺省渲染是 `default`，不用写 `"show": "default"`。

**直觉记忆**：把每张卡片想成 CSS `flex-wrap: wrap`；想要"分段"就用容器，每个容器自动起新一行。

---

## 5. 常见错误模式（AI 最容易写错的）

| 你想做的 | 写错了 | 正确 |
|----------|--------|------|
| 代码高亮 | `{ "highlight": "code" }` | `{ "highlight": "code", "lang": "python" }`（`lang` 必填） |
| 列表全部展示 | `{ "image": "images.[:]" }` | `{ "image": "images.[*]" }` |
| 第一张图 | `{ "image": "images[0]" }`（缺前面的 `.`） | `{ "image": "images.[0]" }` |
| 给单值加 layout | `{ "image": "thumb", "layout": "grid" }` | 单值用不上 layout；想多个就把 selector 改成 `.[*]` 结尾 |
| 给文字加 src | `{ "from": "prompt", "src": "../{value}" }` | `src` 只能在 image/video/audio/link 上用 |
| 把 layout 写在容器里给 atom | `{ "row": [...], "layout": "grid" }` | row 是容器，不接 layout；要网格用 `{ "grid": [...], "columns": 3 }` |
| 列名含 `.` 时直接写 | `{ "from": "weird.col" }`（会被解析成"列 weird → 字段 col"） | `` { "from": "`weird.col`" } ``（反引号包起来） |

**3 条 cross-field 规则**（最容易漏，AI 体外校验时重点看）：

- `lang` **仅且必须**在 `show: "highlight"` 时出现。
- `src` 只能在 image / video / audio / link 上出现。
- `layout` / `columns` / `gap` / `empty` **要求 selector 里写了 `.[*]`**，否则报错（因为只有一个值，谈不上排布）。

---

## 6. 不支持的功能（让 AI 不要尝试）

- 多个 `.[*]` 串联（笛卡尔积）。
- 条件渲染 / filter（`.[?expr]` 是预留语法，未实现）。
- 跨行聚合、排序、筛选。
- 自定义 widget。
- Markdown 里的 raw HTML。

---

## 7. 给 AI 的 prompt 模板（直接复制）

```
你要为 OmniStream 的 Rows View 写一份 JSON 配置。完整规则如下：

<<<在这里粘贴本文件第 1-6 节的全部内容>>>

我的数据文件有这些列（来自 schema）：
- prompt: string
- images: List<struct{ path: string, width: int }>
- clip_path: string
- metadata: struct<...>
- code: string

我想要的展示效果是：
<<<用你自己的话描述，例如：
左边竖向展示 prompt（窄字段）和 code 字段以 python 高亮；
右边以 3 列网格显示 images.path 对应的图片；
最下方完整展示 metadata 的 JSON。>>>

请只输出 JSON 数组，不要 markdown 代码块包裹，不要解释。
确保符合「常见错误模式」和「3 条 cross-field 规则」。
```

填充两个 `<<<...>>>` 区块后整段发给 AI 即可。

---

## 附：在哪里粘贴配置

在 Rows View 页面（URL `/r/<storage>/<file>`），右上角点 **Rules** 按钮，把 JSON 粘进对话框 Save 即可。规则会压缩进 URL 的 `?rows=` 参数，链接可以直接分享。
