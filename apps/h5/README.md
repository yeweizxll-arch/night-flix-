# H5 客户端

本应用只连接真实 customer API，不包含假数据。注册会先加载当前法律文档版本，要求邮箱或手机 OTP 验证并精确提交用户勾选的 consent；支付只接受服务端的 Stripe Hosted Checkout `checkoutAction`，不自动回退其他路由。试看只在剧集配置独立 `previewMediaAssetId` 且服务端签发该短片 URL 时可用，绝不回退到正片 URL。

## 本地预览

先启动 API，然后使用数据库中已经验证的 tenant 域名启动 H5：

```bash
VITE_H5_TENANT_HOST=merchant.example.test VITE_H5_RELEASE_CHANNEL=test pnpm --filter @drama/h5 dev
```

浏览器访问 `http://127.0.0.1:5174/`。开发代理会把 `/api` 转发到 `http://127.0.0.1:3000`，并使用 `VITE_H5_TENANT_HOST` 作为 API Host。也可通过 `VITE_H5_API_TARGET` 修改 API 地址。真实部署必须让 H5 与 API 位于同一已验证 tenant 域名，不能让客户端提交 tenantId。

`VITE_H5_RELEASE_CHANNEL` 只允许 `test` 或 `production`，默认为 `test`。测试构建显示顶部横幅并在页面标题标记 Internal Test；生产构建必须显式传入 `VITE_H5_RELEASE_CHANNEL=production`，不显示测试标识。非法值会直接使构建失败，不会静默当作生产。

## 会话边界

- access token 只保存在 JavaScript 内存中。
- refresh token 只保存在当前标签页的 `sessionStorage`，关闭标签页后不保留；不提供“记住登录”。
- 服务端签发的设备 token 不是登录凭据，单独保存在同源 `localStorage`，只用于关闭标签页后识别同一浏览器设备，避免反复占用 3 台设备额度；退出登录、刷新接口临时故障都不会删除它。
- refresh 明确返回 401 时清除认证会话；网络错误或 5xx 保留 refresh token，允许用户稍后重试。
- 401 只重试一次；并发 401 共用同一个 refresh 请求。
- 同一写请求在 access refresh 重试时复用同一个 `Idempotency-Key`。
- 法律文档使用 React 节点安全渲染 Markdown，不使用 `innerHTML`，原始 HTML 只会成为文本。
- 隐私数据导出逐页调用 `no-store` API 并以 Blob 下载，密码只留在当前表单内存；擦除请求返回 202 后立即清除本地 access/refresh/device 身份。
- 页面不加载第三方脚本、统计 SDK 或远程字体。

## 建议 CSP

生产环境建议由反向代理设置响应头，并把示例中的媒体/对象存储 origin 替换成实际白名单：

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: https://cdn.example.com; media-src 'self' blob: https://media.example.com; connect-src 'self' https://cdn.example.com https://media.example.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests
```

`style-src-attr 'unsafe-inline'` 只用于写入服务端已经校验为六位十六进制的白标 CSS 变量；不允许内联脚本。若对象存储使用临时直连域名，必须把每个允许的 HTTPS origin 精确加入 `media-src`/`connect-src`，不要在生产中使用宽泛 `https:`。

同时建议设置：

```text
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
```

## 验收

```bash
pnpm --filter @drama/h5 test
pnpm --filter @drama/h5 typecheck
pnpm --filter @drama/h5 build
```
