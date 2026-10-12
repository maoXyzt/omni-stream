# ADR 0001：在 Rust 服务内实现 Header-only Safetensors 预览

## 状态

已接受

## 背景

文件浏览器需要展示 Safetensors 文件中的 Tensor key、shape、dtype 和体积估算。权重文件可能达到数百 GB，下载或加载完整文件会增加网络、内存和部署依赖。

## 决策

复用现有 `StorageBackend` 的 `stat` 与 Range 流，在 Rust 服务内读取 8 字节长度前缀和有限 JSON Header。解析结果通过 `/api/safetensors/{key}` 返回给现有前端预览器；不引入 Python、GPU、模型执行引擎或独立 iframe 服务。

## 后果

- LocalFS 和 S3 共享同一条接口，读取量只与 Header 大小相关。
- 可以可靠地列出 key、shape、dtype、元素数量和文件中 Tensor 数据区的字节数。
- 不能从权重文件推导执行图、模型身份或运行显存；KV Cache、激活和精度转换仍需其他数据源。
- Header 解析受到固定大小、Tensor 数量和 rank 上限约束，异常文件会以 400 返回。
