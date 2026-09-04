# Night Flix 海外短剧 Flutter App

同一份 Flutter 代码按代理商生成独立 Android/iOS App。正式包必须分别配置 App ID、签名、商店账号、AdMob App ID、推送与 OAuth；远程配置只更新语言、国家、广告位、商店商品映射和运营开关。

## 本地运行

```bash
flutter pub get
flutter run --dart-define=API_BASE_URL=https://verified-agent-domain.example
```

省略 `API_BASE_URL` 时使用内置的 Night Flix 测试剧目和本地竖屏视频，不发起业务 API 请求；演示登录页已预填测试账号，锁集使用 Google 官方测试广告位。Android/iOS 工程内的 AdMob App ID 是 Google 官方测试 ID，代理商正式构建前必须替换。总后台的内部测试构建任务直接复制本 Flutter 工程，不再使用旧 Capacitor 壳。

## 已接入的服务端接口

- `GET /api/v1/customer/bootstrap`
- `GET /api/v1/customer/content/dramas`
- `GET /api/v1/customer/content/dramas/:id`
- `POST /api/v1/customer/auth/login`
- `GET /api/v1/customer/playback/episodes/:id/url`

登录请求会按当前运行平台携带 `android` 或 `ios` 设备类型。Google/Apple 登录和 Apple/Google 原生购买只有在客户端凭据、服务端令牌或回执校验及沙盒联调全部可用后才开放；当前测试配置不展示假入口，也不会只凭客户端回调发放权益。
