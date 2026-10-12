# Safetensors 权重文件预览

## 范围

在文件列表的内联预览和弹窗预览中查看单个 `.safetensors` 文件：文件元数据、Tensor key、shape、dtype、元素数量、权重字节数、按 dtype 汇总，以及 key / dtype 搜索和分页。大文件只读取 Header，不下载或加载权重，不需要 Python、GPU 或独立服务。

预览反映当前文件（可能仅是一个分片、Embedding 或适配器），不自动聚合分片。存储元素总数不等同于模型可训练参数总数，尤其在权重量化或包含 buffer 时。权重体积不等同于运行显存；KV Cache、激活、计算缓冲区和加载后的精度转换不在本次估算范围内。Tensor 名称也不能证明模型身份或质量。

## 接口与边界

- `GET /api/safetensors/{key}?storage={storage}`，继承现有只读接口鉴权。
- 经 `dyn StorageBackend` 读取，沿用 LocalFS / S3 的路径及权限校验，不修改存储 trait。
- 读取前 8 字节获取 Header 长度，再读取 JSON Header；解析前用 `stat` 的文件大小检查 Header 是否越界。
- Header 上限 4 MiB，Tensor 上限 50,000，rank 上限 32；每个请求独立执行，暂不引入全局解析队列。
- 拒绝无效 shape / dtype / offset、溢出、截断文件及数据区空洞/重叠；不读取权重内容，因此不验证数值或文件哈希。
- API 的元素数量、shape 维度和字节数采用十进制字符串，避免浏览器整数精度丢失；表格每页最多 100 个 Tensor。

## 验证边界

通过 Header 解析入口验证格式和统计，通过存储读取入口验证有界读取和错误传播，通过预览注册表和组件验证界面集成。单元测试覆盖截图中的 `[50, 5120]` BF16 样例（256,000 元素，512,000 字节）、标量和不连续数据区。

格式依据：[Safetensors 格式](https://github.com/safetensors/safetensors)、[HF 元数据读取](https://huggingface.co/docs/safetensors/metadata_parsing)。
