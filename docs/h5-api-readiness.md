# H5 第一版 Customer API 就绪度审计

审计日期：2026-08-23  
审计范围：当前仓库 `apps/api/src` 中已经存在并注册的 customer API、相关服务与响应模型。本文只记录已实现能力，不把后台接口、规划接口或前端可自行模拟的行为当成现有 API。

## 结论

当前 API 与 H5 已能支撑第一版真实业务：白标启动、公开内容浏览与搜索、OTP 注册、密码登录与重置、正片/独立试看媒体、进度/历史/收藏、积分与权益、Stripe Hosted Checkout、互动、通知、邀请、设备安全、法律文档/同意记录、数据导出与擦除申请。

先前的支付、试看和隐私三个代码阻断已解决；正式开放前仍必须完成真实商家配置与真机验收：Stripe live 密钥/Webhook、Resend/Twilio 投递、已发布的商家法律文档、独立试看短片、对象存储 CORS/Range/CDN 和 iOS/Android 真机支付及播放。

以下能力属于上线前条件或显著缺口，但若首版产品明确降级，可以不阻断整个 H5：

- OTP API 和真实 Resend/Twilio 投递链路已经存在，但每个商家必须先配置、测试并启用对应通道；未配置且未启用不安全万能码时，创建验证码会返回 `OTP_DELIVERY_UNAVAILABLE`。
- H5 只能使用站内通知，现有 push token API 只接受 `ios`/`android`，不支持 Web Push、VAPID 或浏览器 `PushSubscription`。
- 播放器只拿到短时效 MP4/QuickTime/WebM 签名 URL，没有 HLS/DASH、DRM 或独立清晰度；Range、CORS 和拖动播放依赖对象存储配置，需要真机预检。
- 用户端没有“邀请活动是否开启”的配置；邀请代码/绑定接口始终可调用，但只有商家启用分销且订单符合配置时才产生佣金。

## 全局调用约束

- 所有下述路径均以 `/api/v1` 为前缀。
- 所有 customer 请求都依赖已验证的商家域名解析 tenant；客户端不能通过 body/query 自选 `tenantId`。未知 Host、停用/过期商家、平台关站或商家关站会被拒绝。
- 文中“匿名”表示不需要 customer bearer token，**不表示可以绕过商家 Host 校验**。代码中的 `@PublicEndpoint()` 只是绕过后台 staff guard；许多标注为 PublicEndpoint 的 customer 路由仍在控制器内手动验证 customer access token。
- 登录后使用 `Authorization: Bearer atk_...`。access/refresh token 都是 opaque token；refresh token 通过 JSON body 传递，不是服务端 Cookie 会话。
- 创建订单、创建支付、积分解锁、邀请代码创建、邀请绑定、发表评论/弹幕/举报、撤销设备等写操作要求单一 `Idempotency-Key`；H5 必须为一次用户操作稳定复用同一个 key，不能每次重试重新生成。
- 客户站可用策略通常同时要求：tenant active、未过期、`platform_site_enabled=true`、`user_site_enabled=true`、账户 active。账户停用与密码找回有受控例外，不能依赖其它业务 API 在关站后继续工作。
- 支持的 locale 固定为 `zh-CN`、`zh-TW`、`en-US`、`fr-FR`、`ja-JP`、`ko-KR`。内容会按“请求 locale → 商家默认 locale → en-US → 任一现有翻译”回退，响应中的 `locale` 是实际命中的语言。

## 页面级就绪度

### 1. 启动页、白标与基础导航

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/bootstrap`；`GET /customer/assets/:mediaId/url`；`GET /customer/content/categories`；`GET /customer/content/tags` |
| 鉴权 | 匿名，但必须是已验证 tenant Host |
| 关键响应 | bootstrap 返回 `siteName`、`logoMediaAssetId`、`iconMediaAssetId`、`theme`、`defaultLocale`、`supportedLocales`、`onlineOnly: true` 和基础 capabilities；资产接口返回短时效 HTTPS 签名 URL；分类/标签返回本地化 `id/code/name/locale` |
| 可用结论 | 足够完成启动、主题、logo/icon、默认语言以及按分类/标签构造基础导航 |
| 缺口 | bootstrap 不提供运营导航树、Banner、首页模块、隐私/条款链接或版本。分类和标签最多返回 200 条，只有 `hasMore`，没有下一页参数；超过 200 条无法完整遍历 |
| 上线判断 | 基础白标可上线；复杂运营首页需前端固定布局或新增真实配置 API |

资产 URL 接口只允许返回当前站点的 logo/icon 或用户可见已发布短剧封面，不能把它当成任意 mediaId 的通用下载接口。播放器媒体必须走专用 playback URL。

### 2. 注册页

| 项目 | 现有能力 |
| --- | --- |
| API | `POST /customer/auth/otp/challenges`；`POST /customer/auth/otp/verify`；`POST /customer/auth/register` |
| 鉴权 | 匿名、tenant Host |
| 关键输入/响应 | OTP 创建支持 `email`/`phone` 与 `verify_email`/`verify_phone`，返回 `challengeId`、`deliveryRequired`、`expiresAt`；验证成功返回短时效 `verificationToken`；注册提交 `username/password` 以及可选 email/phone 和对应 verification token，返回 `accountId/username` |
| 可用结论 | 用户名密码注册、邮箱或手机号验证注册可实现 |
| 缺口 | 注册成功不自动登录，H5 需要再调用 login。没有用户名/邮箱/手机号可用性预检，只能提交后处理冲突 |
| 上线判断 | 当商家已发布隐私政策和服务条款、并启用真实 OTP 通道后可用；H5 会精确提交 document id/version 同意记录 |

`developmentCode` 只可能在显式开发配置下出现，H5 不能依赖它。万能验证码也不应成为 H5 功能或开关。

### 3. 登录、刷新与退出

| 项目 | 现有能力 |
| --- | --- |
| API | `POST /customer/auth/login`；`POST /customer/auth/refresh`；`POST /customer/auth/logout` |
| 鉴权 | 登录/刷新匿名、tenant Host；退出按 refresh token 注销会话 |
| 关键输入/响应 | login 使用 `identifier/password/devicePlatform/deviceLabel?/deviceToken?`，H5 可传 `devicePlatform: "h5"`；返回 access/refresh token、各自过期时间、`principal` 与可能的新 `deviceToken` |
| 可用结论 | 密码登录与 token 刷新闭环可用；每账号最多 3 台设备，超限时服务端踢掉最早设备 |
| 缺口 | OTP `purpose: "login"` 验证后只返回 `verified: true`，没有登录 grant/session；login 又只接受密码。因此当前**不能做验证码免密登录**。服务端不使用 HttpOnly Cookie，H5 必须自行设计内存/安全持久化策略，并避免把 refresh token 暴露给第三方脚本 |
| 上线判断 | 密码登录可用；UI 不得出现“验证码登录”入口 |

### 4. 忘记密码

| 项目 | 现有能力 |
| --- | --- |
| API | `POST /customer/auth/otp/challenges`（`purpose=password_reset`）；`POST /customer/auth/otp/verify`；`POST /customer/auth/password/reset` |
| 鉴权 | 匿名、tenant Host |
| 关键响应 | OTP 验证得到 `verificationToken`；reset 返回 `reset: true`、`requiresReauthentication: true` |
| 可用结论 | 邮箱或手机号找回密码可实现，成功后会撤销全部旧会话/设备并要求重新登录 |
| 缺口 | 依赖已验证且绑定的联系方式及已启用投递配置；H5 错误文案要避免据响应泄露账号是否存在 |
| 上线判断 | 配置真实邮件/短信后可用 |

### 5. 首页、内容列表、搜索与筛选

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/content/dramas?page&pageSize&locale&q&category&tag`；分类/标签 API；封面资产 URL API |
| 鉴权 | 匿名、tenant Host |
| 关键响应 | 分页返回 `items/page/pageSize/total`；每项含 `id/code/title/summary/locale/coverMediaId?/totalEpisodes/pointsAmount?` |
| 可用结论 | 支持关键词、分类、标签、语言和受控分页。关键词查询覆盖 code、所有语言标题/简介/搜索关键词，并安全转义 `%`/`_`；category/tag 可传 UUID 或 code |
| 缺口 | 只有固定最新顺序，没有推荐、排行榜、精选、热度、观看量或可选排序。一次请求只接受单个 category 与单个 tag。没有运营 Banner/频道接口 |
| 上线判断 | 简洁“最新 + 搜索 + 单分类/标签”首页可上线；不要做假排行榜或假推荐 |

### 6. 短剧详情与选集

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/content/dramas/:dramaId?locale=...`；封面资产 URL；播放 access API |
| 鉴权 | 详情匿名、tenant Host；播放 access 需登录 |
| 关键响应 | 短剧基础信息加按 `episodeNo` 排序的 `episodes[]`；每集含 `id/episodeNo/title/locale/durationSeconds/previewSeconds/mediaAssetId/pointsAmount?` |
| 可用结论 | API 一次返回完整有序选集，因此 H5 可在客户端实现选集、上一集/下一集和自动连播，无需虚构“下一集”接口；语言切换通过带不同 locale 重取详情实现 |
| 缺口 | 没有单独的 next-episode API，超长剧集也没有 episodes 分页。响应只给实际回退语言，不返回全部翻译；已配置时会返回独立 `previewMediaAssetId` |
| 上线判断 | 普通选集与自动连播可用；超长剧集需评估详情响应体大小 |

### 7. 播放器

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/playback/episodes/:episodeId/access`；`GET /customer/playback/episodes/:episodeId/url?expiresInSeconds=...`；`PUT /customer/playback/progress` |
| 鉴权 | customer bearer + tenant Host |
| 关键响应 | access 返回 `full/preview/locked`、剧/集/media ID、时长和试看秒数；full URL 返回短时效 `url/expiresAt/offlineSupported:false`；progress 返回进度、完成状态、更新时间与 version |
| 可用结论 | 已有完整权限判定、短时效播放地址和进度同步。倍速、全屏、横竖屏、选集和自动连播属于 H5 播放器客户端能力，现有 API 不阻止实现 |
| 缺口 | 只有短时效对象 URL，没有 HLS/DASH、清晰度列表、字幕、音轨或 DRM；`expiresInSeconds` 仅允许 120–300 秒，长视频需续签；明确 `offlineSupported:false`。未配置独立试看片时仍安全返回 `PREVIEW_PLAYBACK_ASSET_UNAVAILABLE` |
| 上线判断 | full 与已配置独立短片的 preview 均可用；上线前必须验证对象存储 CORS、Range、拖动、iOS Safari 格式兼容与签名续期 |

进度写入会校验用户当前可观看范围：preview 不能写超出试看秒数，也不能标记 completed。H5 应节流上报，并在暂停、切集、退出和 ended 时补一次最终上报。

### 8. 收藏与观看历史

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/playback/favorites`；`POST/DELETE /customer/playback/favorites/:dramaId`；`GET /customer/playback/history` |
| 鉴权 | customer bearer + tenant Host |
| 关键响应 | 收藏分页项含 `dramaId/code/title?/coverFileId?/createdAt`；历史分页项含剧/集 ID、位置、completed、updatedAt、version |
| 可用结论 | 收藏增删、收藏列表和跨设备续播进度可实现 |
| 缺口 | history 不带剧名、集标题或封面，富历史页面要额外拉剧详情或维护安全缓存。favorites 不接收 locale，标题选择固定偏向 en-US fallback，多语言展示不完整。两者使用 page/total 或固定分页而非统一 cursor |
| 上线判断 | 功能可用；首版需接受额外详情请求和收藏标题语言限制 |

### 9. 商城与报价

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/commerce/catalog?locale&currency`；`POST /customer/commerce/quote` |
| 鉴权 | catalog 匿名；quote 需 customer bearer；都要求 tenant Host |
| 关键响应 | catalog 返回会员套餐、积分充值包及其多币种价格；quote 接受 `productType/productId/currency/locale`，返回服务端确定的 product 与 `totalMinor`，拒绝客户端提交金额 |
| 可用结论 | 会员套餐和积分充值商品发现、按币种展示及下单前重报价可实现。金额必须始终按 minor unit 和币种展示，客户端不能修改 |
| 缺口 | catalog 最多各返回 100 个套餐/充值包，只有 `HasMore`，没有下一页。没有公开的单剧/单集法币价格目录；详情只暴露积分价格。H5 虽可拿剧/集 UUID 调 quote 探测所选币种价格，但不能预先知道哪些币种可售 |
| 上线判断 | 展示商城目录可用；单剧/单集法币购买体验存在商品发现缺口 |

### 10. 下单、支付与支付结果

| 项目 | 现有能力 |
| --- | --- |
| API | `POST /customer/commerce/orders`；`GET /customer/commerce/orders`；`GET /customer/commerce/orders/:orderId`；`POST /customer/commerce/orders/:orderId/payments`；`GET /customer/commerce/payments/:attemptId` |
| 鉴权 | customer bearer + tenant Host；创建订单/支付要求 Idempotency-Key |
| 关键响应 | 订单返回 `id/orderNo/orderType/status/currency/totalMinor/locale/createdAt/expiresAt/item`；Stripe attempt 返回类型化 `checkoutAction` (`type=redirect`、HTTPS URL、expiresAt) |
| 可用结论 | 服务端报价→下单→创建 Stripe Hosted Checkout→外部跳转→回跳后轮询 attempt/order 已闭环；H5 只接受 `checkout.stripe.com` 的安全 HTTPS action，不采信回跳 `session_id` |
| 缺口 | 没有 customer 主动取消订单接口；当前真实渠道仅 Stripe Hosted Checkout，商家必须配置、测试、启用密钥和 Webhook。原生 App 的数字内容支付还需按上架地区接 Apple/Google 商店支付或适用的允许方案 |
| 上线判断 | H5 支付代码可用；正式收款前必须用每个收款账号的 live 凭据做真实小额支付、Webhook、退款和对账演练 |

轮询应以服务端 attempt/order 状态为准，并设置退避、超时及页面恢复后的续查；不能因浏览器回跳参数显示“成功”就发放权益。

### 11. 积分钱包、积分解锁、会员与权益

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/wallet/points`；`GET /customer/wallet/points/ledger`；`POST /customer/commerce/point-unlocks/:targetType/:targetId`；`GET /customer/entitlements?status&locale&cursor&pageSize` |
| 鉴权 | customer bearer + tenant Host；解锁要求 Idempotency-Key |
| 关键响应 | 钱包余额和流水中的积分使用 decimal string；解锁响应含 `alreadyOwned/pointsSpent/balanceAfter/entitlementId/targetType/targetId/dramaId`；权益包含 `membership/drama/episode`、起止时间、状态和本地化标题 |
| 可用结论 | 积分余额、流水、整剧/单集解锁、会员/内容权益列表可实现。解锁金额由服务端配置决定，body 不接受客户端 points/amount |
| 缺口 | 没有单独的“当前会员摘要”、自动续费管理、取消订阅或续费设置接口；现有会员是期限权益，H5 应从 active entitlements 推导展示。解锁后需要重拉 wallet、entitlements 和 episode access |
| 上线判断 | 非订阅制会员/权益与积分解锁可用；不要展示自动续费/取消订阅能力 |

### 12. 评论、弹幕与举报

| 项目 | 现有能力 |
| --- | --- |
| API | `GET/POST /customer/interactions/comments`；`DELETE /customer/interactions/comments/:commentId`；`GET/POST /customer/interactions/bullet-comments`；`DELETE /customer/interactions/bullet-comments/:bulletCommentId`；`POST /customer/interactions/reports` |
| 鉴权 | 全部要求 customer bearer + tenant Host；写操作要求 Idempotency-Key |
| 关键响应 | 评论支持 drama、可选 episode、单层 parent、纯文本 body 和 moderation status；弹幕含 `positionMs`；举报支持 comment/bullet_comment 和固定 reasonCategory |
| 可用结论 | 登录用户评论、回复、弹幕、删除本人内容及举报闭环可用；敏感词命中后内容会进入 pending，不应在客户端伪装为已公开 |
| 缺口 | 未登录用户也不能读取评论/弹幕。列表返回 page/pageSize 但没有 total/hasMore，客户端只能以返回条数少于 pageSize 判断末页。回复模型只允许一层 parent，没有点赞、排序或评论详情接口 |
| 上线判断 | 登录后社区功能可用；若产品要求游客可看评论，需要新增受控匿名读能力 |

### 13. 通知收件箱与偏好

| 项目 | 现有能力 |
| --- | --- |
| API | `GET/PUT /customer/notifications/preferences`；`GET /customer/notifications/inbox`；`POST /customer/notifications/inbox/:messageId/read`；原生端另有 `POST/DELETE /customer/notifications/push-tokens...` |
| 鉴权 | customer bearer + tenant Host |
| 关键响应 | 偏好含 `preferredLocale`、营销站内/推送开关，事务通知固定开启；收件箱含 category、locale、title、body、可选 deepLink、read 状态与时间 |
| 可用结论 | H5 站内消息列表、已读和偏好设置可实现 |
| 缺口 | inbox 没有 total/hasMore/unreadCount，也没有全部已读。push token 只接受 `ios`/`android` 且必须匹配同平台 active device；H5/web device 不符合。没有 Web Push subscription/VAPID/service worker API |
| 上线判断 | H5 站内通知可用；**浏览器推送不可用**。H5 UI 不应诱导开启一个实际上不能注册浏览器 token 的推送能力，可将营销 push 设置标注为原生 App 偏好或暂不展示 |

### 14. 邀请与一级分销用户页

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/referrals/me`；`POST /customer/referrals/invite-code`；`POST /customer/referrals/bind`；`GET /customer/referrals/ledger?page&pageSize` |
| 鉴权 | customer bearer + tenant Host；创建代码/绑定要求 Idempotency-Key |
| 关键响应 | summary 返回邀请码、已绑定邀请人和按币种 pending/available/withdrawn 余额；邀请码为 10 位受控字符；ledger 返回佣金 bucket/type/currency/deltaMinor/commissionId/createdAt |
| 可用结论 | 生成/展示邀请码、绑定一次邀请关系、余额和流水页面可实现；防自邀且绑定后不能换邀请人 |
| 缺口 | customer API 不返回商家的分销 `enabled/commissionBps/applicableOrderTypes/settlementDays`，无法可靠决定是否展示活动或说明规则。即使可创建/绑定，只有后台配置启用且订单符合规则时才产生佣金。没有 customer 佣金提现接口 |
| 上线判断 | 可做“邀请码/我的应付佣金”简版页；活动规则与开关缺失时不应在 H5 承诺固定比例或可提现 |

### 15. 我的账号、设备与安全

| 项目 | 现有能力 |
| --- | --- |
| API | `GET /customer/account/me`；`GET /customer/account/devices`；`POST /customer/account/devices/:deviceId/revoke`；`POST /customer/account/password/change`；`GET /customer/privacy/consents`；`POST /customer/privacy/export`；`POST /customer/privacy/erasure-requests` |
| 鉴权 | customer bearer + tenant Host；撤销设备要求 Idempotency-Key |
| 关键响应 | me 只返回 username 和邮箱/手机号的 masked+verified；设备列表返回当前标识、label、lastSeenAt、platform、status；改密会撤销其它会话；停用返回 `disabled: true` 并撤销全部 session/device/push token |
| 可用结论 | 安全摘要、最多 3 台设备管理、踢设备、改密、停用账户可实现 |
| 缺口 | 没有修改 username、绑定/更换邮箱手机号、查看完整联系方式或独立 session 列表。擦除为异步请求，依法保留的财务/安全事实只做去标识并保留到 retention 到期；第三方渠道数据另行跟进 |
| 上线判断 | 设备/密码安全、密码确认的分页导出与账号擦除申请均可用；页面不宣称“所有数据立即物理删除” |

## 重点能力核对

| 重点问题 | 审计结果 |
| --- | --- |
| 播放器选集 | 可用。短剧详情返回有序完整 episodes |
| 自动连播 | 可由 H5 基于 episodes 顺序实现；服务端没有 next API，也不需要伪造 |
| 倍速/横竖屏/全屏 | 客户端播放器能力；API 不限制，但 iOS Safari 需真机验证 |
| 试看 | 可用。必须为集数单独配置已验证的 `previewMediaAssetId`，未配置时绝不回退正片 |
| 搜索筛选 | 支持 q、单 category、单 tag、locale、page/pageSize；无排序/推荐/排行 |
| 多语言切换 | 六种 locale 可重拉内容；存在默认语言/en-US/任一翻译回退；不是一次返回全翻译 |
| 支付回跳 | Stripe Hosted Checkout 已定义；H5 校验固定 HTTPS host，回跳后只信服务端 attempt/order 状态 |
| 支付轮询 | `GET /customer/commerce/payments/:attemptId` 可用；最终权益仍应以服务端 order/entitlement 为准 |
| 隐私条款 | 商家版本化发布、安全 Markdown 展示和注册精确同意留痕已闭环 |
| 账号删除 | 已有密码确认的擦除请求和可恢复 worker；依法保留事实去标识，不伪称立即全部物理删除 |
| H5 推送 token | 不适用。现接口只支持 APNs/FCM 的 ios/android token，不支持 Web Push |
| 资产签名 URL | 封面/品牌资源使用公开受控资产 URL；视频使用登录后 playback URL；都不是永久 URL |

## 上线前处置优先级

### P0：发布前必须完成的环境验收

1. 每个收款模式使用真实 Stripe live 配置完成小额支付、Webhook 重放、退款和对账；没有启用配置时保持安全不可付。
2. 为要展示试看的集数上传独立短片，验证时长/格式、CORS、Range、CDN 回源与签名续期；未配置集数不展示可播试看。
3. 每个商家发布当前隐私政策和服务条款，再开放注册；对数据导出和擦除 worker 做备份/恢复与保留期演练。

### P1：首版可降级，但需在范围中写清楚

1. 每个商家完成 Resend/Twilio 配置、真实投递测试、启用与失败告警；否则注册验证和找回密码会不可用。
2. 决定 H5 是否只做站内消息。若承诺浏览器推送，需要新增 Web Push 订阅与注销接口，而不是复用原生 push token API。
3. 完成真实对象存储的浏览器 CORS、Range、签名续期、iOS Safari 格式与 CDN 回源测试。
4. 给 customer referral 增加安全只读活动配置，或者首版不展示佣金比例/活动开关/提现承诺。
5. 若需要游客社区、首页推荐/排行、富观看历史、单剧/单集法币价格目录，分别补真实读模型；首版不要用假数据填充。

## 建议的第一版可交付边界

当真实渠道与商家内容完成上述 P0 验收后，第一版 H5 可交付边界为：

- 白标启动、语言切换、最新内容、搜索/分类/标签、详情和选集；
- 密码注册登录、真实邮件/短信验证、密码重置；
- 已授权内容 full 播放、进度、收藏和简版历史；
- 积分钱包、已有积分解锁、会员/内容权益；
- 登录后评论、弹幕、举报；
- 站内收件箱与偏好；
- 邀请码、绑定、佣金余额/流水的只读展示；
- 账号摘要、改密、设备撤销、法律文档/同意历史、数据导出和擦除申请；
- Stripe Hosted Checkout 支付和已配置独立短片的试看。

此边界仍不包含：Web Push、离线下载、DRM/多码率 HLS、自动续费、假推荐/排行，以及未完成商店支付合规的全球 iOS/Android 数字内容收款。

## 主要代码依据

- customer auth/account：`apps/api/src/customer-auth/customer-authentication.controller.ts`、`customer-account.controller.ts`、`customer-authentication.service.ts`、`customer-otp.service.ts`
- OTP 投递：`apps/api/src/communications/otp-delivery.service.ts`、`communication-provider.adapter.ts`
- bootstrap/store/assets：`apps/api/src/customer-store/customer-store.controller.ts`、`customer-store.service.ts`、`customer-asset.controller.ts`、`customer-asset.service.ts`
- 内容目录：`apps/api/src/customer-content/customer-content-catalog.controller.ts`、`customer-content-catalog.service.ts`、`customer-content-catalog.types.ts`
- 播放：`apps/api/src/playback/playback.controller.ts`、`customer-playback-access.service.ts`、`customer-playback-url.service.ts`、`playback.service.ts`
- 商城/订单/支付/积分：`apps/api/src/commerce/commerce.controller.ts`、`commerce-order.service.ts`、`payment.controller.ts`、`payment-core.service.ts`、`stripe-payment.adapter.ts`、`point-unlock.controller.ts`
- 法律/隐私：`apps/api/src/privacy/legal-document.controller.ts`、`customer-privacy.controller.ts`、`privacy-erasure-worker.service.ts`
- 互动：`apps/api/src/interactions/interaction.controller.ts`、`interaction.service.ts`
- 通知：`apps/api/src/notifications/notification.controller.ts`、`customer-notification.service.ts`、`notification.types.ts`
- 邀请：`apps/api/src/referrals/referral.controller.ts`、`referral.service.ts`
