# 闪创海外短剧 Flutter App

同一份 Flutter 代码按代理商生成独立 Android/iOS App。正式包必须分别配置 App ID、签名、商店账号、AdMob App ID、推送与 OAuth；远程配置只更新语言、国家、广告位、商店商品映射和运营开关。

## 本地运行

```bash
flutter pub get
flutter run --dart-define=API_BASE_URL=https://verified-agent-domain.example
```

省略 `API_BASE_URL` 时使用内置的无版权演示卡片，不发起生产请求。Android/iOS 工程内的 AdMob App ID 是 Google 官方测试 ID，代理商正式构建前必须替换。

## 已接入的服务端接口

- `GET /api/v1/customer/bootstrap`
- `GET /api/v1/customer/content/dramas`
- `GET /api/v1/customer/content/dramas/:id`
- `POST /api/v1/customer/auth/login`
- `GET /api/v1/customer/playback/episodes/:id/url`

登录请求会按当前运行平台携带 `android` 或 `ios` 设备类型。Google/Apple 按钮在代理商 OAuth 客户端 ID 和服务端令牌交换配置完成前只给出明确配置提示，不会伪造登录成功。
