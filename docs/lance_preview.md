# Lance 数据集与数据文件预览

## 范围

在 LocalFS 或 S3 存储中，点击 `.lance/` 目录进入文件列表，可以继续浏览 `_versions/`、`data/` 等子目录。目录工具栏的 **Browse as cards** 打开数据集预览；点击 `data/` 下的单个 Lance v2 数据文件则打开文件预览。两种入口默认打开 **Schema**，展示行数、列数、字段类型以及字段是否允许为空。目录摘要包含版本和分片数，文件摘要包含文件格式版本和大小。切换到 **Data** 时才读取记录。

| 入口 | 表格内容 | 如何读行数 |
| --- | --- | --- |
| `example.lance/` → **Browse as cards** | 所选快照中的有效记录，可跨多个分片。首次打开时读取最新版本，后续翻页使用同一版本。 | **Rows** 表示该快照的有效记录总数。 |
| `example.lance/data/part.lance` | 当前文件中的物理行。也可直接打开存储中独立的 Lance v2 数据文件。 | **Physical rows** 只统计当前文件，可能包含快照中已删除的行。 |

例如，版本 1 在同一个分片中写入 ID 1 和 2，版本 2 删除 ID 1。此时打开数据集会看到 ID 2；如果原分片仍在，打开它会看到 ID 1 和 2。

## 分页与字段显示

- 默认每页 10 行。一次读取超过预览限制时，从 10 行缩到 5 行，仍超限时缩到 1 行。表格按实际页长更新页码和总页数。单行仍超限时，界面显示行号及触发的限制，可通过分页控件返回或跳过该行。
- 表格保留字段名和类型。数字、字符串、布尔值、时间类型，以及长度不超过 2,048 的定长数值向量可直接查看。二进制和不定长嵌套字段等未读取的列显示 `(value omitted)`。
- 超出 JavaScript 安全整数范围的整数，以及 Arrow Decimal 列的值，以十进制字符串返回，保留原始精度。

## 接口与边界

源码构建需安装 protobuf 编译器（`protoc`），构建前端后执行 `cargo build --release --features lance`。可通过 `GET /api/server` 的 `lance_enabled` 字段确认服务是否启用了预览。

以下示例假设已配置名为 `local` 的存储，路径相对于该存储的根目录。

```http
GET /api/lance/example.lance?storage=local&offset=0&limit=10
GET /api/lance/example.lance/data/part.lance?storage=local&physical=true&offset=0&limit=10
```

- `schema_only=true` 只返回摘要与字段定义，`rows` 为空。
- `offset` 从 0 开始，`limit` 范围为 1–20。数据集响应包含 `version`，后续请求可传入该值以读取同一快照。物理文件响应包含 `file_format`，只接受无快照版本的请求。
- 每次请求的存储读取预算为 32 MiB，展示预算为 4 MiB。超限返回 HTTP 413，由前端缩小页长重试。服务按行消费解码结果，累计 JSON 到达展示上限时停止读取后续行。Lance SDK 可能需要先解压整块变长数据才能返回一行，因此 4 MiB 不是解码器的峰值内存上限。
- 预览沿用存储后端的只读权限和路径检查。引用外部数据路径的 Lance 数据集暂不支持。
