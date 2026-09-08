# Night Flix 并发白盒审计（2026-09-08）

基线：4221820；分支：audit/concurrency-20260908。目标为独立 Night Flix，未访问或修改闪创生产服务。本轮没有上线、数据库迁移或二维码替换。

## 已确认并修复

| 问题 | 根因及修复 | 验证 |
| --- | --- | --- |
| 数据库阻塞放大 | 连接池原来只有连接建立超时，没有 SQL/锁等待上限；新增默认 SQL 30 秒、锁等待 5 秒，作用于三个数据库客户端 | 真实 PostgreSQL 慢 SQL 取消、锁超时、事务回滚、池再次可用 |
| 无效连接池配置未拒绝 | `Number()` 允许零、负数、小数、NaN、Infinity；启动时校验合法整数 | 6 个非法值测试，修复前全部失败 |
| Redis 故障积压 | 默认离线队列和命令等待没有本项目设置的边界；关闭离线重放，待处理命令最多 1000，单命令等待 3 秒 | 配置回归和未就绪时不提交限流命令；没有将 mock 测试称为真实 Redis 故障演练 |
| App 收藏/追剧回退 | 列表旧响应覆盖刚完成的操作，或者较早刷新覆盖较新刷新 | 两个可重复的异步顺序测试；写入修订号、刷新序号保护；追剧按请求目标设置，不再反转可能已变化的值 |
| 后台退出后旧会话复活 | 刷新请求完成后无条件设置会话，旧业务请求可能重新提交 | 会话代次隔离刷新、登录、退出及响应；账号变更不重放旧操作；退出/刷新竞态修复前失败、修复后通过 |

数据库设置可通过 `DATABASE_STATEMENT_TIMEOUT_MS`（1–300000）、`DATABASE_LOCK_TIMEOUT_MS`（1–60000）调整，生产 compose 和示例配置已同步。超时是失败边界，不是自动重试：支付等写操作必须保留原幂等键，不能盲目重发新订单。连接总量仍需按“实例数 × 不同数据库客户端池数 × DATABASE_POOL_MAX”预算，保留迁移和管理连接。

## 测试证据

- 后端常规全量：886 通过，16 跳过。常规集成中包含 PGlite 和替身，不等同全部真实 PostgreSQL。跳过的专用环境测试另行运行如下；管理员浏览器完整验收未在本轮重跑。
- 真实 PostgreSQL：13 通过。每次新建并清理独立数据库；租户角色非 owner、非 superuser、无 bypass RLS；购买路径使用另一个注册平台角色。
  - 200 个并发租户事务，各自检查数据库会话租户与可见账号。
  - 同账号 40 次相同/不同幂等键解锁：仅一个权益、一个扣款账本，1000 → 700。
  - 30 个买家、300 次购买：30 个独立权益，各钱包 500 → 200；后续不足额购买全部拒绝，没有多扣或负余额。
  - 四个并发 outbox worker 在健康传输路径无重复抢占。外部 Redis 投递使用替身；崩溃后仍是至少一次投递，不能宣称网络端到端 exactly-once。
  - SQL/锁超时后回滚并恢复服务；既有内容权限、分类、互动、跨租户写入等回归。
- 本地真实 HTTP + Nest + PostgreSQL：7 个登录账号，28 路并发，560 次账号/钱包读取；0 错误、无账号混用。一次运行耗时 1288ms，P50 54ms、P95 157ms、最大 227ms。
  - 使用 settings 本地夹具，真实密码/JWT/数据库运行角色；Redis 使用非生产内存回退，邮件使用受限替身。
  - 这些是小数据、单机短时结果，不是服务器容量，不包含视频带宽、CDN、真实邮件、支付、广告网络或持续耐久测试。
- 管理后台：120 项通过；最后会话代次细化后专项 6 项再次通过；类型检查和构建通过。
- Flutter：最终全量 68 项通过，包含两个片库并发专项；静态分析通过。UI 未改版，本轮没有重新打 APK 或进行整套模拟器点击验收。
- H5 参考工程 24 项、旧 Capacitor 包装工程 8 项通过；contracts 没有独立测试。API 构建、类型检查通过。
- 后台仍有 Ant Design 弃用提示、约 1.5 MB 主 JS chunk 提示；不将构建警告当成崩溃，也未为消除警告扩大到全站重构。

## 可复跑命令

```sh
pnpm --filter @drama/api test --maxWorkers=2
pnpm --filter @drama/admin test
pnpm --filter @drama/api typecheck
pnpm --filter @drama/admin build
# 在 apps/flutter_app 下：flutter test --no-pub；flutter analyze --no-pub
NIGHTFLIX_PG_TEST_URL=postgres://nf_local_owner:local-test-only@127.0.0.1:55439/nightflix_local_features pnpm --filter @drama/api exec vitest run test/discovery-postgres.integration.spec.ts --maxWorkers=1
# HTTP：先启动专用本地夹具，再在另一个终端执行脚本；脚本结束会通知夹具清理。
NIGHTFLIX_SETTINGS_EMULATOR=1 NIGHTFLIX_PG_TEST_URL=postgres://nf_local_owner:local-test-only@127.0.0.1:55439/nightflix_local_features pnpm --filter @drama/api exec vitest run test/settings-emulator.integration.spec.ts --maxWorkers=1
node scripts/local-concurrency-http.mjs
```

## 结论边界

本轮进行了全仓测试盘点、现有回归执行以及认证、支付解锁、数据库、Redis、租户隔离、后台工作任务和客户端异步状态的重点源码白盒审计。不是“每一行已证明没有问题”。本地已发现的问题已修复；本机的 28 路 HTTP 并发不能推导线上支持几千人刷剧。

正式容量结论还需要独立预发：接近真实剧库的数据量、生产等价 Redis/TLS、长时间混合读写、视频带宽及连接数监测、实例故障和依赖断连测试。不得直接对现有体验服务器进行破坏性或饱和压力测试。
