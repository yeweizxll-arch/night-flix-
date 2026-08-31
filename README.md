# 短剧 SaaS

面向 20～30 个商家的多租户短剧平台。项目采用全新服务端和全新后台；用户提供的旧源码包仅用于理解业务，不复制其中的加密后端、固定远程依赖、凭据或历史用户数据。

## 当前目录

- `apps/api`：NestJS 服务端，优先实现租户隔离、认证、权限、内容、交易和审计。
- `apps/admin`：总后台与商家后台共用的 React 前端，菜单和数据范围由权限控制。
- `apps/h5`：连接真实 Customer API 的用户端 H5，按已验证商家域名加载白标配置。
- `apps/mobile`：Capacitor 原生壳固定模板；内部 Android APK/iOS Simulator 构建由独立构建机在临时工作区生成。
- `packages/contracts`：跨应用共享的权限、角色和接口契约。
- `docs`：产品范围、架构、领域设计、后台信息架构和部署方案。

## 本地启动

```bash
pnpm install
pnpm dev
```

API 默认监听 `http://localhost:3000`，后台默认监听 `http://localhost:5173`，H5 默认监听
`http://localhost:5174`。H5 本地联调还需设置 `VITE_H5_TENANT_HOST` 为数据库中已经验证的商家域名。

异步任务必须使用独立进程持续运行；它负责 Outbox、内容排期与导入、通知与验证码投递、
邀请佣金结算和隐私擦除，不能只启动 HTTP API：

```bash
pnpm worker
```

总后台创建的 Android 调试 APK 和 iOS 模拟器包由单独构建机处理，不能和 API/普通 Worker 混跑。
构建机完成离线 Gradle/Swift 依赖预热并配置平台产物对象存储后启动：

```bash
pnpm worker:app-build
```

当前只开放内部测试包。Android AAB、iOS 真机、TestFlight 和 App Store 在正式签名、商店支付、推送
与审核资料全部配置前保持不可用；后台不会展示可点击的假发布按钮。

初始化或升级数据库后依次执行迁移和权限同步：

```bash
pnpm db:migrate
pnpm permissions:sync
```

## 安全边界

- 商家业务表强制包含 `tenant_id`，租户由已验证域名或可信平台会话确定。
- 禁止客户端通过普通请求头随意指定租户。
- 订单、资金流水、审核记录和审计日志不可硬删除。
- 万能验证码 `8888` 默认关闭；需要同时开启通用开关和生产环境不安全开关才会生效，命中会写审计。上线联调结束后应立即关闭。
- 视频由对象存储和 CDN 分发，API 服务不代理视频流量。
- Stripe 使用服务端 Hosted Checkout、原始请求体验签和加密凭据；Fake 支付仅允许非生产测试。
- 账号“停用”和“隐私擦除申请”是两条不同流程。擦除由 Worker 分步骤去标识，依法保留的财务与安全事实不会伪装成已物理删除。
