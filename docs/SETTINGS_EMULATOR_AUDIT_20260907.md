# 设置模块 Android 模拟器复测

范围：承接设置模块审计，对设置及其关联的账号、通知、隐私、帮助页面进行本地 Android 回归，并复测现有播放器/OCR 冒烟用例。独立 NightFlix，基线 `40c37f0`，不访问闪创服务、不部署服务器、不替换二维码下载包。不是全 App 的所有业务、所有操作系统已验收声明。

## 本轮发现并修复

| 问题 | 原因与修复 | 验证 |
| --- | --- | --- |
| 邮箱重置密码时页面异常 | 服务端撤销旧会话后，原设置页被移除；账号弹窗仍用原页面 context 取 Theme，键盘布局触发失效祖先访问。改用弹窗自己的 context。 | Android 曾复现 `Looking up a deactivated widget's ancestor is unsafe`；添加失效调用页面回归。 |
| 注销申请真实运行角色下返回 500 | 触发器需要调用 `app.customer_erasure_authorized`，部署权限脚本漏授 EXECUTE。只向 tenant/platform 运行角色授予这个受保护判定函数，不向 resolver 授权。 | 真实非 owner PostgreSQL API；另验证平台合法申请可通过、租户和伪造平台 scope 均不可越权。 |
| 退出其他设备提示错误 | 原英文误称其他设备退出也会退出本机。按 current 字段分别提示，确认标题包含设备名称。 | 真实第二设备会话，取消、撤销及本机保持登录。 |
| 设置确认框变黑、错误字对比弱 | State 上下文位于浅色页面主题之外，取到了根深色主题。确认弹窗和错误色显式沿用设置页浅色主题。 | 深色根主题下 widget 回归和实际 Android 截图。 |
| 重置和修改密码的长度规则不一致 | 注册/重置按字符数检查，API/修改密码按 UTF-8 字节检查。统一为 8–4096 字节，保留原始密码。 | 中文密码、上限规则、真实 OTP 重置及新密码登录。 |
| 错误验证码提示“请重新登录” | 账号弹窗直接复用普通受保护接口的 401 提示。改为验证码错误/过期提示；邮箱密码登录失败给对应提示。 | 错误验证码后再次填写、成功注册/重置。 |
| 导出大量记录把操作按钮推到很远 | 直接展开所有 JSON。改为最高 280px 的独立滚动预览，保留完整分页数据和原生分享。 | 100 条预览高度断言；101 条真实反馈记录的下一页测试。 |

## 参考源码核对

延续 `SETTINGS_AUDIT_20260907.md` 的文件映射，本轮重新核对 Melolo `DramaSettingFragment.OO0oo()` 的分组和条件入口、红果 `DefaultSpeedSettingActivity` 的默认倍速处理，以及 Starlight `settings_screen.dart` 的设置与清理行为。相关通知、账号、语言、缓存及权限页面也作为行为参考。

不复制混淆代码或素材。红果可读输出包含反编译伪代码，部分实现不完整，不能声称恢复其所有内部行为。Melolo 主题入口受远程能力开关控制；不添加无作用的主题占位按钮。Starlight 的下载占位和清空全部本地数据不符合已确认需求，不照搬。设置新增文案提供中文和英文回退，15 种语言可选择不等于新增文案全部完成母语翻译。

## 实际测试环境

- 本机 Android 15 / API 35，AVD `NightFlix_API35`，Flutter 3.47.2。
- 临时 PostgreSQL 仅绑定 `127.0.0.1:55439`，每轮创建独立数据库及非 superuser、非 bypassrls 的 tenant/platform/resolver 角色，应用全部迁移和真实运行权限脚本。
- Nest API 仅绑定 `127.0.0.1:4326`，模拟器通过 `adb reverse` 访问。HTTP、认证、会话、密码、SQL、设备、隐私和反馈均走真实实现。
- 仅替换测试邮件投递服务：保留真实随机验证码及验证逻辑，截获 `@example.test` 的验证码；不发真实邮件，不开万能验证码，不改变产品接口。
- 故障注入只用于本地 fixture：验证码发送、通知读取/写入、协议加载的 503；验证失败反馈、重试和开关回滚。
- 原生系统设置与分享选择器由主机驱动验证前台 Activity、截图并返回，不实际向任何人发送导出数据。
- 测试结束调用 `/__qa/finish`，关闭应用连接、删除本轮数据库及角色。测试辅助路由只存在于 opt-in 测试文件，不进入应用构建。

## 复跑命令

在仓库根目录启动本地专用 PostgreSQL 后：

```sh
NIGHTFLIX_SETTINGS_EMULATOR=1 \
NIGHTFLIX_PG_TEST_URL=postgres://nf_local_owner:local-test-only@127.0.0.1:55439/nightflix_local_features \
pnpm --filter @drama/api exec vitest run test/settings-emulator.integration.spec.ts --maxWorkers=1
```

另一个终端在 `apps/flutter_app` 执行：

```sh
adb reverse tcp:4326 tcp:4326
ANDROID_HOME=/path/to/Android/sdk flutter drive \
  --driver=test_driver/settings_driver.dart \
  --target=integration_test/settings_full_test.dart \
  -d emulator-5554 --no-pub
curl -X POST http://127.0.0.1:4326/__qa/finish
flutter test integration_test/settings_smoke_test.dart -d emulator-5554 --no-pub
flutter analyze --no-pub
flutter test --no-pub
```

`integration_test/settings_full_test.dart` 包含 9 个业务场景；Flutter 输出中的 setUpAll/tearDownAll 不计为额外业务测试。截图在 `apps/flutter_app/build/settings-emulator/`，原生界面使用 adb 截图，Flutter 页面使用运行于模拟器的实际渲染边界截图。

## 验证结果

- 干净源码候选：`e590ef5ba25f80b7d2705678034e11fe649f9bf9`；其后仅补充本报告。所有 Android 构建在本机执行。
- Android 真实 API/数据库矩阵：9 个业务场景全部通过，最终运行约 2 分 57 秒。Flutter 另统计的 setUpAll/tearDownAll 不计入业务场景数。

| 场景 | 实测结果 |
| --- | --- |
| 播放设置、游客门槛、原生信息、重启持久化 | 自动切集/字幕开关、6 档倍速、游客账号入口关闭返回、中文/英文、版本及磁盘恢复通过 |
| 语言 | 15 种已配置语言逐一选择通过，保留繁体中文、阿拉伯语 RTL、印地语实际截图 |
| 注册 | 邮件发送 503 重试、错误验证码后纠正、阅读协议及同意、真实注册和自动登录通过 |
| 通知 | GET 失败重试、PUT 失败回滚、两项开关真实 SQL 落库及重新加载通过 |
| 设备及密码 | 第二设备取消/撤销、本机保持登录；密码不一致/当前密码错误/正确修改，旧密码拒绝和新密码登录通过 |
| 邮箱重置 | 真实一次性验证码，中文 UTF-8 密码，旧会话失效后弹窗安全返回和新密码登录通过 |
| 导出及支持 | 10 类导出、101 条反馈跨页；协议失败重试、FAQ 展开、反馈落库、清缓存不清会话与反馈、退出确认通过 |
| 原生系统入口 | 真实打开 Android 本应用设置、真实分享 JSON 文件选择器，均取消返回并保留截图，通过 |
| 注销 | 未确认禁用、取消不写申请、确认后仅本测试账号停用、会话撤销、申请唯一、再次登录拒绝通过 |

- `flutter analyze --no-pub`：无问题。Flutter 全量 64 项通过，包括设置专项 17 项。
- API 类型检查通过。API 全量 129 个文件、846 项通过；6 项真实 PostgreSQL 排序/隔离回归单独补跑全部通过，去重合计 130 个文件、852 项通过。1 项可选 NativeAppBuilder 外部工具链测试跳过。测试 companion 在普通全量中按设计跳过，不当作产品功能通过数。
- `test-server-storage-grants.integration.spec.ts` 的 6 项已包含在上述 API 全量内，不重复计数。其中新增权限测试验证匹配申请、租户伪造 scope 仍被拒绝，以及 resolver 不获授权。
- 前几轮原生测试暴露的脚本问题（网络未等待、标题/按钮同名、重复输入未重新取得原生焦点、原生截图早于首帧）均修复后重新执行整套矩阵。失败轮次不计入通过；未通过改产品逻辑掩盖脚本问题。
- 实际截图和通过日志留存在本机 `/Users/yewei/Documents/Codex/2026-08-31/zhe/outputs/nightflix-settings-emulator-e590ef5/`，其中 `screenshots/` 包含中文设置、RTL、设备确认、注册返回、导出、原生分享及注销结果。已查看关键实际截图；不将其冒充 iOS 或线上证据。
- 独立 `settings_smoke_test.dart`：3 项全部通过。真实 Android 播放器暂停/恢复、第 10 集、倍速和导航；真实本机 ML Kit OCR；中文设置及原生版本/通知权限/系统设置入口。其视频及接口数据是隔离 fixture，不作为远程媒体播放或真实 OCR 搜索命中证据。日志 `settings-smoke-run.log` 一并留存。
- 本机 Android debug 构建通过；存在上游 `firebase_core` 的 Kotlin Gradle Plugin 未来兼容警告，本轮未扩大范围升级依赖。测试 APK 含集成测试入口，不作为普通体验包分发。

## 不能据此宣称通过的范围

- iOS 缺少完整 Xcode/CocoaPods，未进行 iOS 编译或模拟器测试。
- 真实邮件投递、推送送达、生产 AdMob 同意表单、商店续费/取消，以及注销异步处理最终完成未在本地真实第三方环境验收。
- 本轮修复尚未部署；手机现有安装包、扫码地址和服务器权限仍是旧状态。未来部署须在迁移后应用更新的 `deploy/test-server/runtime-grants.sql` 并复验注销流程，不能只更新 APK。
