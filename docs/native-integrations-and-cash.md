# 原生集成、播放授权与现金核算

本文件描述配置契约，不是部署授权。所有构建在本地或独立 CI；生产只部署已构建、已校验的制品。Night Flix 保持 web-api / admin-api / agent-api / worker / 双静态后台独立，数据库与闪创独立。

## 私有运行配置

- PLAYBACK_HLS_KEY：独立至少 32 字节随机签名秘密，不复用支付密钥。
- GEO_EDGE_HMAC_KEY：独立至少 32 字节边缘鉴别秘密。存在地域限制但无法确定可信国家时，拒绝访问。
- TRUST_PROXY：仅实际直连代理的 IP/CIDR，禁止 true、跳数或 /0。
- NATIVE_INTEGRATIONS_FILE：绝对路径、只读 JSON；根对象 key 为 tenant UUID，值包含 googleClientId（服务端 audience）、googleIosClientId、appleClientId（App bundle ID）。
- NATIVE_STORES_FILE：绝对路径、只读 JSON；根 key 为 tenant UUID，内层分别为 apple / google；没有配置时不开放原生购买能力。
- 私有文件不放入 Git、App 包、构建附件或 Docker 镜像。可选 deploy/compose.native-integrations.yml 仅将 NATIVE_CREDENTIALS_DIRECTORY 只读挂载到 web-api 的 /run/nightflix-native，目录内两个配置文件必须存在，未启用租户不列出即可。

NATIVE_STORES_FILE 中每个商店配置：

| 字段 | 约束 |
| --- | --- |
| applicationId | 本代理商 Android application ID / iOS bundle ID |
| environment | Sandbox 或 Production，严格隔离 |
| products | 商店 SKU → { kind: points_topup 或 membership, productId: 本租户商品 UUID } |
| apple | issuerId、keyId、privateKeyPath、rootCertificatePaths；Production 另需 appAppleId |
| google | serviceAccountPath、notificationAudience、notificationEmail |

Apple 使用本代理商 App Store Server API 密钥、有效 EC P-256 私钥、官方根证书；生产 appAppleId 必填。Google 服务账号需具备对应 applicationId 的订单/购买读取及确认权限，RSA 私钥文件使用 service_account JSON。notificationEmail 是 Pub/Sub 推送身份邮箱，audience 与回调地址严格匹配。容器配置内所有私钥路径须使用 /run/nightflix-native/…，不是宿主机路径。完整 TypeScript 结构位于 apps/api/src/commerce/native-store-config.ts。

服务端校验 App、环境、SKU、数量、账号绑定、币种、真实实付金额、最新退款及有效期，不信任客户端价格。Apple 重新查询服务器交易并验官方证书链；Google 读取 paid order。测试交易不进入真实分成。

准备购买即固定 SKU 的本地商品/实付及赠送金币额度。修改额度必须新建商店 SKU；退役 SKU 映射须保留用于恢复/退款，不可换绑。会员以商店有效期为准。

## 购买与通知路由

- 客户端：POST /api/v1/customer/native-store/prepare → 原生商店 SDK → /verify；服务端持久发放后才 complete/consume。失败保留待恢复，不要求重新付款。
- Apple：POST /api/v1/payments/webhooks/native/apple/:tenantId，V2 signedPayload。
- Google：POST /api/v1/payments/webhooks/native/google/:tenantId，已验证 JWT 身份的 Pub/Sub RTDN。
- 未知未绑定交易返回可重试错误，不记入别人的账号；Google 历史续期退款按被退款的旧 order 查询，不操作最新成功订单。
- 商店退款在渠道办理，后台只展示商店交易和验证后的退款状态，不能用普通渠道订单的退款按钮替代。
- 仍需真实沙盒验证重装、账号切换、退款先到、续期、断网、购买确认及恢复；本地测试并未完成这些真实外部场景。

## 总部现金分账

“内容分成与月度结算”选择代理商后：

1. 配置公共/私有、金币/会员/内容广告的分成比例。私有内容与会员的创作者份额为 0。
2. 明确选择 gross（原币实付）或 net（手续费后原币净收入）；系统不默认做业务决定。
3. 实付金币消费按来源现金与 FIFO 区间折算，整数最小货币单位计算；赠送/人工调整金币不产生现金，沙盒不计正式分成。
4. 缺策略、缺 net 凭据或缺创作者信息保留待核算并阻止月结。已有快照不因后台改价改变；手动核算明确采用当前策略补齐此前未配置的事件。
5. Apple 缺精确净额、Google 返回不足一分的净额等情况，不拒绝合法购买也不估算现金。总部使用“录入商店净收入凭据”补全，再核算。
6. 内容广告只登记总部已核对的财务报表行。客户端广告 paid-event/ILRD 进入 client_unverified 观测表，不能直接变成分账或解锁凭据。观测按租户保留 90 天，请求中分批清理。
7. 报表编号、行号及 SHA256 是总部归档索引，提交者负责真实性；一个哈希不等于系统已经向渠道验证文件。重复提交幂等，不同事实拒绝覆盖。
8. 退款先回收未消费的实付/赠送金币，再对需要退回的已消费现金追加负账。已结算原记录不覆盖；不足余额形成退款债务，后续充值偿还。net 按原净额比例冲正，最终手续费差异仍需财务对账。
9. 每租户、币种、UTC 已结束自然月单独关账，包括空月；后到记录进入当前未关账月。页面汇总由数据库计算，不受最近 1000 条明细截断影响。

0038 迁移从不可变旧金币流水重建来源并校验现有钱包余额，不重新充值，不把无法解释的余额变赠币；错误回滚整个迁移。旧实付/直接订单需总部历史核对，待核算清零并登记核对报告后才能解除历史月结保护；不是自动重记已结算历史收入。

## 受控源存储和 HLS

总部 POST /api/v1/platform/content-management/media/uploads/source-reference，使用已有总部 S3 provider，提供 objectKey、显式 versionId、作品与创作者标识，禁止任意外部 URL。源桶必须开启版本保留并允许读取指定版本。

HLS 登记固定主清单、子清单、密钥、片段和字幕引用图，拒绝外部 URL、路径逃逸和未支持的动态变量。上限 512 资源、8 层、30 秒扫描；单清单 1 MiB、资源读取 8 MiB；每进程最多 16 个并行 HLS 读取，必须合理分段。

短时令牌绑定租户、账号/游客、剧集、媒体和资源路径；每次请求重查权益、地域、下架、账号和 provider。旧未固定版本引用图的私有 HLS 拒绝播放，需要重新登记或使用受控 MP4。此实现是受控 HLS，不是 FairPlay/Widevine DRM，不提供离线下载。

边缘先清除客户端同名头，再填入 x-nightflix-country（可信 ISO 两字母大写国家）、x-nightflix-geo-time（10 位 Unix 秒）和 x-nightflix-geo-signature（HMAC-SHA256 小写 hex）。签名原文用换行连接 timestamp、country、method、实际转发 Host、原始 URL（含查询串），末尾不加换行，允许时间偏差正负 30 秒。边缘与 API 的 Host/URL 必须一致。

## 广告、推送与域名

运行配置 admobJson 按 android / ios 分组，各自配置 rewardedEpisode、interstitial、appOpen、native。广告单元与该代理商正式包的 AdMob App ID 对应，不跨平台兜底。服务端激励 SSV 验签仍是“看广告解锁一集”的唯一发放依据。

UMP 需要时在个人中心提供广告隐私入口。切集插屏/回前台开屏需频控和预载满足，页面离开、后台、未就绪时降级跳过；广告暂停主播放器和配音。SDK 收入回调不具有财务信任。

推送使用独立代理商 FirebaseOptions（apiKey、appId、messagingSenderId、projectId、匹配的 androidPackageName/iosBundleId），后台配置本代理商 FCM/APNs 发送凭据。退出撤销本设备的推送绑定。深链只接受配置域名 HTTPS /dramas/UUID，仍由服务端权限决定能否播放。

## 本地 / CI 正式构建

运行 pnpm --filter @drama/api app:release /absolute/tenant-release.private.json /absolute/output-directory。不进行数据库迁移、上传或部署。

私有 JSON 包含 platform（android/ios）、androidApplicationId、iosBundleId、appName、apiOrigin（公开 HTTPS origin）、iconPath（绝对路径）和 release 对象：

- release.admobAppId：本代理商正式 ID，拒绝 Google 测试 ID。
- Android：release.androidSigningProperties，私有文件包含 applicationId、storeFile（绝对路径）、storePassword、keyAlias、keyPassword；拒绝 androiddebugkey 和跨租户 applicationId。
- iOS：release.iosTeamId、release.iosExportOptionsPlist；teamID 一致，完整 Xcode、有效 provisioning profile。
- 可选 release.deepLinkHost、release.googleIosClientId、release.firebaseOptions。deepLinkHost 与后台运行配置一致。
- Android 开深链需 release.androidLinkCertificateSha256 数组（冒号分隔 SHA256）；Google Play 发布使用 Play App Signing 证书指纹，不只是 upload key。
- 本地工具路径 APP_BUILD_TEMPLATE_ROOT、APP_BUILD_FLUTTER_BIN、APP_BUILD_PUB_CACHE；可选 APP_BUILD_GRADLE_USER_HOME。

输出 APK/IPA、SHA256 和对应 .well-known JSON。将其内容部署到代理商域名 /.well-known/assetlinks.json 或 /.well-known/apple-app-site-association，HTTPS 直接返回 application/json、无重定向；生成文件不会自动配置域名。远程只改资源/主题/文案/运营开关，不下发可执行代码。

## 官方依据

[Apple Server Library](https://github.com/apple/app-store-server-library-node)、[Google Play Orders](https://developers.google.com/android-publisher/api-ref/rest/v3/orders)、[AdMob Flutter 隐私](https://developers.google.com/admob/flutter/privacy)、[Android App Links](https://developer.android.com/training/app-links/configure-assetlinks)、[Apple Associated Domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)。外部能力最终以各代理商真实沙盒及真机测试为准。
