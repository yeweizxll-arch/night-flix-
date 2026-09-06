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
   已有部署还需以离线迁移所有者执行 `storage-runtime-grants.sql`：原部署遗漏了媒体/内容触发器
   调用的两个 SECURITY INVOKER 帮助函数权限，会使真实上传入库返回 500。
   修复仅授予两个业务角色这两个函数的 EXECUTE，不授予全部函数、不更改 RLS 或数据库所有权。
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

## 2026-09-06 实际部署记录

- 应用制品 commit：`c0e2ca1ee61e936e5244e6951a8fff4706c85e2e`，当前链接 `/opt/nightflix/releases/c0e2ca1`。
  SHA256：`b8566d2d6bb1a962b7edb587ac70e6ea3e94e276261af3df788f8c31155369cf`。
  本地构建 API、两套后台、H5；服务器核对制品、Linux sharp 和隔离候选健康后切换。
- 数据库权限修复 commit：`dbeff1c`，SQL SHA256：
  `1f7aac32712b4a16115b2a7373c884f3061f92356271450c04b68e777d097066`。
  以离线 `nf_owner` 只执行两个 EXECUTE 授权；应用代码没有进一步变更，不需再次构建。
- 本地后端 829 项通过、1 项跳过；新增真实受限角色权限回归 5 项通过；后台 48 项通过。
  API/后台类型检查通过，公网 HTTPS 27 项冒烟通过。
- 官方存储兼容测试：两个 bucket 均通过真实签名 PUT、SHA256/metadata HEAD、Range GET、
  重复覆盖 412、坏校验 400 且不落盘、匿名/跨 bucket 403、两个后台 Origin 的完整 CORS。
- 总部 Provider `01a07755-f061-7d43-a55d-10193e72d26f`、代理商 Provider
  `01a07759-cdd4-7dfb-ae51-9d3ae59af1c8` 均 active。两者密钥不同，不外显凭证。
- 经真实后台 API 分别上传 PNG（1676 字节）、有效 MP4（70610 字节）、VTT（56 字节），
  六个媒体均 ready，重复完成返回同一媒体 ID，读取字节与原文件 SHA256 一致。
  主动重启存储服务后，重新读取这六个文件，字节数/SHA256 全部一致。
  另保留一个排查时生成的未上架 PNG；没有发布真实剧目或修改用户已有素材。
- 五个独立服务 active；存储已开机启动且重启计数 0；所有存储端口仍仅监听 loopback。
  切换时磁盘约 52 GiB 可用。无需新增公网端口、域名、外部对象存储账户或重新安装 APK。
- 部署前数据库备份：`/var/backups/nightflix/nightflix-before-disk-storage-20260906.dump`，
  SHA256 `19aa02e20d4f4596c74be7b767a72ba7d43b1a82d44b07685f882fc2157f8021`。
  `/etc/nightflix` 和 Nginx 备份 SHA256：
  `11a4ea4d2157b4fa52709eb60c621459b7ca1cb4b7568cb03a7ec6d2731c9e63`；本地私密副本已保留。
  授权前另备份 `nightflix-before-storage-grants-20260906.dump`，SHA256
  `1f97f89490c17ee49d3d03d09697e891728b1f181d935a36709151b3031bd8f0`。
- 验收界限：真实 API/对象字节/持久化已验证；没有宣称完成手机端播放或浏览器逐页面验收。
