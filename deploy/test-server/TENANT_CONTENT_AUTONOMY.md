# 代理商内容自主运营修正

仅用于独立 Night Flix；不要访问或部署闪创服务器。

- 私有剧：代理商确认上架、定时上架、下架、下架后编辑；总部不审核。
- 上下架需要 `content.drama.update`、租户身份、版本和幂等键。
- 普通下架保留已购权益，取消该剧及剧集的旧定时任务。
- 历史 pending_review 只能由代理商撤回为草稿，不自动发布。
- 总部私有内容审核及社区治理 HTTP 路由、菜单、权限已移除；历史审计保留。
- 评论只应用本租户敏感词；总部公共池发布及公共内容紧急下架保持独立。

## 迁移与回滚

先备份数据库，再以离线迁移所有者执行 0041_tenant_content_autonomy.sql。
该迁移允许私有剧下架后更换剧集媒体，撤销已退休权限的角色授权。
不迁移任何已有剧目的发布状态，不删除视频文件、历史审核或审计。

本地干净提交构建制品，校验 SHA256 后上传独立测试机。先启动隔离候选 API，
完成真实权限及上下架闭环再切换 current。不得在服务器安装依赖或构建。
失败时停止切换；回滚使用上一 release。不要恢复旧数据库覆盖新增用户数据。
旧应用会重新出现审核页面但权限已撤销；优先修复前进，恢复旧流程需另行明确授权。

## 验证

`smoke-tenant-publication.mjs` 只创建合成视频引用的专用测试剧：
空剧拒绝、直接发布、幂等、版本冲突、总部越权拒绝、下架、更换媒体、
定时上架取消；最后软删除测试剧（可恢复），验证原有全部剧的状态和版本未改变。

```sh
node deploy/test-server/smoke-tenant-publication.mjs /private/access.private.json --candidate
PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node deploy/test-server/smoke-tenant-publication.mjs /private/access.private.json --browser
node deploy/test-server/smoke-ip.mjs /private/access.private.json
```

候选模式使用 SSH 转发到本机 13291/13292 的独立 admin/agent 候选 API；
正式测试入口使用公网 IP HTTPS 且验证证书。脚本引用当前测试库合成剧和封面，
不是通用生产数据初始化脚本。
