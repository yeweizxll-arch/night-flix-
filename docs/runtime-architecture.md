# 运行与发布架构

本项目复用闪创已经验证过的组织方式：代码仓库采用模块化单体，运行时拆成四个独立单元。共享类型、
领域规则和数据库迁移不等于混跑服务；每个单元都有独立进程、容器目标、入口、健康检查和发布生命周期。

| 发布单元 | 职责 | 对外路由 | 默认端口 |
| --- | --- | --- | --- |
| web | Android/iOS 与兼容 H5 的客户 API、支付回调 | `/api/v1/customer/*`、`/api/v1/payments/webhooks/*` | 3200 |
| worker | Outbox、排期、通知、隐私擦除、结算等异步任务 | 无 HTTP 路由 | 无 |
| admin | 总部后台 API 和总部后台静态制品 | `/api/v1/platform/*` | 3201 |
| agent | 代理商后台 API 和代理商后台静态制品 | `/api/v1/tenant/*` | 3202 |

生产环境必须显式设置 `DRAMA_SERVICE_ROLE`。角色边界在 HTTP 处理的最前层执行，越界路由返回 404；
`ops/release-units.json` 是构建和发布系统可读取的机器契约。四个单元可从同一 commit 构建，但镜像标签、
扩容、重启、健康验证和回滚互相独立。

## 与闪创的隔离

- 短剧 SaaS 使用自己的 PostgreSQL 数据库、Redis 命名空间、对象存储配置、域名和密钥。
- 闪创只通过受控的总部发布接口把完结作品标识和媒体地址写入中央公共剧池；不允许短剧 SaaS 直接读取闪创业务表。
- 用户、订单、权益、互动、广告配置及代理商私有内容都带 `tenant_id`，由数据库 RLS 和应用上下文双重隔离。
- 代理商上传内容只属于本租户；公共剧由总部建立版本，代理商分别审核、定价、上架。
- 生产服务器只接收本地或 CI 构建并校验过的制品，不安装依赖，不编译源码。

## 本地运行

开发期可以用 `DRAMA_SERVICE_ROLE=all` 启动单进程以减少本地资源占用，但这不是生产形态。需要验证边界时分别运行：

```bash
pnpm --filter @drama/api dev:web
pnpm --filter @drama/api dev:admin
pnpm --filter @drama/api dev:agent
pnpm worker
```

生产配置若缺少 `DRAMA_SERVICE_ROLE` 会拒绝启动。
