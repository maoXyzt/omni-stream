# HTML 页面预览

打开 `.html` 或 `.htm` 文件后，工具栏提供 **Source / Preview**：

- 默认展示源码；点击 **Preview** 后，在当前预览区域渲染页面。
- 支持页面样式和 JavaScript 交互；点击 **Source** 返回源码。
- 分栏预览和弹窗预览均可使用，源码编辑功能保持可用。
- 大文件沿用分段读取，必须加载完整文件后才能渲染，避免执行截断的脚本。

预览复用已读取的文件内容，通过 `iframe srcdoc` 渲染，因此 S3 对象即使
标记为 `text/plain` 也能预览；读取 HTML 正文继续使用现有鉴权。
无需部署新服务，也不需要额外的前端运行时依赖。

## 资源路径和适用范围

相对资源路径以 `/raw/<storage>/<文件路径>` 为基准；在页面内容前设置的
`base` 优先于文件中已有的 `base`。同目录的公开图片、CSS、普通脚本可直接加载。
开发模式也会将 `/raw` 请求转发给 Rust 服务。

页面在仅启用 `allow-scripts` 的沙箱中运行，无法读取管理页面 DOM 或
localStorage 中的 token，也不能跳转顶层页面。该模式适合静态报告和独立的交互页面，
不等同于完整网站托管：

- 页面内的 `fetch`、模块脚本、字体等资源遵循跨域限制，资源服务需要允许相应 CORS 请求。
- CORS 只限制脚本读取跨域响应，不能阻止脚本发送请求；不可信 HTML 中的脚本可能将预览内容发送到外部地址。部署时应结合有效的 CSP、网络出口限制和可信内容控制。
- 需要 Bearer token 的关联资源不会自动附带管理页面的凭据。
- 表单提交、弹窗、下载和需要同源存储的功能受沙箱限制。

参见 [MDN iframe sandbox 文档](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox)。
