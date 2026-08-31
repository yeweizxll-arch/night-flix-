# Android / iOS 内部测试壳

这是第一阶段安装包，只用于上架前内部验收。每个构建固定绑定一个已经通过平台验证、TLS 状态为
active 的商家 HTTPS H5 域名，不提供输入网址或切换到其他站点的入口，也不允许 HTTP、IP 地址、
带路径或带凭据的 URL。

```bash
export MOBILE_SERVER_URL=https://video.merchant.example

pnpm --filter @drama/mobile android:debug
pnpm --filter @drama/mobile ios:simulator
```

Android debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。iOS 命令生成无需签名的
Simulator `.app`；真机/TestFlight 仍需商家的 Apple Developer Team、证书和 provisioning profile，
不能由源码自动伪造。

当前内部壳固定使用 `com.drama.saas.test / Drama SaaS Test`。商家独立应用 ID、名称和图标必须由
后续隔离构建任务在临时工作区生成；不能只改 Capacitor 配置后假装原生工程已经换包名。

## 热更新和上架边界

内部测试壳使用固定远程 H5，所以 H5 发布后测试包会立即看到更新。它不等于可直接提交应用商店的
生产热更新方案。正式上架包必须经过以下收口：

- 把审核时的 Web 资源随二进制打包，代码功能更新走 App Store/Google Play 发布；远程配置只更新
  白标文字、图标、主题、内容和运营开关，不能绕过商店审核改变主要功能。
- iOS/Android 数字内容支付分别接 Apple IAP/Google Play Billing 或目标地区明确允许的支付方案；
  不能把当前 Stripe 外部收银直接当成全球商店合规方案。
- 接入原生 APNs/FCM 注册、深链、返回键、网络错误页和商店隐私清单后，再生成上架包。
- 每个商家的 bundle/application ID、签名证书、图标、名称和商店资料独立管理，构建日志不得包含密钥。

Capacitor 采用当前 v8。Apple 禁止下载会改变应用功能的代码绕过审核，Google Play 也禁止 SDK
从商店外下载 dex/native code 或自行更新 APK，因此本项目不会承诺无限制的生产代码热更新。
