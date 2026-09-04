# 短剧 SaaS

面向多代理商的海外短剧平台。保留原 NestJS、PostgreSQL、Redis、多租户和管理后台业务基础，正式移动端改为 Flutter；参考 App 只用于复刻可见产品行为，不复制反编译代码和素材。

## 当前目录

- `apps/api`：NestJS 模块化单体代码，生产拆为 web、worker、admin、agent 四个独立运行与发布单元。
- `apps/admin`：总后台与商家后台共用的 React 前端，菜单和数据范围由权限控制。
- `apps/flutter_app`：正式 Android/iOS 客户端，支持租户启动配置、竖滑刷剧、剧场、选集、试看锁集、金币商店、历史、收藏和个人中心。
- `apps/h5`：保留为接口和旧业务逻辑参考，不再作为正式移动端。
- `apps/mobile`：旧 Capacitor 测试壳，已停止作为正式客户端继续开发。
- `packages/contracts`：跨应用共享的权限、角色和接口契约。
- `docs`：产品范围、架构、领域设计、后台信息架构和部署方案。

## 本地启动

```bash
pnpm install
pnpm dev
```

根目录 `pnpm build` 只构建当前有效的 Web/API/后台工作区；已停用的 Capacitor 测试壳仅在明确提供内部测试地址后单独构建，不再进入正式总构建。

API 默认监听 `http://localhost:3000`，后台默认监听 `http://localhost:5173`，H5 默认监听
`http://localhost:5174`。H5 本地联调还需设置 `VITE_H5_TENANT_HOST` 为数据库中已经验证的商家域名。

Flutter 使用代理商已验证的 API 域名作为构建参数；不传时启动无版权素材的本地演示数据：

```bash
cd apps/flutter_app
flutter run --dart-define=API_BASE_URL=https://drama.agent.example
```

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
- 短剧 SaaS 的进程、数据库和密钥与闪创主平台隔离；闪创只经受控总部发布接口写入公共剧池。
- Stripe 使用服务端 Hosted Checkout、原始请求体验签和加密凭据；Fake 支付仅允许非生产测试。
- 账号“停用”和“隐私擦除申请”是两条不同流程。擦除由 Worker 分步骤去标识，依法保留的财务与安全事实不会伪装成已物理删除。
