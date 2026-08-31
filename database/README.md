# PostgreSQL 数据库迁移

本目录是新短剧 SaaS 的 PostgreSQL 建库基线，不导入旧系统的用户、订单、密钥或运行数据。迁移目前覆盖租户、域名、平台/商家员工、RBAC、会话、审计、短剧内容、媒体、授权、审核、导入、终端用户/观看、商品价格、订单、Stripe 支付与回调、积分账户、权益、商家结算账本、一级邀请佣金应付账、后台全额退款、通知与真实邮箱/短信投递、法律文档与隐私擦除、真实运营统计查询索引、HTTP 命令幂等和事务 Outbox。

## 运行要求

- PostgreSQL 14 或更高版本。
- 执行迁移的账号需要在目标数据库中拥有 `CREATE` 权限，并可创建 `citext`、`pgcrypto` 扩展。
- 业务主键由应用生成 UUIDv7；SQL 不使用 `gen_random_uuid()` 默认值，以免无意生成 UUIDv4。
- 状态、作用域和类型等稳定枚举在数据库中保存为小写英文值，例如 `active`、`tenant`。

## 执行迁移

文件名数字即执行顺序。每个文件自身包含事务，并使用 `IF NOT EXISTS` 或先移除同名策略/触发器的方式支持重复执行。

```bash
for migration in database/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done
```

不要并行执行迁移。上线后仍应由迁移工具记录已经执行的文件和校验和；这里的可重复执行用于初始化、灾备演练和开发环境恢复，不替代迁移版本记录。

每次发布在迁移完成后同步权限目录。该命令可重复执行，会为已有的平台超级管理员和商家所有者补上新增权限，并移除这两类系统角色中作用域错误的授权：

```bash
pnpm permissions:sync
```

## RLS 使用方式

`0005_tenant_rls.sql`、`0008_content_rls.sql`、`0009_customer_playback_domain.sql`、`0012_commerce_catalog_orders_entitlements.sql`、`0013_payment_core.sql`、`0014_settlements_withdrawals.sql`、`0015_point_content_unlocks.sql`、`0018_direct_referral_commissions.sql` 和 `0020_admin_full_refunds.sql` 对直接包含租户范围或由父资源继承租户范围的表启用 RLS。除域名预解析涉及的两张基础表外，内容域、客户观看域、交易/支付/财务/一级分销域和 Outbox 表均强制 RLS。普通业务事务必须在执行任何租户 SQL 前设置可信租户上下文：

```sql
BEGIN;
SET LOCAL app.tenant_id = '018f2f45-7f5e-7e70-b17f-f6e77357c004';
SELECT * FROM tenant_staff;
COMMIT;
```

未设置 `app.tenant_id` 时，租户策略不返回任何行，也不允许写入。`tenant_id` 只能来自已验证域名或可信令牌，禁止采用客户端表单字段。连接池必须使用事务级 `SET LOCAL`，不能用会泄漏到下一请求的会话级 `SET`。

RLS 不是数据库账号隔离的替代品。生产建议至少区分：

- 迁移所有者：拥有表，不用于应用运行。
- 租户业务账号：无 `BYPASSRLS`，只获得所需表和序列权限。
- 平台 API 账号：在 `app.database_access_principals` 中登记，策略才允许读取平台行和显式的跨租户操作；不供用户/商家 API 使用。
- 域名解析账号：只能执行 `app.resolve_tenant_by_host(text)`，不能直接查询域名表。
- 迁移/应急维护账号：数据库管理员单独保管，不供任何在线 API 使用。

由于域名解析发生在租户上下文建立之前，应用必须调用安全定义者函数 `app.resolve_tenant_by_host(text)`，它只返回已验证、未停用域名对应的租户 ID 和状态。`tenants`、`tenant_domains` 保持 RLS，但不使用 `FORCE ROW LEVEL SECURITY`，让该函数的表所有者权限可以完成解析；生产业务账号绝不能拥有表。解析账号不要与普通租户请求连接复用。

示例角色需由有集群权限的数据库管理员按实际名称创建，故不放入可移植迁移：

```sql
CREATE ROLE saas_tenant_api LOGIN PASSWORD 'replace-with-secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE saas_platform_api LOGIN PASSWORD 'replace-with-secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE saas_tenant_resolver LOGIN PASSWORD 'replace-with-secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

INSERT INTO app.database_access_principals (role_name, access_scope)
VALUES ('saas_platform_api', 'platform')
ON CONFLICT (role_name) DO UPDATE SET access_scope = EXCLUDED.access_scope;

GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_host(text) TO saas_tenant_resolver;
```

`app.has_platform_access(current_user)` 根据数据库有效角色而非请求参数判定平台权限。平台员工、平台角色和平台审计行不对租户账号开放。平台后台必须使用独立连接池；不能通过客户端传入 `scope=platform` 或仅设置普通自定义 GUC 获得平台权限。平台 API 的跨租户操作还必须在应用层经过 RBAC 和审计。

## 约束与操作约定

- `tenants.status` 允许 `active`、`suspended`、`expired`，与 API 当前映射一致。
- `tenant_domains.disabled_at` 非空表示域名停用；只有已验证且未停用的域名可用于解析。
- 同一租户最多一个主域名，全平台域名唯一。
- `tenant_status_history` 和 `audit_logs` 是追加表，数据库拒绝更新和删除。
- `role_permissions` 与 `subject_roles` 通过触发器校验角色、主体和租户作用域一致。
- `auth_sessions` 只保存 access/refresh token 哈希，原始 token 不入库；`absolute_expires_at` 强制不超过首次签发后 30 天，滑动刷新不得突破该期限；`auth_refresh_token_history` 保存已轮换 refresh 摘要用于重放检测，命中异常重放时撤销整个会话族；撤销时同时写入 `revoked_at` 和 `revoked_reason`。
- `dramas`、`media_assets`、分类和标签使用 `owner_type + owner_tenant_id` 明确区分平台公共资源与商家私有资源；平台资源不能用空租户字段伪装成普通商家数据。
- 商家只能写自己的内容。商家读取平台短剧和对应媒体前，必须命中有效的 `content_license_items` 授权快照；授权起止时间由数据库实时判断，避免调度延迟越权播放。
- `media_assets.transcode_status` 支持 `not_required/queued/processing/ready/failed`。当前不转码的原始视频使用 `not_required`，不代表未来不能接入独立转码 Worker。外链媒体只有在隔离采集后写入 checksum 并标记 `metadata_json.immutable=true` 才能进入 `ready`；自有对象存储不受此限制。单部短剧的 `episode_no` 硬限制为 1–1000。
- 定时发布和下架写入 `content_schedule_jobs`；任务包含可用时间、最大尝试次数和 Worker 锁，失败可进入 `retry` 延迟重试，崩溃锁可按 `locked_at` 回收。软删除对象保存恢复期限，并由只追加的 `content_deletion_history` 保证一次删除事件最多恢复一次。
- 内容审核使用不可变 `content_versions` 快照、`review_requests` 当前状态和只追加 `review_request_actions` 决策历史；已登记的平台数据库角色可跨租户审核。
- `0026` 将批量导入收口为 1 MiB 内的内联 JSON 或 RFC4180 CSV（每任务最多 200 部剧、1000 集），由独立 Worker 以 `FOR UPDATE SKIP LOCKED` 异步预检并落库；只接受元数据和商家自有、已就绪 S3 媒体 UUID，不下载外链。旧 `xlsx/file_id` 字段仅为未上线基线的迁移兼容保留，当前 API 不开放 XLSX 或远程采集。`content_import_rows` 的导入结果绑定同租户短剧且成功后不可换绑。
- `0027` 为剧集增加可选的独立 `preview_media_asset_id`；试看媒体必须与正片不同、与剧集严格同作用域，且是位于活跃 S3 provider 上的已就绪内部视频。提审、平台发布和定时发布会重新检查封面、正片与试看媒体；终端签发只使用独立试看资产，未配置时不回退到正片。
- 商家内容 JSON/CSV 导出不包含媒体 URL、对象键、校验和或存储凭据；导出前拒绝缺封面/翻译的不可回导草稿，并限制 500 部剧、5000 集和 20 MiB。CSV 使用 UTF-8 BOM、RFC4180 引号和可逆的表格公式转义。外链媒体登记接口固定返回 `410 EXTERNAL_MEDIA_INGESTION_UNAVAILABLE`，新媒体必须走商家 S3 直传。
- `outbox_events` 按作用域保证事件键和幂等键唯一，支持重试、可用时间、锁定和死信状态；`outbox_consumptions` 以事件、消费者和幂等键防止重复消费。
- `command_idempotency` 以作用域、租户、操作人、路由和客户端幂等键去重 HTTP 命令；相同键只能重放相同 `request_hash`，`processing` 行必须持有可回收的 `locked_at`。
- 终端客户使用独立的 `customer_accounts/customer_sessions`，不与平台或商家员工会话混用。设备标识是服务端随机 token 的摘要；每个账号最多保留 3 个活跃设备，新设备会撤销最旧设备及会话。
- OTP 挑战只保存目标和验证码的 HMAC，不保存明码。启用万能码 `8888` 必须显式设置 `CUSTOMER_UNIVERSAL_OTP_ENABLED=true`；生产环境还必须同时设置 `ALLOW_INSECURE_OTP=true`，否则应用拒绝启动。生产环境必须提供至少 32 字节的 `CUSTOMER_OTP_HMAC_SECRET`，万能码命中会写入租户审计日志。
- `watch_progress` 只允许已发布且当前有权的剧集，数据库触发器会防止进度超过剧集时长；`customer_favorites` 在租户、账号和短剧维度唯一。系统不提供下载 token 或离线接口。
- 交易金额使用 `bigint` 最小货币单位，只允许 CNY/USD/EUR/JPY/KRW；待支付订单的客户、商品、币种和金额快照不可更改。订单只能在数据库固定事务时间仍早于 `expires_at` 时转为已支付，迟到成功回调只进异常对账，不发权益或积分。
- 支付可选平台代收 `platform_collect` 或商家直收 `tenant_direct`；仅平台代收成功款进入商家待结算账本。`payment_transactions`、积分流水和商家余额流水不可变；外部事件 ID、渠道交易 ID 和权益来源均幂等，重复回调不重复入账。
- `payment_configs` 只保存可公开路由元数据，密文凭据单独存在 `payment_config_secrets`；租户 RLS 不能读平台凭据。配置停用只禁止新支付尝试，已创建尝试仍可依据固化的 provider/config/adapter 快照完成回调或全额退款。Fake adapter 只允许非生产测试；`0028` 已接入官方 Stripe SDK 的 Hosted Checkout，严格区分 test/live、平台代收/商家直收和配置版本，Webhook 使用原始请求体验签并按事件与载荷哈希幂等。
- `0018` 仅记录一级直接邀请佣金。佣金按订单币种分账，使用 `floor(total_minor * bps / 10000)` 取整，结果为 0 不建虚假余额。`pending/available/withdrawn` 是邀请人的佣金应付账，不是平台商户可提现资金；首版不提供佣金提现，但已支付订单成功全额退款会以反向流水冲正未提取佣金。邀请关系和佣金事实表对租户数据库角色仅可读，写入仅走平台受控事务。
- `0020` 只支持后台人工全额退款：商家直收由商家权限发起，平台代收由平台财务权限发起，不接受客户端金额或币种。渠道调用在数据库事务外；`processing` 使用固定 provider 幂等键可恢复重试，模糊超时不伪造失败。成功时同一事务撤销权益或回收未消费积分、冲减平台代收商户余额并冲正未提取佣金；商户余额不足时订单仍记录渠道成功退款，同时进入 `manual_reconciliation`，绝不造负余额。客户自助退款、部分退款和真实银行/渠道 adapter 留待后续。
- `0021` 只增加真实事实表的日期/状态查询索引，不建伪造的预聚合表。运营统计默认近 7 个本地日，最多 90 日；租户按 `tenants.timezone` 切日，平台默认 UTC 并只接受有效 IANA 时区。`gross` 保留后续已退款订单的原始支付金额，`refund` 按成功退款时间单列，`net=gross-refund`；所有金额按币种分组并以十进制字符串返回，不做隐含汇率换算。当前没有可靠的 presence/heartbeat 事件，API 明确不返回“在线人数”。
- `0029` 保存租户发布的隐私政策、服务条款及客户精确版本同意记录；注册必须在同一事务核验当前必选版本。隐私导出需客户密码确认且不缓存；擦除申请会立即锁定账号并由独立 Worker 分步骤、可恢复地完成不可逆去标识。订单、支付、退款和安全审计等依法需要留存的事实仅保留随机主体关联和留存原因，不保留可直接识别的联系方式；完成状态不代表第三方系统已经自动删除。
- `0030` 保存平台管理的商家原生应用构建资料与不可变任务快照；只允许 Android 调试 APK 和 iOS 模拟器内部测试目标。构建资料、任务和产物位置仅平台数据库角色可见。应用图标/启动图必须经平台专用上传接口实际下载解码，图标强制为 1024×1024、无透明通道的 PNG；Worker 构建前还会按 checksum 重新下载校验。任务产物只能落在 active 的平台 S3 provider，普通任务响应不返回 bucket/object key，下载需独立权限并签发短时 no-store URL。构建机以 `app_build_worker_heartbeats` 公布真实工具链能力和平台产物存储；心跳超过 30 秒或存储停用时不得新建/领取任务，Android-only Worker 也不得领取 iOS 任务。
- 平台代收款按支付时固化的结算日期从 `pending` 双腿转入 `available`，每个业务引用、流水类型和余额桶只能写入一条账本腿。提现提交会原子冻结可用余额；取消或驳回原子解冻；确认线下打款必须绑定已就绪的凭证媒体和银行流水号。系统不调用真实银行接口。
- 提现收款账户只以 AES-256-GCM 密文保存，密钥由 `FINANCE_PAYOUT_MASTER_KEYS` 注入并支持版本轮换。商家和普通平台详情仅返回指纹；完整账户只能通过独立的 `finance.withdrawal.payout_account.read` 权限端点短时读取，且每次读取写审计。
- 支付尝试、支付交易、回调事实、退款事实、积分账户/流水、权益、商户余额和已支付订单对租户数据库角色均为只读。客户下单只允许新增 `pending_payment` 快照及其明细；支付入账、权益发放和资金流水必须走已登记平台数据库角色下的受控领域服务。
- `point_ledger` 是只追加流水，会在锁定积分账户后计算且写入新余额，并拒绝负数/溢出；禁止为新积分账户注入初始余额或直接修改余额。
- `content_point_prices` 由商家按整剧或单集配置积分价格。积分解锁必须重新锁定租户、客户、内容、公共授权、价格和积分账户；`point_unlocks` 固化价格版本与扣点快照，扣点流水和权益必须在同一事务内同时存在。有效会员或已有整剧/单集权益不会再次扣点，整剧权益覆盖其单集。
- 平台公共存储配置可能含密文凭据。生产授权应结合列级 `GRANT` 和 API 脱敏，商家接口不得返回 `credential_ciphertext`。
- `updated_at` 由触发器维护；`version` 由应用在带旧版本条件的更新中显式递增，避免双重递增。

## 快速核验

迁移后可检查表、RLS 和策略：

```sql
SELECT
  relation.relname AS tablename,
  relation.relrowsecurity AS rowsecurity,
  relation.relforcerowsecurity AS forcerowsecurity
FROM pg_class AS relation
INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
ORDER BY relation.relname;

SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```
