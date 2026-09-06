# 单机测试硬盘存储

本配置仅供 `47.110.245.29` 的 Night Flix 测试使用，不涉及闪创服务器。
封面、正片、字幕等继续走现有上传意图、临时签名、SHA256 和 HEAD 完成校验；
存储位置改为这台服务器的 `/var/lib/nightflix-storage`，不是购买外部 S3。

## 运行边界

- 使用 [SeaweedFS 官方 4.45 Linux amd64 预编译包](https://github.com/seaweedfs/seaweedfs/releases/tag/4.45)。
  发行包 SHA256：`c408894668aeaa74d4f251e20b350fd72195cbe596ddc3f48658709714f7be36`。
- 独立 `nightflix-storage.service`、系统用户、数据目录、1 GiB 内存上限；不放在 app release 目录。
- 全部存储监听端口仅绑定 `127.0.0.1`；禁止开放 8333/8888/9333/9340 及 gRPC 端口。
  关闭 WebDAV、存储管理 UI、IAM HTTP API、Iceberg、Lance 和遥测。
- Nginx 在现有 IP HTTPS 443 下代理两个精确 bucket 前缀；保留签名 Host、路径和校验头，
  不记录签名 URL、不缓冲整个视频，单请求最大 2 GiB。
- `nightflix-public` 由总部凭证读写，`nightflix-demo` 由测试代理商凭证读写。
  两套 bucket-scoped 密钥，无匿名访问、无全局 Admin 权限。公共指业务公共剧池，不是公网裸链。
- CORS 只允许现有三个测试站点；浏览器仍需合法临时上传签名。
- 代理商上传弹窗只选择代理商私有存储，默认选择已启用项。

## 首次安装与验证

1. 本地运行 `prepare-disk-storage.mjs /absolute/new/private/directory`，产生 root 私密配置；
   不把密钥放入仓库、日志或聊天。服务器存储凭证文件使用 systemd LoadCredential 读取。
2. 上传官方预编译包，核对上述 SHA256 后解压到 `/opt/nightflix/runtime/seaweedfs-4.45`。
   不在服务器构建应用或安装项目依赖。
3. 备份数据库、`/etc/nightflix` 和 Nginx；创建 `nightflix-storage` 系统用户，安装本目录 unit，
   私密配置安装到 `/etc/nightflix/storage-s3.private.json`，mode 0600。
4. 启动存储并确认没有公网监听；安装 `nginx-ip.conf` 后先 `nginx -t`，通过后 reload。
5. 本地执行 `smoke-disk-storage.mjs /private/providers.private.json`，验证 CORS、条件写、
   SHA256、HEAD、Range、禁止覆盖、匿名/跨 bucket 拒绝和坏校验拒绝。临时探测对象精确清理。
6. 本地测试、干净提交和构建应用制品。上传后校验 SHA256、commit 和隔离候选健康状态。
   在测试服务器运行 `allow-disk-storage-endpoint.mjs`，仅增加精确公网 IP allowlist。
7. 切换已核验制品、重启四个应用服务，执行 `smoke-ip.mjs`。
8. 本地生成一个自有 3 秒 MP4，运行 `enable-disk-storage.mjs /private/access.private.json
   /private/providers.private.json /private/test.mp4`，通过后台 API 建立/启用存储并上传 PNG、MP4、VTT。
   完成校验和重复完成必须返回 ready，读取服务器文件 SHA256 必须与原文件一致。
   测试素材保留为独立未上架媒体记录；脚本每次执行都会新增三项/归属，勿无故重复运行。
9. 验证重启后数据持久化，再启用存储服务开机启动。

## 限制与回滚

这只是单机测试存储：容量、上传/播放带宽均来自当前服务器，没有外部 CDN、跨机冗余或自动转码。
MP4 可走已有短时授权播放；本次存储验收不等于 Android 真机、HLS 转码或商业上线验收。
系统盘也承载数据库与日志，测试上传前检查 `df -h`，不要把剩余空间全部用完；
大批量测试前扩独立数据盘并设置磁盘容量告警。不要把这台单机当唯一素材备份。

应用回滚不删除 `/var/lib/nightflix-storage`。若停用本地存储，先通过后台禁用两个 Provider，
再撤回 Nginx 的两个 bucket 路由并停止存储服务；保留原文件、数据库和加密密钥。
旧应用不支持公网 IP allowlist，因此要一起恢复之前运行配置并禁用新 Provider。
禁止为了“回滚”覆盖整个现有数据库，或删除用户已上传数据。
