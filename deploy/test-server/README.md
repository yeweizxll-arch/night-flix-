# Night Flix 独立测试服务器

仅用于 Night Flix 的单机测试环境，不涉及闪创服务器、数据库或发布批次。
服务器不安装项目依赖、不编译源码。运行组件使用发行版二进制包；项目制品在本地构建。

## 构建与运行

在干净的本地 worktree 中执行：

```sh
pnpm install --frozen-lockfile
node deploy/test-server/build-artifact.mjs /absolute/new/artifact-directory
```

输出独立 API 运行包、总部/代理商/H5 静态资源、数据库迁移、commit 元数据、tar.gz 和 SHA256。
`pnpm-workspace.yaml` 的 [supportedArchitectures](https://pnpm.io/10.x/settings#supportedarchitectures)
保证在 macOS 上也安装 Linux x64 glibc 的预编译可选依赖。
不要从服务器运行此脚本。Node Linux 运行时需单独下载官方固定版本并校验 SHA256。

目录约定：

- `/opt/nightflix/releases/<commit>/`：不可原地修改的制品。
- `/opt/nightflix/current`：当前已验证版本。
- `/opt/nightflix/runtime/node-v24.20.0-linux-x64/`：官方预编译运行时。
- `/etc/nightflix/runtime.env`：私密运行配置，root 读取后由 systemd 注入；不能提交仓库。
- `/etc/nightflix/{web,admin,agent,worker}.env`：角色、端口及 ENTRY_POINT。
- `/var/backups/nightflix/`：受限访问的数据库备份。

四个独立进程使用 `nightflix@.service` 模板：

| 实例 | DRAMA_SERVICE_ROLE | PORT | ENTRY_POINT |
| --- | --- | --- | --- |
| web | web | 3200 | dist/main.js |
| admin | admin | 3201 | dist/main.js |
| agent | agent | 3202 | dist/main.js |
| worker | worker | 不使用 | dist/cli/run-worker.js |

API 当前监听所有网卡，**必须保持主机防火墙关闭 3200–3202 的公网访问**。
网关独立反代到本机各 API，不允许总部路由落到代理商或用户服务。
原始 Host 必须保留；总部 Host 不可同时登记为租户域名。

## 数据库、缓存与初始化

PostgreSQL 16 和 Redis 仅监听 loopback，二者都启用 TLS。
保持 `NODE_ENV=production`、`DATABASE_SSL=verify-full`、`REDIS_URL=rediss://...`，
并为 Node 配置非敏感 CA 文件 `NODE_EXTRA_CA_CERTS`；CA 文件须能被服务用户读取。
Node 的额外 CA 需在进程启动前注入，不能仅依赖 CLI 的 `--env-file` 加载此选项。
数据库 CA 另通过 `DATABASE_SSL_CA_BASE64` 提供，连接池每种角色每进程为 3。

离线迁移所有者 `nf_owner` 与 `nf_tenant`、`nf_platform`、`nf_resolver` 分开；
所有角色均非 superuser / BYPASSRLS，运行角色不拥有业务表。
先执行已审核迁移，再以迁移所有者执行 `runtime-grants.sql`，再运行编译好的
`dist/cli/sync-permissions.js` 和首次 `dist/cli/bootstrap-super-admin.js`。
迁移口令不放入四个服务的环境文件。每次新增迁移后重新审查并应用运行时授权。

支付、广告、第三方登录、邮件及应用构建功能未配置时保持关闭，禁止改用生产环境假支付/万能验证码。

## 2026-09-06 部署与验收记录

- 目标：`47.110.245.29`，Ubuntu 24.04，测试用途。
- 当前运行 commit：`7f192a121b03859812d5745a5c4e8f292110034b`。
- 制品 SHA256：`5b33d2b9dbc47b0b42103f4eb3a950b8a7303cf350c5bb482e811b1ea9d224f1`。
- 38 个数据库迁移执行成功；91 个权限同步成功。
- 部署时发现权限同步 CLI 使用保留字 `grant` 作为 SQL 别名，已最小修复为 `assignment`。
  新增 PGlite 回归先复现失败，再验证修复；本次相关 20 项测试通过。
- 本地重新构建 API、两套后台和 H5；Linux sharp 0.35.3 成功加载。
- 四服务启动并启用开机启动；主动重启后全部 active / running，重启计数为 0。
- 经 SSH 隧道及校验证书的 HTTPS 完成 22 项接口/静态页面检查，包括：健康状态、双后台登录、
  安全刷新 Cookie、游客配置、15 种语言与中文默认、未验证域名拒绝、跨服务/跨身份访问拒绝、
  测试用户登录/资料/金币余额。**不是浏览器逐页面 UI 验收。**
- PostgreSQL 实测租户行级隔离、伪造 `app.access_scope=platform` 不提权、跨租户修改不可见行；
  临时第二租户仅在事务内创建并回滚，无残留。
- 现有测试数据：总部管理员 1、代理商 1、普通用户 1、赠送金币 1000（有流水和审计，无现金收入）。
- 数据库备份已恢复到临时数据库验证：38 迁移、1 租户、1 用户、1000 金币；临时恢复库已清理，备份保留。
- 备份 `/var/backups/nightflix/nightflix-20260906-initial.dump`；SHA256：
  `a638d2948dcd064f2f3a6850ebcd332fbe9c8f237cec0e4abe1767744b37223f`。

当前只开放 SSH。内部网关为 `127.0.0.1:8441/8442/8443`，测试 Host 为
`admin.nightflix.test` 和 `demo.nightflix.test`，使用私有测试 CA；这些不是公网可用地址。

### 尚未完成的外部体验条件

1. 用户确认测试域名/公网入口方案，解析并配置可信 HTTPS 后才能开放网页和 App 联网体验。
2. 配置独立授权的视频对象存储并导入测试剧。目前没有向空库伪造可播放剧目或接入闪创数据。
3. 域名和剧目就绪后重新构建联网 Android APK，完成真机播放/互动/解锁验收。
4. Apple/Google/AdMob/邮件等真实集成仍需代理商对应配置；目前不宣称真实支付或广告验收通过。

首次安装没有更早的健康版本；旧目录 `3571d70` 是初始化失败的候选，**不能用作回滚版本**。
遇到故障先停止四个 Night Flix 服务并保持公网入口关闭，保留数据库及制品，再从已核验的备份恢复到隔离库。
后续发布必须先备份、上传校验、新目录启动与验证，再切换；不得在服务器改源码或安装项目依赖。

## 临时公网域名预检：被云厂商备案策略阻断

2026-09-06，用户同意临时域名后，预检以下三个独立 Host：
`admin.47-110-245-29.sslip.io`、`demo.47-110-245-29.sslip.io`、
`app.47-110-245-29.sslip.io`。服务器侧 DNS 均正确返回 `47.110.245.29`。

临时安装 `nginx-acme.conf` 并仅开放 HTTP 验证端口；本机请求
`/.well-known/acme-challenge/nightflix-connectivity` 返回预期的
`nightflix-challenge-ready`。外部按域名访问及显式指定目标 IP 访问，均返回：

```text
HTTP/1.1 403 Forbidden
Server: Beaver
<title>Non-compliance ICP Filing</title>
```

响应指向阿里云备案阻断页面，不能当成应用错误或 HTTPS 已可用。
根据[阿里云备案域名说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/for-the-record-domain-faq/)，
未完成适用备案/接入备案的域名解析至中国内地服务器，可能被阻断访问。

已撤回临时公网监听、删除本次新增的 UFW 80 入站规则，并确认四服务仍 active。
配置留存于 `/root/nightflix-incoming/nginx-acme.blocked.conf`，不在 Nginx 加载目录。
未申请证书、未更改租户域名记录或运行环境、未更换应用制品、未开启 443。

继续需用户确定其一：在本服务器使用已完成适用备案的自有域名；
或提供中国香港/境外测试服务器后，按相同隔离架构重新部署并验证临时域名。
中国内地以外地域的备案差异见[阿里云跨地域 FAQ](https://help.aliyun.com/zh/ecs/cross-region-usage-faqs)。
不通过改变端口、伪造 Host 或关闭证书校验规避备案阻断。
