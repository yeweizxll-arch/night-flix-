# 单服务器生产部署基线

本目录把当前模块化系统先部署在一台应用服务器上。与闪创一致，用户端 Web API、异步 Worker、
总部 Admin API、代理商 Agent API 是四个独立运行和发布单元；总部后台、代理商后台和兼容 H5 也使用
各自的静态制品镜像，不存在一个容器同时承担多种入口的情况。正式数据库、Redis、
对象存储和 CDN 仍应使用外部托管服务，不放进这份生产 Compose。

## 发布顺序

1. 复制 `production.env.example` 为服务器私有的 `production.env`，填入密钥管理系统注入的真实值。
   该文件不得提交到 Git。
2. 在本地或 CI 构建并推送带 commit SHA 的固定版本镜像；生产机禁止安装依赖或构建源码。
3. 先迁移，再同步权限，最后按 web、worker、admin、agent 四个单元分别滚动更新。

```bash
# 仅限本地或 CI：
docker compose --env-file deploy/production.env -f deploy/compose.production.yml build
docker compose --env-file deploy/production.env \
  -f deploy/compose.production.yml --profile tools run --rm migrate
docker compose --env-file deploy/production.env \
  -f deploy/compose.production.yml --profile tools run --rm permissions-sync
docker compose --env-file deploy/production.env \
  -f deploy/compose.production.yml up -d web-api worker admin-api agent-api platform-admin tenant-admin h5
```

Compose 只把三个 Web 入口绑定到 `127.0.0.1`。公网 TLS、WAF、证书和域名路由应由服务器前的
负载均衡器/Cloudflare/Caddy 负责：

- 平台后台域名转发到 `127.0.0.1:8081`。
- 商家后台域名转发到 `127.0.0.1:8082`，原始 `Host` 必须是数据库已验证的商家域名。
- 商家 H5 域名转发到 `127.0.0.1:8083`，同样保留原始 `Host`。

不要让平台后台域名同时成为商家域名。商家后台和 H5 如果使用两个不同子域名，两个域名都要完成
租户域名验证；反向代理不能把所有请求改写成一个公共 Host，否则服务端会拒绝租户上下文。

## 必须验证

- `GET /api/v1/health` 只表示对应进程存活；发布流量前必须分别以 `/api/v1/health/ready` 验证 web、admin、agent。
- 三个 API 入口在进程最前层执行路由白名单：web 只接受 customer/webhook，admin 只接受 platform，agent 只接受 tenant；越界路由固定返回 404。
- API 和 Worker 启动时会检查 tenant/platform/resolver 三个数据库角色不同、无 BYPASSRLS、非表 owner，
  resolver 只有域名解析函数权限。
- `DATABASE_SSL=verify-full` 固定开启；不要为了同机方便降级成明文数据库连接。
- 生产保持 `CUSTOMER_UNIVERSAL_OTP_ENABLED=false` 和 `ALLOW_INSECURE_OTP=false`。
- H5 的 CSP 需要把真实 CDN/对象存储 HTTPS origin 精确加入 `media-src`、`img-src` 和 `connect-src`；
  不要用宽泛的 `https:`。基础 nginx 模板故意不猜测这些域名。
- 至少备份数据库并完成一次恢复演练，再开放真实 Stripe live 配置。

## 独立应用构建机

应用构建不会在本文件的 API/通用 Worker 容器内运行，Compose 已强制保持
`APP_BUILD_WORKER_ENABLED=false`。Android Gradle 工具链和 iOS Xcode 工具链应安装在隔离构建机；iOS
模拟器构建必须使用 macOS。构建机只能读取固定源码模板和预热的依赖缓存，不能从任务 body 接收命令、
路径、环境变量或任意 URL。

构建机使用独立的生产环境文件，复用平台最小权限数据库连接和对象存储密钥，并额外设置：

```bash
APP_BUILD_WORKER_ENABLED=true
APP_BUILD_EXECUTOR=local
APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID=018f0000-0000-7000-8000-000000000001
APP_BUILD_TEMPLATE_ROOT=/opt/drama/apps/flutter_app
APP_BUILD_FLUTTER_BIN=/opt/flutter/bin/flutter
APP_BUILD_PUB_CACHE=/opt/drama-build-cache/pub
APP_BUILD_TMP_ROOT=/var/lib/drama-app-build/tmp
APP_BUILD_GRADLE_USER_HOME=/opt/drama-build-cache/gradle
APP_BUILD_COCOAPODS_BIN=/opt/homebrew/bin/pod
APP_BUILD_POLL_INTERVAL_MS=2000
WORKER_ID=app-build-macos-01

pnpm --filter @drama/api worker:app-build
```

专用进程从正式 Flutter 工程生成隔离的 Android/iOS 测试包，只公布实际可用的构建能力，并每 10 秒更新心跳。
心跳超过 30 秒或平台构建产物存储被停用时，总后台会立即禁止新建对应任务，不会产生无人消费的排队。
`WORKER_ID` 应在每台构建机上唯一；若未设置，进程会生成仅本次运行有效的随机标识。

模板版本、Gradle/Swift 依赖和工具链必须随发布镜像或构建机版本固定。Gradle 使用 `--offline`，Xcode
禁止自动解析包；升级依赖应先在非生产构建机完成真实 APK/Simulator 冒烟测试。每个任务使用独立临时目录，
命令以固定 argv 启动，原始 stdout/stderr 不写数据库或后台页面，结束后删除工作区。Android 当前为临时
调试签名，重新构建后可能需要先卸载旧调试包；它不能替代正式 keystore。AAB、iOS 真机、TestFlight 和
App Store 在签名凭据、商店合规支付、推送和发布流程完成前保持不可用。
