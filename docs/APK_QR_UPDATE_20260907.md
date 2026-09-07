# 固定二维码 APK 更新（测试分发）

用户授权：更新现有二维码所指向的 Android 包，二维码不变。仅 NightFlix 测试服务器 `47.110.245.29`，不涉及闪创，不部署后台代码或数据库修改。

## 分发版本

- 固定地址：`https://47.110.245.29/downloads/nightflix-test-20260906.apk`。文件名虽保留旧日期，内容已更新。
- 源码提交：`189b1ab`（应用代码与已通过设置回归的 `752f031` 相同，额外提交只增加 APK 下载缓存控制）。本地干净工作树构建，入口 `lib/main.dart`，不是 integration_test 驱动包。
- 版本：`1.0.1`，versionCode `2026090707`，包名 `com.nightflix.template`。
- 联网地址：`API_BASE_URL=https://47.110.245.29`；内部 debug 签名测试包，非商店正式发行。
- 大小：211675309 字节。
- SHA-256：`12ed34c84ca7bb8892ccea36e2815b2e37b9d8737f2145429cfe403400d4d1f9`。
- 签名证书 SHA-256：`6cde627989c6b6e50033c0d606f6ef9071e9a0d920ce197d086c47fccebe3f06`，与公开旧包一致。

```sh
flutter build apk --debug --target=lib/main.dart \
  --dart-define=API_BASE_URL=https://47.110.245.29 \
  --build-name=1.0.1 --build-number=2026090707
```

核验发现旧包实际 versionCode 为 `2026090706`，因此未分发最初构建的较低版本候选 `2026090702`，而是从干净提交重新构建 `2026090707`。

## 验证与切换

- 完整下载原公开包并验证 SHA-256 `b4765b9eea689fe381831d3594275f0840949718ea70caf1cc5033d3862031da`，实际版本 `0.1.0-test / 2026090706`。
- Android 15 模拟器先安装这个真实旧包，再用 `adb install -r` 覆盖安装新包，成功；首次安装时间不变，中文设置保留。冷启动、个人中心和新设置页可打开，crash buffer 无崩溃记录。
- 使用 Vision 实际解码原有 `NightFlix-Android-download-QR.png`，确认仍为上述地址；没有修改二维码图片。
- 上传先进入隐藏临时文件，校验新包、旧包和 Nginx 配置的预期 SHA-256，并取得下载专用 flock 锁。若有其他发布修改任一目标则停止。
- 备份旧包及配置；Nginx 仅在 APK location 增加 `Cache-Control: no-cache, max-age=0, must-revalidate`，检查配置后 reload。APK 用同文件系统 rename 原子切换，避免公开半个包。
- 应用发布目录仍为 `/opt/nightflix/releases/bb1382b`，没有切换后台版本、重启应用服务或修改数据。
- 公网 HEAD 200、Range 206 和 ZIP 文件头通过；旧 ETag 条件请求返回新包的 200，而不是错误的 304。公网完整重新下载 211675309 字节，与本地候选逐字节 `cmp` 相同，SHA-256 均为上述值。缓存控制响应头已生效。
- 本地构建、下载包、安装截图及发布脚本保存在工作区 `outputs/qr-apk-20260907/`。

## 回退及后续更新

- 旧包备份：`/opt/nightflix/downloads/nightflix-test-20260906.apk.previous-2026090706-b4765b9`。
- 网关配置备份：`/opt/nightflix/downloads/nginx-ip.conf.previous-2026090707`。
- 后续每次需构建同包名、同签名且更高 versionCode 的 APK，验证后替换这个固定地址；无需重新制作二维码。不是应用内静默更新，用户仍需下载并确认安装。
- 本次只更新 APK。此前记录的后台修复（包括注销权限等）尚未部署，不能将 APK 分发等同于后台全部修复上线。
