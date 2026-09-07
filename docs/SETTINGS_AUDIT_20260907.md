# NightFlix 设置模块审计与修复

范围：独立 NightFlix。基线 `dee4fa4`，分支 `fix/settings-audit-20260907`。本地修复、回归、提交和推送；不操作闪创，不部署测试服务器，不替换扫码下载包。

## 参考证据与边界

- Melolo：`com/worldance/novel/pages/mine/settings/DramaSettingFragment.java` 的 `OO0oo()`，可确认账号、通知、条件主题入口等设置分组；对应资源 `dui`（Account）、`ara`（Settings）、`c80`（My Account）、`dwv`（Notification）、`dvs/dvt`（Clear cache）、`dul/dum`（Delete account）。部分混淆类缺失，只能核对可读入口和资源，不声称恢复全部内部逻辑。
- 红果：`com/dragon/read/component/biz/impl/mine/settings/SettingsActivity.java` 的隐私设置/通知入口，邻近 `DefaultSpeedSettingActivity.java`、`push/NotificationPushSettingActivity.java`、`mine/about/PermissionSettingsActivity.java` 对应默认倍速、推送和系统权限。仅参考产品行为，不复制反编译代码或资源。
- Starlight：`lib/screens/profile/settings_screen.dart`。参考整页导航、分组和二次确认；没有复制其“尚未接入真实媒体”的占位设置，也没有使用会清空书架、历史等的 `clearAllLocalData`。
- 不照搬离线下载、小说/听书、复杂推荐偏好、年龄门槛或测试更新按钮。已约定不做离线下载；更新包仍走商店/测试分发，远程配置不能执行新代码。
- Product Design 审计先记录原设置页面，再以同尺寸实际 Flutter 渲染复核新页；不是根据截图宣称全部无障碍检查通过。新页沿用现有个人中心浅色样式，改为全页分组导航。

## 逐项修复与验收点

| 编号 | 原问题 / 缺失 | 本次处理与检查 |
| --- | --- | --- |
| S01 | 设置只有少量底部弹窗控件 | 全页设置、返回导航、播放/通用/账号隐私/支持分组；360px、双倍字号回归 |
| S02 | 并发保存播放选项可能覆盖彼此；未检查存储失败 | 串行合并持久化，检查写入结果，重启恢复三项设置 |
| S03 | 设置页支持 0.5/0.75 倍，播放器菜单却缺失 | 共用合法倍速列表；不改变原有播放器逻辑 |
| S04 | 切语言重复点击/写入状态不一致 | UI 保存时锁定；读取、保存、切换有序执行，失败不提交无效界面状态 |
| S05 | 通知页晚到请求可能绑定新账号 | 发起加载前绑定账号，页面和提交均检查账号范围；账号切换立即移除旧页 |
| S06 | 通知加载无状态、失败只弹提示 | 即时页面、加载条、失败重试；保存成功才切换开关；演示偏好按账号保留在当前仓库实例 |
| S07 | 系统推送授权仅文字说明 | Android/iOS 原生读取通知状态，打开本应用系统设置，回到前台重新读取 |
| S08 | 无登录设备入口 | 接入现有设备 API，显示当前/其他设备及最近活跃；二次确认、幂等撤销、退出当前设备清会话 |
| S09 | 无修改密码入口 | 当前密码/新密码/确认密码；校验、重复提交锁、防原始错误泄露；错误密码不会错误刷新登录 |
| S10 | 找回密码入口只能绕回登录 | 设置中直达现有邮箱验证码重置流程，预填当前邮箱，可关闭；重置成功清理被服务端撤销的旧会话 |
| S11 | 无数据导出入口 | 复用分页导出 API，选择类别、密码复核、下一页、系统保存/分享当前页；不缓存密码；换号清页面 |
| S12 | 无注销入口 | 明示停用/权益/保留/外部处理/商店续费规则，勾选确认、密码复核、二次确认、幂等提交；提示“申请已提交”，不谎称立即全部删除 |
| S13 | 隐私接口会 trim 密码，且错误地限制 8–256 字符 | 改为与登录相同的 8–4096 UTF-8 字节，完整保留原密码；空格、长密码、中文及错误密码回归 |
| S14 | 缺少安全的清缓存入口 | 仅清 Flutter 图片内存缓存和短时图片 URL；不清登录、收藏、历史、订单或视频文件 |
| S15 | 协议入口无加载/重试；无关于页 | 真实租户协议、版本、空状态、展开阅读；关于页读取原生 version/build/package，不硬编码版本 |
| S16 | 广告隐私 SDK 错误回调被吞掉，表现为无反应 | 使用现有 AdMob UMP，失败反馈并允许重试；SDK 失败和恢复用例 |
| S17 | 退出无二次确认，网络异常状态不清楚 | 设置和个人中心共用确认；本机退出但远端撤销失败时明确提示 |
| S18 | 帮助/客服入口需保持真实链路 | 设置复用现有 FAQ、反馈提交/回复和协议页面；不增加空按钮 |

## 验证方法

```sh
cd apps/flutter_app
flutter analyze --no-pub
FLUTTER_ROOT=/path/to/flutter flutter test --no-pub
flutter test integration_test/settings_smoke_test.dart -d emulator-5554 --no-pub
```

`test/settings_test.dart` 覆盖持久化、接口协议、错误密码、通知读写/隔离、游客登录门槛、设备撤销、密码校验/防重复、导出分页/换号、注销确认、缓存保护、语言/帮助/退出、广告隐私失败以及双倍字号。`test/settings_visual_test.dart` 记录 390×844 的实际 Flutter 页面，字体来自当前 Flutter SDK；不将 widget fixture 冒充线上联调。

API 验证使用本地 PGlite 测试数据库，覆盖真实 SQL/认证/通知/隐私流程；另启动仅监听 `127.0.0.1:55439` 的临时 PostgreSQL 18.4，运行现有租户隔离/排序回归。没有访问测试服务器或真实账号。

## 实际结果

- 源码候选提交：`1b18d285063253685a7ecda77c0cadf219ea31e0`；测试/构建时工作树干净，后续仅补充本文结果。
- `flutter analyze --no-pub`：通过，无问题。
- Flutter 全量：61 项通过，包含设置专项 14 项及设置页视觉回归。
- Android 15 模拟器：`integration_test/settings_smoke_test.dart` 3 项通过。包括原生播放器暂停/恢复/第 10 集/倍速/选集/自动连播开关、真实 ML Kit OCR，以及中文设置页、原生 version/build/package、真实通知授权状态和打开本应用系统设置。接口数据使用隔离 fixture，不冒充服务器端到端测试。
- API 类型检查：`pnpm --filter @drama/api typecheck` 通过。
- API 全量：`pnpm exec vitest run --maxWorkers=2`，129 个文件通过、845 项通过。另 6 项真实 PostgreSQL 回归因全量运行未配置连接而跳过，随后使用受控本地连接独立补跑，6 项全部通过。去重合计 130 个测试文件、851 项通过，1 项可选外部 NativeAppBuilder 工具链测试跳过，不计入通过。
- 首次高并发全量运行发生数据库初始化超时，未计为通过；降低并发后从头重跑，全部数据库初始化及相关用例通过。
- 普通 Android debug 候选包（不是 integration_test 驱动包）构建通过：`API_BASE_URL=https://47.110.245.29`，版本 `0.1.0 (10)`。工作区产物 `outputs/nightflix-settings-1b18d28-local-candidate.apk`，SHA-256 `652cc3cb370909e77ee415dad8ac5263c9aa9f6170a7b094b0b6784d0d7cd731`。只作为本地候选留存，服务端尚未部署对应修复，不作为完整升级分发。
- 实际 Flutter 设置页前后渲染留存在工作区 `outputs/nightflix-settings-audit/before.png`、`after.png`；仓库保留 `apps/flutter_app/test/goldens/settings.png`。原生测试截图写入模拟器临时缓存，测试卸载后不再保留，未当作可交付图片。
- Android 构建存在上游 `firebase_core` 仍使用旧 Kotlin Gradle Plugin 的未来兼容警告；当前工具链构建通过。本轮未擅自升级依赖，后续升级 Flutter 时需单独回归。

## 尚未验收 / 不包含

- iOS 主机缺少完整 Xcode 与 CocoaPods：只能核对 Swift 源码，不能宣称 iPhone 编译或真机通过。
- 真实邮箱发送、商店订阅取消、生产 AdMob 同意弹窗、远程推送投递和服务端异步注销最终完成需要配置和对应环境；本次不会发送真实邮件、删除真实账号或扣费。
- 设置新增文案提供中文和英文回退；现有多语言选择保持可用，尚未逐条母语校对其他语言的新文案。
- 协议使用服务器正文的只读文本展开，不运行远程 HTML/脚本。
- 未部署意味着现有手机安装包和扫码链接仍是旧版本，不包含此分支改动。
