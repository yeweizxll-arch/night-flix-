# Android 产品审计修复与固定二维码更新

## 已分发

- 下载地址（原二维码不变）：https://47.110.245.29/downloads/nightflix-test-20260906.apk
- 版本：1.0.2 / 2026090802；包名 com.nightflix.template。
- 应用源码提交：f1c7ed675be76e6fabd8d18f09a3b175400ca390；包含 8f6d4a7 的评论生命周期、时间、登录对比度、筛选空态和账户详情修复。均已推送 main。
- APK 大小：211680005 字节。
- APK SHA256：cf71a1994ca2b26849034fd229dec169d5a297c0cce8d55588425d778bcfb10c。
- 签名 SHA256：6cde627989c6b6e50033c0d606f6ef9071e9a0d920ce197d086c47fccebe3f06，与旧包一致。仍为内部 debug 签名测试包，不是商店发行。
- 本地干净工作树构建普通入口 lib/main.dart，API_BASE_URL=https://47.110.245.29；不是 integration_test 安装包。服务器没有构建或依赖安装。

## 验证

- 66 项 Flutter 单元/组件、877 项后台测试、8 项单独真实 PostgreSQL 测试通过；Flutter analyze、API typecheck 通过。
- 18 个不同 Android 业务场景：设置 9、账户 2、目录及互动 1、评论生命周期 1、登录对比度 1、原生播放/OCR/设置 3、远程目录及导航 1。每项包含多步断言；重复执行不重复计数。
- 普通包实测：中文评论时间、键盘弹起后关闭、中文识剧按钮、分享/相册/相机打开与取消、图库图片本机 OCR 后编辑词条并搜索到对应短剧、飞行模式筛选失败及恢复网络重试。
- 从原公开 2026090707 覆盖安装候选，最终 2026090802 同签名覆盖，firstInstallTime 保持 2026-09-08 14:54:55，中文和播放进度保留。
- 原二维码使用 Vision 实际解码，确认固定地址未变。
- 2026090802 首次上传中断，未发布半成品；使用 rsync 断点续传后验完整 SHA256，再取得 APK 专用锁、备份旧包、同文件系统原子 rename。
- 公网 HEAD 200、新长度与 ETag 正确；携带旧 ETag 返回 200；Range 206 / bytes 0-3/211680005，文件头 PK。Cache-Control 仍为 no-cache, max-age=0, must-revalidate。
- 公网完整重新下载 211680005 字节，与本地 APK 逐字节 cmp 相同、SHA256 相同；该下载文件再次在模拟器覆盖安装成功并冷启动。

## 数据与回退

- 90 部既有测试剧仅补分类：爱情 19、古装 18、玄幻 20、科幻 4、剧情 29。媒体、上架状态和权益未改变，其他租户未修改。
- 数据备份：/var/backups/nightflix/before-categories-20260908.dump；SHA256 181e07118d231a4f0adba38e3cfcabd0ce584f117223a91b29682139028868fc。恢复数据需重新评估后续写入，不能整库覆盖新数据。
- 旧 APK：/opt/nightflix/downloads/nightflix-test-20260906.apk.previous-2026090707。已安装新版的设备不可直接降级，应以更高 versionCode 重打包回退代码。
- 后台业务代码没有改动，四服务仍使用 /opt/nightflix/releases/fd2ec51；没有重启或混合服务。

## 不冒充完成的范围

商店支付、AdMob、Google/Apple 登录和推送未配置，验的是关闭态而非真实外部交易/广告/送达；真实字幕配音轨道没有测试素材；iOS 未测。分享当前为剧名文本，未配置 Deep Link 主机，不能声称已验证跨设备剧目直达。没有宣称“所有可能状态绝无 Bug”。

详细过程见 android-full-20260908.md。完整日志、截图及下载制品位于工作区根目录 `/Users/yewei/Documents/Codex/2026-08-31/zhe/outputs/android-product-fix-20260908/` 和 `outputs/qr-apk-20260908/`。
