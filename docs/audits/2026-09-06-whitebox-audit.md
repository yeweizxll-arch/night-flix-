# Night Flix 白盒审计 — 2026-09-06

> 本文件是 d387db1 的历史审计快照，下列“当前版本”均指该基线。修复后的现状与验证边界请看同目录的 2026-09-06-remediation-status.md；不要将本报告的缺陷存在性测试当成修复验收。

## 结论

**当前版本不具备正式上线条件。** 已通过可执行测试或生产构建浏览器运行，确认后台白屏、公共剧上架/播放失败、公共剧金币解锁失败、交易未进入分成账本等核心问题。不是仅缺少正式账号或密钥。

本报告只审计 Night Flix 独立工程，没有操作闪创生产系统。没有修改业务代码、数据库迁移或依赖版本；只新增审计复现测试与本报告，未提交、推送、部署。

- 工程：`/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas`
- 基线提交：`d387db1a1ec09247f59401554dbd5a0cfb0acff8`
- 分支：`feature/player-rewarded-interactions-20260901`
- 开始时工作区干净，674 个已跟踪文件。
- 审计方法：目录/模块/路由清点，关键调用链与 SQL/RLS 对照，全量已有自动化测试，新增缺陷复现测试，双后台生产构建浏览器冒烟，生产依赖安全扫描。
- 这不是每条执行路径的数学证明，也不是生产环境渗透测试；不能据此承诺未列出的地方绝对没有问题。

证据标记：**R** 已运行复现；**S** 源码调用链确认；**C** 特定环境/输入下成立、未用真实外部服务验证。P1 表示相关正式业务上线前必须处理，P2 表示确定存在的功能/稳定性问题。

## 测试结果与边界

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 原有 API 测试 | 115 文件，770 通过，1 跳过 | 跳过的是原生构建集成项 |
| 原有管理后台测试 | 15 文件，48 通过 | 不能代替生产 JS 在浏览器执行 |
| 原有 H5 测试 | 7 文件，24 通过 | H5 是兼容/参考端，不是正式 Flutter 客户端 |
| 原有 Capacitor 包测试 | 1 文件，8 通过 | 旧移动端配置测试 |
| 原有 Flutter 测试 | 10 通过 | 多数使用本地 demo 仓库 |
| 根目录 `pnpm typecheck` | 通过 | 类型正确不代表业务贯通 |
| 根目录 `pnpm build` | 通过，有循环 chunk 警告 | 随后确认双后台均白屏 |
| 独立 tenant 后台生产构建 | 通过，同样有循环 chunk 警告 | 随后确认白屏 |
| Flutter analyze | 通过 | 包括最终新增审计测试 |
| 新增 API 白盒复现 | 5 通过 | 断言当前缺陷确实存在，不是正常业务验收通过 |
| 新增 Flutter 白盒复现 | 6 通过 | 同上；包括 HTTP 模拟、持久化与 widget 测试 |
| 生产依赖扫描 | 10 条告警：8 high、2 moderate | 6 个唯一 advisory；部分 high 因两个依赖版本重复计数 |

原有测试合计 860 项通过、1 项跳过；新增 11 个“缺陷存在性”断言通过。不得把二者相加后宣传为上线验收通过。

数据库复现使用全套 31 个迁移文件，在 PGlite 中执行；与现有测试一致，移除了 citext/pgcrypto 扩展声明并将 citext 替换为 text。关键新增测试显式创建 `NOSUPERUSER NOBYPASSRLS` 非表所有者角色并 `SET LOCAL ROLE`，不再仅设置 tenant GUC。尚未在独立 PostgreSQL 16、真实连接池与多进程并发环境复验。

当前机器没有可直接使用的 `docker`、`psql` 命令；`xcode-select -p` 为 CommandLineTools。没有做 Docker 镜像实际运行、iOS 真机签名安装、Android 新包真机长时间播放、Apple/Google 沙盒交易、真实 AdMob 回调或私有 HLS/CDN 压测。

## 核心阻断

### NF-01 · P1 / R — 总部、代理商后台正式构建均白屏

`manualChunks` 将互相引用的 antd、rc-component 和 icons 拆成循环 chunk。构建退出码为 0，但首次加载模块时就抛异常，React 尚未渲染登录页。

位置：[管理后台构建配置](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/admin/vite.config.ts:21)。

本地浏览器确认：

```text
总部 http://127.0.0.1:4186/
ReferenceError: Cannot access 'ou' before initialization
vendor-rc-Dg8wmgZm.js:31:31159

代理 http://127.0.0.1:4187/
ReferenceError: Cannot access 'ou' before initialization
vendor-rc-K5qC0Kd1.js:31:31158
```

两个页面的可访问性树均只剩空的 WebArea。修复验收必须用生产制品在真实浏览器打开总部和代理后台，不能只跑 Vite build 或开发模式。

### NF-02 · P1 / R — 正式数据库角色下，公共剧无法上架，也无法播放

代理商上架在租户事务里对总部公共 `dramas` 执行 `FOR UPDATE`，但该角色对公共剧只有 SELECT，没有 UPDATE 行权限。该查询拿不到目标，返回 `Public drama is unavailable`。播放授权又对公共 episode/drama/media 执行 `FOR SHARE`，同样触发行锁所需的 UPDATE RLS 检查，返回 `Published episode is unavailable`。

证据：[上架事务](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/public-drama-pool/public-drama-pool.service.ts:175)、[RLS 更新策略](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/database/migrations/0008_content_rls.sql:277)、[播放查询](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/playback/customer-playback-access.service.ts:95)。

WB-01：受限角色审核成功、普通 SELECT 可见公共剧，但上架失败。WB-03：即使预置 published 状态，受限角色播放失败；同一份数据换成现有测试所用 owner 上下文则成功。这说明问题是权限与业务实现冲突，不是缺少数据。

不能通过把正式数据库账号改成超级用户解决；[生产安全检查](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/database/database.service.ts:126)明确禁止这种权限。

### NF-03 · P1 / R — 新公共剧池与金币解锁仍使用两套授权逻辑

上架写 `tenant_public_drama_publications`，但金币解锁公共剧时只认旧 `content_licenses` + `content_license_items`。只经过新公共剧池审核上架，没有旧授权的剧，会返回 `Point-unlockable content not found`；单集、整剧都经过这个检查。

位置：[金币解锁授权检查](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/commerce/point-unlock.service.ts:260)。WB-04 已复现。即使修好 NF-02，这个问题仍独立存在。

### NF-04 · P1 / R + S — 实际消费未接入三方分成账本

`RevenueShareService.record()` 有实现，但没有生产交易/广告处理方调用它；`reverse()` 同样未接入退款流程。内容分成表的唯一写入代码就在该方法，数据库也没有把实际交易自动转为该账本的触发器。

WB-05 配置三方分成后，补齐旧授权，调用真实 PointUnlockService 完成一次 100 金币消费：余额 1000 → 900、权益创建成功，但 `content_revenue_ledger` 仍为 0 条。现有“分成测试”是手动调用 record，并未验证业务接线。

证据：[消费事务](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/commerce/point-unlock.service.ts:132)、[分成写入](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/public-drama-pool/revenue-share.service.ts:119)、[退款入口内部方法](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/public-drama-pool/revenue-share.service.ts:201)。

后果：按正常 App 业务产生的数据不能形成约定的总部/代理商/创作者月账。原有佣金/提现模块不能替代这套内容分成。修复需补收入来源、金币折算/成本来源、幂等落账和退款调整，不是补一张报表。

### NF-05 · P1 / S — 原生购买不是配置密钥后就能启用

bootstrap 固定返回 `inAppPurchases:false` 和 `nativePurchaseReceiptVerification:false`。Flutter 因而总是拒绝打开购买。没有完整的 Apple/Google 回执校验、续订/退款回调以及客户端 purchaseStream、完成交易、恢复购买链路；隐藏分支对所有产品统一调用 `buyConsumable`。

证据：[固定能力开关](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/customer-store/customer-store.service.ts:133)、[客户端购买入口](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:2030)。

关闭开关本身是必要保护，不能直接改成 true 当作修复。现状的后果是不能按计划在原生 App 充值/订阅；本轮没有证据表明用户已经发生真实扣款损失。

### NF-06 · P1 / S — 正式 App 新用户缺少注册入口，免费播放也要求现有账号

Flutter 只有邮箱/密码登录，没有邮箱注册、验证、找回密码流程，Google/Apple 登录服务端也固定关闭。正式模式免费/试看播放同样先要求 session；后端播放器接口也显式 authenticateAccess。因此没有预先建好账号的新用户不能完成“进入 App → 观看 → 自助注册/购买”的闭环。

证据：[登录请求](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/drama_repository.dart:280)、[播放登录门槛](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/drama_repository.dart:422)、[后端 principal](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/playback/playback.controller.ts:146)。后端已经有注册接口，不等于 Flutter 已接好。

### NF-07 · P1 / R + S — 登录默认 15 分钟后，受保护操作持续 401

服务端默认 access token 有效期为 15 分钟。Flutter 收到 refreshToken 后不保存恢复、不自动续期，401 直接抛出。界面 session 仍非空，用户看起来已登录，播放/解锁/评论等新请求却会失败。退出登录也没有调用服务端撤销接口。

证据：[15 分钟策略](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/auth/session-expiry.ts:12)、[客户端 HTTP 处理](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/drama_repository.dart:310)。WB-F03 用有效 refreshToken 和过期 accessToken 模拟 HTTP：连续两次播放均 401，零次 refresh 请求。没有为此真的等待 15 分钟；时间门槛来自服务端策略。

### NF-08 · P1 / R — 语言配置与 API 不一致，可造成持续启动失败

后台运行配置接受 es-ES 等语言，内容 API 却只接受 zh-CN、zh-TW、en-US、fr-FR、ja-JP、ko-KR。选 es-ES 等集合外语言时请求 400。Flutter 在请求前已持久化语言，又没有失败回退；下次启动继续读取同一语言，仍然加载失败，重试不能自动修复。

证据：[API 语言集合](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/customer-content/customer-content-catalog.types.ts:1)、[API 验证](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/customer-content/customer-content-catalog.service.ts:472)、[持久化时机](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/drama_repository.dart:390)。WB-02、WB-F01 分别复现两端断点。

### NF-09 · P1 / R — 只配置整剧金币价格时，锁集不出现解锁入口

API 拒绝未购买用户播放并返回 403；客户端只把异常写入 playbackError，不把返回的 locked 访问状态转成 Episode 状态。若只设置整剧价格、单集 pointsAmount 为空且没有试看，`episode.locked` 为 false，所以只出现“重试播放”，金币解锁/广告解锁卡片都不出现。

证据：[Episode.locked](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/models.dart:144)、[错误处理](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:427)、[解锁卡片条件](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:800)。WB-F06 已用整剧 300 金币、无单集价格的场景复现。

### NF-10 · P1 / S + C — 原存储链接和私有加密 HLS 尚未完成适配

播放签名查询强制 `media.source_url IS NULL` 且具有系统 S3 provider/object_key；现有 source_url 直接导入的数据不能播放。平台添加剧集视频也要求受管 S3 资产。需要明确把闪创原存储纳入受控读取/签名流程，不能只把旧地址填进去。

HLS MIME 虽列为允许，实际只给一个对象做 GetObject 签名，没有清单重写、分片授权、密钥授权或 CDN 多文件访问授权。**当 m3u8 引用未单独授权的私有相对分片/密钥时，只签 m3u8 不足以播放。** 不声称所有 HLS 都失败：预先包含有效分片签名或公开分片的清单属于不同条件。

证据：[播放资产查询](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/playback/customer-playback-url.service.ts:110)、[单对象签名](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/storage/s3-compatible.adapter.ts:103)、[平台视频约束](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/platform-content-library/platform-content-library.service.ts:1360)。AWS 官方也区分单文件签名和 HLS 多文件受控访问：[AWS 文档](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-choosing-signed-urls-cookies.html)。本轮未调用真实存储验证，不将其标为 R。

### NF-11 · P1 / S — 国家限制只存储，没有进入播放/售卖授权

公共剧 allowedCountries/blockedCountries 可以保存，App bootstrap 也下发地区配置；但内容目录、金币解锁、播放授权没有读取这些限制，也没有将可信国家信息传入授权判断。现有租户解析是 Host→tenant，不是国家限制。

证据：[保存国家限制](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/public-drama-pool/public-drama-pool.service.ts:200)、[播放授权](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/playback/customer-playback-access.service.ts:52)、[内容控制器](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/customer-content/customer-content-catalog.controller.ts:26)。

后果是在目前服务代码下“限定国家”不生效。没有发现已配置的外部地理阻断网关；不能把外部尚未验证的防护当成现有功能。

## 其他确定问题与未完成功能

### NF-12 · P2 / R — 切换账号会保留上一账号的本地记录

favorites/following/history 使用全局 SharedPreferences key，interactions 也不按账号区分。logout 只清空 session，login 不清理这些数据。WB-F02：A 收藏、追剧、观看、点赞后退出；B 登录仍可见 A 的状态，重启仍保留观看记录。这里确认的是**同一安装内的账号数据混用**，不是已证明服务端跨租户越权。

位置：[AppController 初始化与退出](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/drama_repository.dart:363)。

### NF-13 · P2 / R + S — 剧场分类、剧目卡片及片库/搜索结果没有有效跳转

TheaterScreen 的分类 `onSelected: (_) {}` 为空，剧目仅渲染 Column；片库和搜索共用的 _DramaList 仅渲染 Row，没有点击打开剧目的动作。WB-F05 真实 widget 点击 Romance 后仍未选中，点击剧名仍停在剧场。用户不能从这些入口选择想看的剧。

位置：[剧场](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:1263)、[片库/搜索列表](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:1605)。

### NF-14 · P2 / S，部分 R — 播放器激活状态没有跟随页面生命周期

AppShell 使用 IndexedStack，切到“我的”等标签不会把 FeedScreen 的当前 DramaPage.active 改为 false；WB-F06 验证切到“我的”后播放器 widget 仍 active。_play 的异步签名/初始化完成后直接 play，没有重新核对当前剧集、active 或操作序号；快速滑动期间存在旧请求回来启动非当前播放器的路径。didUpdateWidget 切离页面只暂停主视频，不显式暂停 dubbingAudio。

位置：[页面栈](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:112)、[激活切换](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:314)、[异步启动](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:422)。没有在本轮声称已通过真机录音复现后台串音；需要补平台播放器假实现和真机快速滑动/前后台压力测试。

### NF-15 · P2 / S — 断点续播与账号观看记录未接入

客户端没有调用播放进度读写接口。history 只存 dramaId；每次重新加载详情默认第一集，resumeAt 只用于当前组件的临时操作。重启不能恢复集号/秒数，首屏观看甚至不一定触发只挂在 onPageChanged 上的历史记录。

位置：[详情初始化](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:320)、[本地历史](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/drama_repository.dart:566)。

### NF-16 · P2 / R — 显示 15 种语言不等于完成 15 种本地化

AppStrings 仅区分 languageCode 是否为 zh，其他语言一律返回英文。zh-TW 也使用同一个简体中文词典；部分购买/错误弹窗仍直接写英文。WB-F04 确认系统 locale 为 es，导航仍显示 For You/Library。

位置：[本地化实现](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app_strings.dart:102)。与 NF-08 区别：NF-08 是请求失败，NF-16 是即使请求成功也没有对应翻译。

### NF-17 · P1 / S — 代理商正式签名/构建仍是测试能力

Android release 构建明确使用 debug signingConfig；后台构建器仅有 android_debug 和 iOS simulator debug/no-codesign 路径。AndroidManifest、Info.plist 的 AdMob App ID 都固定为 Google 测试值；注释写“发布自动替换”，但当前构建器并没有替换该字段的流程。

默认 API_BASE_URL 为空时应用静默进入 demoMode，也没有 release 模式强制要求真实接口地址的门禁。后台调试构建会传 API_BASE_URL，但手工无参数 release 仍会构建出 demo。

证据：[Android 签名](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/android/app/build.gradle.kts:32)、[构建器](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/app-builds/native-app-builder.ts:125)、[广告 App ID](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/android/app/src/main/AndroidManifest.xml:7)、[入口](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/main.dart:9)。

测试包仍可用于演示；这些证据不能支持“多个代理商独立正式签名、商店发布已完成”。本轮没有替用户创建/导入正式密钥。

### NF-18 · P2 / S — 广告、推送、Deep Link 的首版范围未全部实现

Flutter 代码只看到 RewardedAd 接入，没有开屏、原生、插屏或广告收入 paid-event 落账链路。firebase 依赖存在，但客户端没有 FirebaseMessaging 初始化、设备 token 上报与消息打开处理。分享可以生成链接，但 Android 没有对应 VIEW/BROWSABLE intent-filter，iOS 也未见相应 Universal Link 接入。

位置：[激励广告入口](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/src/app.dart:928)、[App 初始化](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/lib/main.dart:7)、[Android Manifest](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/android/app/src/main/AndroidManifest.xml:31)。有后台配置页/SDK 依赖不等于端到端能力已经完成。

### NF-19 · 待专项处置 / 扫描确认 — 生产依赖存在已公开安全告警

当前安装/锁文件：fastify 5.11.3、fast-uri 3.1.5 和 4.1.2。`pnpm audit --prod` 返回 8 high、2 moderate，按 advisory 去重为 6 个，不是 10 个独立漏洞。

fast-uri 官方列出的修复版为 3.1.6/4.1.3：[IPv6 解析问题公告](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc)。fastify 的数字型 trustProxy 公告对应当前 compose 的 TRUST_PROXY=1；官方说明其利用前提包含攻击者能绕过代理直达源站，修复版 5.12.1 不再支持数字型信任代理配置：[Fastify 官方公告](https://github.com/fastify/fastify/security/advisories/GHSA-3m5p-2c4r-xxw2)。

所以不能机械地只升级依赖而不改/验证 proxy 配置。也不能仅凭扫描认定本项目一定能被 SSRF 或跨租户攻击：当前 tenant middleware 读取原始 Host，compose 的 API 没有直接公布宿主机端口，实际可利用性仍需逐路径验证。

## 架构判断与为什么原有测试漏检

项目已有独立的 web/admin/agent API 路由边界、worker 进程，以及总部/代理后台静态构建；没有必要因为这次审计就把整个工程推倒重写。[服务边界实现](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/src/runtime/api-service-role.ts:5)、[部署制品](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/Dockerfile:41)。复用 Nest 模块代码不等于生产必须把服务放进同一进程。

主要矛盾在于：新公共剧池/Flutter 的行为没有和旧授权、鉴权、支付、分账以及发布配置完整对接。

- [原公共剧池集成测试](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/test/public-drama-pool.integration.spec.ts:96)使用 PGlite 默认 owner，inTenantContext 只设 GUC；这会掩盖 NF-02。不是所有旧 RLS 测试都无效，而是这个新业务路径没有用真实权限身份验证。
- 分成测试直接调用 record，未从消费入口验证到账。
- Flutter demo 本地返回播放/解锁数据，跳过真实接口、登录有效期、存储签名等条件。
- 后台测试及编译没有运行生产 bundle，循环 chunk 错误因此漏过。

## 后续修复验收顺序（尚未实施）

1. 修双后台正式制品白屏，并加入两种构建的浏览器启动验收。
2. 用受限数据库角色贯通“总部公共剧 → 代理审核上架 → 用户播放/金币解锁”，同时验证普通下架保留已购、紧急下架拒绝新播放授权；不能放宽租户 RLS 来换取通过。
3. 补原生注册/登录续期、真实支付/回执/退款、分成入账；用一笔真实沙盒交易验证订单、权益和三方月账的一致性。
4. 修 Flutter 解锁状态、账号本地隔离、导航和续播，统一语言全集、默认回退和元数据语言约束。
5. 落实原存储/HLS、国家授权、广告/推送/Deep Link，以及代理商正式签名的独立配置和 release 构建门禁。
6. 依赖安全修复与代理配置一并回归；在 PostgreSQL、Redis、真实反代以及 Android/iOS 设备做完整验收。

上述是后续建议，不构成本轮已完成或已上线的声明。

## 复现文件与命令

- [API 5 个缺陷复现测试](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/api/test/whitebox-audit-20260906.spec.ts)
- [Flutter 6 个缺陷复现测试](/Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app/test/whitebox_audit_20260906_test.dart)

```sh
cd /Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas
pnpm --filter @drama/api exec vitest run test/whitebox-audit-20260906.spec.ts

cd /Users/yewei/Documents/Codex/2026-08-31/zhe/work/shanchuang-drama-saas/apps/flutter_app
flutter analyze
flutter test test/whitebox_audit_20260906_test.dart
```

这两个文件故意断言缺陷存在，适合审计复现。修复对应问题时，应把断言改成期望的正确业务结果，并补正常/拒绝/并发路径；不要把此处的绿色当作产品验收。
