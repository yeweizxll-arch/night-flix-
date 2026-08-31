# 短剧 SaaS 后端领域设计

> 状态：可作为后端拆分、建库和接口设计的基线。  
> 范围：总后台、商家后台、H5/Android/iOS 共用后端；不沿用旧包中的授权、采集、用户、订单与支付实现。

## 1. 设计结论

- 采用**共享应用、共享数据库、行级租户隔离**。20～30 个商家不需要独立部署；所有商家业务数据以不可为空的 `tenant_id` 隔离。
- 总后台是平台域，商家后台和用户端是租户域。平台公共内容、公共支付账户等资源明确标注为平台所有，不能通过省略 `tenant_id` 来表达“公共”。
- 业务主键统一使用 UUIDv7/ULID；对外只暴露该主键，不暴露连续自增 ID。
- 金额统一保存为最小货币单位整数 `amount_minor bigint`，同时保存 ISO 4217 `currency char(3)`；订单生成后不得换算或修改币种、金额。
- 时间统一以 UTC 保存，API 使用 RFC 3339；商家设置自己的 `timezone` 用于报表、营销活动和内容定时。
- 用户、订单、会员、积分、历史、收藏均不跨商家。相同手机号或邮箱可以在不同商家重复注册。
- 视频源文件与播放流量走对象存储/CDN；业务 API 不代理视频字节。峰值一万人同时在线依靠 CDN，不靠后端实例直接传输。
- 所有关键写操作具备幂等、审计和状态机校验；支付回调、提现、人工退款、授权、审核不能用直接更新状态代替领域命令。

## 2. 通用数据约定

除纯关联表外，核心表包含：

```text
id               uuid/ulid primary key
tenant_id        uuid not null（租户表）
version          int not null default 0（乐观锁）
created_at       timestamptz not null
created_by       uuid null
updated_at       timestamptz not null
updated_by       uuid null
deleted_at       timestamptz null（仅允许软删除的对象）
```

约束：

- `tenant_id` 不接受客户端表单参数，由域名解析结果、登录令牌或后台操作上下文注入。
- 业务唯一索引必须带 `tenant_id`，例如用户邮箱为 `unique(tenant_id, normalized_email)`。
- 状态、类型、渠道等字段在代码中使用稳定枚举值，数据库可加 `check` 约束；前端显示文案不得充当状态值。
- 机密配置仅保存密文及密钥版本，例如 `secret_ciphertext`、`key_version`；日志、导出和 API 返回值不得回显。
- PII 同时保存规范化检索值和展示值；需要删除账户时，展示值匿名化，检索值替换为不可逆随机标识。
- JSON 只用于渠道扩展参数、快照等非强查询字段；金额、状态、外键和关键查询条件必须是独立列。

## 3. 模块边界

初期可部署为模块化单体，模块之间只通过应用服务/领域事件调用，不允许跨模块直接写表。增长后可独立拆出支付、消息、统计和构建服务。

| 模块 | 负责 | 不负责/边界 |
|---|---|---|
| 租户与域名 | 商家生命周期、套餐有效期、子域名、自定义域名、品牌、语言/币种配置 | 不管理商家员工权限和用户登录 |
| 身份与访问 | 平台员工、商家员工、终端用户、登录、设备、会话、验证码、RBAC | 不保存会员权益和余额 |
| 内容目录 | 公共/私有短剧、剧集、分类、标签、多语言元数据、推荐位 | 不处理对象存储上传字节与审核决定 |
| 媒体 | 上传凭证、文件记录、播放源、CDN 地址签名、封面 | 不做自动转码、截图、水印和离线下载 |
| 授权与审核 | 公共内容授权、授权到期、内容版本审核、举报处置 | 不直接修改支付与订单 |
| 商品与权益 | 会员计划、积分包、整剧/单集商品、试看规则、用户权益 | 不接收第三方支付回调 |
| 交易订单 | 统一业务订单、订单项、优惠计算、订单关闭 | 支付渠道细节由支付模块处理 |
| 支付 | 支付账户、渠道适配、支付尝试、回调、对账、后台人工退款 | 不决定内容授权或会员策略 |
| 账本与提现 | 平台代收产生的商家可提现余额、不可变账本、提现审核 | 商家自有支付账户直收不进入平台可提现余额 |
| 营销 | 优惠券、兑换码、卡密、限时优惠、新人活动 | 不自行写订单最终金额，只提供可验证的折扣结果 |
| 互动与观看 | 播放进度、历史、收藏、点赞、关注、评论、弹幕、举报 | 不代理视频流量 |
| 消息与推送 | 站内信、短信、邮件、移动推送、群发、退订、频控 | 不拥有商家支付和内容配置 |
| 工单客服 | 工单、回复、指派、状态、商家联系方式 | 不处理退款申请；用户端无退款入口 |
| 白标与发布 | 品牌资产、构建配置、安装包、热更新版本、灰度和回滚 | 原生能力变更必须发整包，不通过热更新绕过商店审核 |
| 审计与统计 | 审计日志、导出任务、指标事实表、看板查询 | 统计数据只读，不反写交易事实 |

## 4. 核心表清单与关键字段

以下为第一版必须具备的逻辑表。实际命名可统一加项目前缀，但字段语义不得改变。

### 4.1 租户、域名与配置

| 表 | 关键字段与约束 |
|---|---|
| `tenants` | `id`、`code unique`、`name`、`status`(`ACTIVE/SUSPENDED/EXPIRED`)、`expires_at`、`default_locale`、`timezone`、`default_currency`、`user_site_enabled`；到期后商家后台只读、用户站暂停 |
| `tenant_domains` | `tenant_id`、`host unique`、`type`(`SUBDOMAIN/CUSTOM`)、`verification_token`、`verified_at`、`tls_status`、`is_primary`；同一租户只允许一个主域名 |
| `tenant_branding` | `tenant_id unique`、`brand_name`、`logo_file_id`、`icon_file_id`、`splash_file_id`、`theme_json`、`support_*` |
| `tenant_locales` | `tenant_id`、`locale`、`enabled`、`is_default`；首期支持 `zh-CN/zh-TW/en-US/fr-FR/ja-JP/ko-KR` |
| `tenant_currencies` | `tenant_id`、`currency`、`enabled`、`is_default`；不保存自动汇率 |
| `tenant_settings` | `tenant_id`、`setting_key`、`value_json`、`is_secret`；键名白名单，不允许任意运行时代码 |
| `tenant_status_history` | `tenant_id`、`from_status`、`to_status`、`reason`、`effective_at`、`operator_id` |

### 4.2 身份、认证、设备与 RBAC

| 表 | 关键字段与约束 |
|---|---|
| `platform_staff` | `id`、`username unique`、`email`、`phone`、`password_hash`、`status`、`mfa_enabled` |
| `tenant_staff` | `tenant_id`、`username`、`email`、`phone`、`password_hash`、`status`；`unique(tenant_id, username)` |
| `users` | `tenant_id`、`username`、`normalized_email`、`normalized_phone`、`password_hash`、`status`、`preferred_locale`、`deleted_at`；三类登录标识分别按租户唯一 |
| `external_identities` | `tenant_id`、`user_id`、`provider`、`provider_subject`；用于微信等身份绑定，不作为强制主登录 |
| `user_devices` | `tenant_id`、`user_id`、`device_id_hash`、`platform`、`push_token_ciphertext`、`last_seen_at`、`revoked_at`；一个用户最多 3 个有效设备 |
| `auth_sessions` | `tenant_id`、`subject_type`、`subject_id`、`device_id`、`refresh_token_hash`、`issued_at`、`expires_at`、`revoked_at`；第 4 台登录事务内撤销最早会话 |
| `verification_challenges` | `tenant_id`、`purpose`、`channel`、`target_hash`、`code_hash`、`attempts`、`expires_at`、`consumed_at`、`test_bypass_used` |
| `test_verification_allowlist` | `tenant_id nullable`、`target_type`、`target_hash`、`enabled`、`expires_at`、`reason`；万能码 `8888` 只能命中启用且未过期的白名单，并记录审计 |
| `roles` | `scope_type`(`PLATFORM/TENANT`)、`tenant_id nullable`、`name`、`status`；平台角色 `tenant_id` 必须为空，商家角色必须有值 |
| `permissions` | `code unique`、`module`、`action`、`description`；系统定义、不可由后台创建任意代码 |
| `role_permissions` | `role_id`、`permission_id`、`data_scope`(`ALL/OWN/ASSIGNED`)；联合唯一 |
| `subject_roles` | `scope_type`、`tenant_id nullable`、`subject_type`、`subject_id`、`role_id`；校验角色与主体作用域一致 |

### 4.3 内容、媒体、多语言、授权与审核

| 表 | 关键字段与约束 |
|---|---|
| `dramas` | `owner_type`(`PLATFORM/TENANT`)、`owner_tenant_id nullable`、`status`、`release_at`、`cover_file_id`、`category_id`、`total_episodes`、`source_type`；公共内容必须为平台所有，私有内容必须有租户 |
| `drama_translations` | `drama_id`、`locale`、`title`、`summary`、`search_keywords`；`unique(drama_id, locale)`，缺失时回退商家默认语言 |
| `episodes` | `drama_id`、`episode_no`、`status`、`release_at`、`duration_seconds`、`media_asset_id`、`preview_seconds`；`unique(drama_id, episode_no)` |
| `episode_translations` | `episode_id`、`locale`、`title`；联合唯一 |
| `categories` / `category_translations` | 分类所有者、排序、状态及各语言名称；商家只能使用平台允许分类或自己的分类 |
| `tags` / `drama_tags` | 标签所有者、翻译或稳定代码、剧目关联 |
| `media_assets` | `owner_type`、`owner_tenant_id`、`kind`(`VIDEO/IMAGE/FILE`)、`storage_provider_id`、`object_key`、`source_url`、`mime_type`、`size_bytes`、`checksum`、`status`；视频文件与外部 URL 二选一 |
| `storage_providers` | `owner_type`、`owner_tenant_id`、`provider`、`endpoint`、`bucket`、`credential_ciphertext`、`cdn_base_url`、`status`；支持平台公共和商家自有存储 |
| `content_licenses` | `tenant_id`、`license_type`(`DRAMA/PACKAGE`)、`drama_id/package_id`、`starts_at`、`expires_at`、`status`、`granted_by`；到期自动停止商家侧展示 |
| `content_license_packages` / `content_license_package_items` | 授权包、包含剧目、状态；授权快照应记录签约时包含项，避免包后改影响历史授权 |
| `content_versions` | `tenant_id`、`aggregate_type`、`aggregate_id`、`version_no`、`snapshot_json`、`change_level`(`MINOR/CRITICAL`)、`created_by` |
| `review_requests` | `tenant_id`、`target_type`、`target_id`、`content_version_id`、`status`、`submitted_at`、`reviewed_at`、`reviewer_id`、`reason` |
| `recommendation_slots` / `recommendation_items` | `tenant_id`、`slot_code`、`locale`、`starts_at`、`ends_at`、`rank`、`target_type/id`；支持人工推荐、热门/分类榜单 |
| `content_import_jobs` / `content_import_rows` | `tenant_id`、`file_id`、`format`、`status`、`summary_json`；逐行记录校验错误，可预览后确认导入，不接旧远程采集器 |

### 4.4 商品、会员、积分、订单与权益

| 表 | 关键字段与约束 |
|---|---|
| `products` | `tenant_id`、`type`(`MEMBERSHIP/POINTS/DRAMA/EPISODE`)、`target_id`、`status`、`sale_starts_at`、`sale_ends_at` |
| `product_translations` | `product_id`、`locale`、`name`、`description` |
| `product_prices` | `tenant_id`、`product_id`、`currency`、`amount_minor`、`member_amount_minor nullable`；每币种手工定价，联合唯一 |
| `membership_plans` | `tenant_id`、`duration_days`、`benefit_json`、`status`；权益应由受控 schema 校验 |
| `trade_orders` | `tenant_id`、`order_no unique`、`user_id`、`status`、`currency`、`subtotal_minor`、`discount_minor`、`payable_minor`、`paid_minor`、`expires_at`、`price_snapshot_json` |
| `trade_order_items` | `tenant_id`、`order_id`、`product_type`、`product_id`、`target_id`、`quantity`、`unit_amount_minor`、`discount_minor`、`final_amount_minor`、`snapshot_json` |
| `user_entitlements` | `tenant_id`、`user_id`、`type`(`MEMBERSHIP/DRAMA/EPISODE`)、`target_id`、`source_order_item_id`、`starts_at`、`expires_at`、`status`；联合索引用于播放鉴权 |
| `point_accounts` | `tenant_id`、`user_id unique per tenant`、`balance`、`version` |
| `point_ledger_entries` | `tenant_id`、`account_id`、`direction`、`amount`、`balance_after`、`reason_type`、`reference_id`、`idempotency_key`；只追加不可更新 |

### 4.5 支付、退款、账本与提现

| 表 | 关键字段与约束 |
|---|---|
| `payment_accounts` | `owner_type`(`PLATFORM/TENANT`)、`owner_tenant_id nullable`、`provider`、`account_label`、`supported_currencies`、`config_ciphertext`、`status`；商家和平台公共账户分开 |
| `tenant_payment_routes` | `tenant_id`、`currency`、`provider`、`payment_account_id`、`settlement_mode`(`DIRECT_MERCHANT/PLATFORM_COLLECTED`)、`priority`、`enabled` |
| `payment_orders` | `tenant_id`、`payment_no unique`、`trade_order_id`、`user_id`、`amount_minor`、`currency`、`status`、`settlement_mode`、`payment_account_id`、`expires_at`、`succeeded_at` |
| `payment_attempts` | `tenant_id`、`payment_order_id`、`provider`、`channel`、`provider_request_id`、`status`、`request_snapshot_json`、`failure_code`；一次业务支付可多次拉起，但只能成功一次 |
| `payment_transactions` | `tenant_id`、`payment_order_id`、`attempt_id`、`provider_transaction_id`、`type`(`CHARGE/REFUND`)、`amount_minor`、`currency`、`occurred_at`；渠道交易号联合唯一 |
| `payment_callbacks` | `provider`、`payment_account_id`、`provider_event_id`、`payload_hash`、`signature_valid`、`processing_status`、`received_at`、`processed_at`；原始载荷加密/脱敏，事件号或载荷哈希唯一幂等 |
| `refunds` | `tenant_id`、`refund_no unique`、`payment_order_id`、`amount_minor`、`reason`、`status`、`requested_by`、`provider_refund_id`、`completed_at`；只允许后台创建 |
| `merchant_wallets` | `tenant_id`、`currency`、`available_minor`、`frozen_minor`、`version`；仅平台代收资金产生余额 |
| `merchant_wallet_entries` | `tenant_id`、`wallet_id`、`direction`、`amount_minor`、`available_after`、`frozen_after`、`entry_type`、`reference_type/id`、`idempotency_key`；不可变复式/双边校验账本 |
| `withdrawals` | `tenant_id`、`withdrawal_no unique`、`currency`、`amount_minor`、`fee_minor`、`status`、`payout_account_snapshot_ciphertext`、`submitted_at`、`completed_at` |
| `withdrawal_actions` | `withdrawal_id`、`from_status`、`to_status`、`operator_id`、`reason`、`proof_file_id`、`created_at`；审核、打款凭证和失败原因完整留痕 |

### 4.6 营销、互动、消息与客服

| 表 | 关键字段与约束 |
|---|---|
| `promotions` / `promotion_translations` | `tenant_id`、类型、新人条件、适用商品、时间、叠加规则、各语言文案 |
| `coupons` / `user_coupons` | 优惠规则、发行量、每人次数、领取/使用/过期状态、关联订单；核销必须随订单事务锁定 |
| `redeem_code_batches` / `redeem_codes` | 批次用途(`MEMBERSHIP/POINTS/COUPON`)、码哈希、有效期、使用次数、核销用户/时间；明文码仅生成时导出一次 |
| `watch_progress` | `tenant_id`、`user_id`、`drama_id`、`episode_id`、`position_seconds`、`duration_seconds`、`updated_at`；同租户跨端同步 |
| `favorites` / `drama_follows` / `content_likes` | `tenant_id`、`user_id`、目标、创建时间；联合唯一防重复 |
| `comments` | `tenant_id`、`drama_id`、`episode_id nullable`、`user_id`、`parent_id nullable`、`root_id`、`body`、`status`、`like_count`；只允许一级回复，回复的 `parent_id` 必须指向根评论 |
| `danmaku` | `tenant_id`、`episode_id`、`user_id`、`position_ms`、`body`、`status` |
| `sensitive_terms` | `scope_type`、`tenant_id nullable`、`term`、`match_type`、`replacement`、`enabled`；平台词库叠加商家词库 |
| `reports` | `tenant_id`、`reporter_user_id`、`target_type/id`、`reason_code`、`detail`、`status`、`handled_by`、`resolution` |
| `message_templates` / `message_template_translations` | `tenant_id`、事件代码、渠道、各语言标题/正文、启用状态 |
| `inbox_messages` | `tenant_id`、`recipient_type/id`、`type`、`title`、`body`、`payload_json`、`read_at`、`expires_at` |
| `notification_jobs` / `notification_deliveries` | `tenant_id`、渠道、受众条件、计划时间、频控键、送达状态、失败原因、供应商消息号 |
| `notification_preferences` | `tenant_id`、`user_id`、渠道/主题订阅状态；营销通知必须可退订，交易通知单列 |
| `communication_providers` | `tenant_id`、`type`(`SMS/EMAIL/PUSH`)、`provider`、`config_ciphertext`、`status`；不配置则对应功能禁用，无平台公共回退 |
| `support_tickets` / `support_ticket_messages` | `tenant_id`、用户、主题、优先级、状态、指派商家员工、消息发送者、附件；平台员工可监督/介入 |

### 4.7 白标、热更新、审计、导出与统计

| 表 | 关键字段与约束 |
|---|---|
| `app_build_profiles` | `tenant_id`、`platform`、`bundle_id/package_name`、品牌资产版本、签名/证书引用、环境配置；证书仅总后台服务可解密 |
| `app_builds` | `tenant_id`、`platform`、`version_name`、`version_code`、`status`、`artifact_file_id`、`requested_by`、`build_log_file_id`、`completed_at` |
| `hot_update_releases` | `tenant_id`、`platform`、`base_native_version`、`resource_version`、`mode`(`OPTIONAL/FORCED/STAGED`)、`rollout_percent`、`package_file_id`、`checksum`、`status`、`rollback_to_id` |
| `audit_logs` | `scope_type`、`tenant_id nullable`、`actor_type/id`、`action`、`resource_type/id`、`before_json`、`after_json`、`ip`、`user_agent`、`request_id`；追加写，敏感值脱敏 |
| `export_jobs` | `scope_type`、`tenant_id nullable`、`requested_by`、`export_type`、`filter_json`、`status`、`file_id`、`expires_at`；按权限二次校验并记录下载 |
| `daily_tenant_metrics` | `tenant_id`、`metric_date`、注册/活跃/播放/订单/收入/退款等聚合值；只由事件/定时任务生成 |

## 5. Tenant 隔离规则

### 5.1 请求上下文

1. 网关仅从规范化后的 `Host` 查询 `tenant_domains.host`，生成 `TenantContext`。
2. 用户端 JWT 必须包含 `tenant_id`、`subject_id`、`session_id`、`token_version`；令牌中的租户必须与域名租户一致。
3. 商家后台 JWT 必须包含 `tenant_id`，只能访问该商家；总后台令牌不伪装成商家令牌。
4. 总后台跨租户查看必须调用单独的 `/platform-api` 用例，明确传目标 `tenant_id` 并写审计日志。
5. 支付 webhook 不依赖请求域名确定租户，必须通过已登记的 `payment_account_id/app_id/merchant_id` 与渠道事件映射反查。

### 5.2 数据访问约束

- 租户 Repository 的所有方法必须要求 `TenantContext`；禁止 `findById(id)`，只允许 `findById(tenantId, id)` 或已绑定租户的仓储实例。
- 插入时由服务端填充 `tenant_id`；更新和删除 SQL 同时匹配 `id` 与 `tenant_id`。
- 关联表冗余保存 `tenant_id`，并通过复合外键或写入校验确保父子租户一致。
- 缓存键、对象存储路径、队列消息、分布式锁、幂等键均带租户：`tenant:{tenant_id}:...`。
- 搜索索引、统计、导出、消息受众和日志查询均以租户作为第一过滤条件。
- 平台公共资源使用 `owner_type=PLATFORM`；不得用 `tenant_id IS NULL` 的普通查询自动混入商家数据。
- 生产环境禁止执行无租户条件的租户表批量更新。数据维护任务必须显式声明 `platform_maintenance=true` 并记录审计。

### 5.3 数据库防线与测试

- PostgreSQL：租户表开启 RLS，连接事务开始时写入 `app.tenant_id`；平台维护角色单独授权且不供业务 API 使用。
- MySQL：使用强制租户查询拦截器/基础仓储，并在 CI 运行 SQL 审查测试；禁止业务代码直接使用裸连接。
- 必须有跨租户集成测试：用租户 A 的令牌读取、修改、导出租户 B 的每类资源均返回 404，不暴露资源是否存在。
- 唯一约束、外键、幂等约束由数据库兜底，不能只依赖控制器校验。

## 6. RBAC 设计

### 6.1 两个作用域

- `PLATFORM`：总后台员工，典型角色为超级管理员、运营、内容审核、财务、客服、安全审计。
- `TENANT`：商家员工，角色由该商家自由配置，但可选权限来自系统权限目录。
- 两类角色和令牌不可混用。超级管理员也必须通过平台接口进入商家观察模式，不可持有无边界的商家会话。

### 6.2 权限命名

采用 `模块.资源.动作`：

```text
tenant.staff.read             tenant.staff.manage
content.drama.read            content.drama.create
content.drama.submit_review   content.drama.publish
commerce.order.read           commerce.order.export
payment.refund.create         payment.account.manage
wallet.withdraw.submit        wallet.withdraw.review
notification.campaign.send    build.release.create
audit.log.read                audit.export.download
```

接口进入时先验证 permission，再验证资源 `tenant_id`，最后验证 `data_scope`。字段级敏感信息另加权限，例如无 `payment.account.secret.manage` 时只显示掩码。

### 6.3 高风险操作

- 支付账户变更、人工退款、提现审核/确认打款、万能验证码白名单、构建证书、商家状态、角色权限修改必须写完整审计。
- 建议为平台高风险权限启用 MFA 与二次确认；审核人和申请人原则上分离。
- 商家过期后权限计算额外叠加 `READ_ONLY` 策略：允许登录、查询和导出，拒绝新增/修改/发布/群发；用户站返回暂停页。

## 7. 订单与支付适配

### 7.1 分层与交易流程

```text
商品/营销定价 -> TradeOrder（锁定价格快照）
              -> PaymentOrder（一次应付债务）
              -> PaymentAttempt（一次渠道拉起）
              -> PaymentTransaction（渠道资金事实）
              -> Entitlement/Points（权益发放）
```

1. 创建业务订单时校验商家、商品、币种、价格、营销规则，锁定 `price_snapshot_json`。
2. 根据 `tenant_payment_routes(tenant, currency, provider)` 选择支付账户和结算模式。
3. `DIRECT_MERCHANT` 使用商家账户，资金直达商家，不记平台可提现余额。
4. `PLATFORM_COLLECTED` 使用平台公共账户；支付成功后写商家钱包贷记，之后由商家申请提现。
5. 回调验签成功后，在单一数据库事务中锁定支付单、写交易事实、推进状态、更新业务订单，并投递 Outbox 事件。
6. 权益发放消费 `PaymentSucceeded` 事件，以 `order_item_id` 做幂等；失败可重试，不能重复发放。

### 7.2 支付适配器接口

每个渠道实现相同契约，首期为微信支付、支付宝、Stripe、PayPal、Apple IAP，后续第三方只新增适配器：

```text
validateConfig(accountConfig)
createPayment(paymentOrder, returnContext) -> PaymentInstruction
queryPayment(providerTransactionOrRequestId) -> ProviderPaymentStatus
verifyAndParseWebhook(headers, rawBody, account) -> ProviderEvent
createRefund(refund, paymentTransaction) -> ProviderRefundResult
queryRefund(providerRefundId) -> ProviderRefundStatus
verifyClientReceipt(receipt) -> VerifiedPurchase       # Apple IAP 等
```

适配器只转换渠道协议，不写业务表、不授予权益、不自行选择租户。统一服务负责状态机、事务、审计、重试和告警。

### 7.3 安全与幂等

- 创建订单接受 `Idempotency-Key`，唯一范围为 `tenant_id + user_id + endpoint + key`。
- webhook 必须使用原始请求体验签，按 `provider_event_id` 或稳定载荷哈希去重；无论重复多少次都返回相同处理结果。
- 支付成功金额、币种必须与支付单严格相等；异常进入待人工核对，不自动补差。
- 客户端传来的“支付成功”只触发查询，不能作为入账依据。
- 退款只能由有权限的后台人员发起，且累计退款金额不得超过实付；退款完成后按业务规则回收未消费权益并冲正平台代收账本。
- 支付密钥用 KMS/密钥封装加密，密钥轮换可追踪；日志仅保留渠道号、请求 ID 和脱敏摘要。
- 使用事务 Outbox 发布订单、支付、权益、通知事件，禁止数据库事务内直接调用推送或邮件供应商。

## 8. 状态机

### 8.1 内容审核与发布

```text
DRAFT -> PENDING_REVIEW -> APPROVED -> PUBLISHED -> UNPUBLISHED
                    \-> REJECTED -------> DRAFT
APPROVED -> PENDING_REVIEW（关键字段再次修改）
PUBLISHED -> PENDING_REVIEW（关键字段修改时线上继续展示上一已审核版本）
```

- 商家私有内容首次发布必须审核；标题、简介、封面、播放源、集数、价格/试看等关键字段修改形成新 `content_version` 并重新审核。
- 非关键字段可按配置立即生效，但仍写版本记录。
- 只有平台审核角色可执行 `APPROVE/REJECT`；商家可提交和撤回尚未处理的申请。
- 定时发布要求已审核且租户有效；授权内容还必须在授权期内。
- 自动敏感词过滤用于评论/弹幕直接发布；命中拒绝词或被举报后可转人工处置，不与内容上架审核混为一个状态机。

### 8.2 支付单

```text
CREATED -> PENDING -> SUCCEEDED
   |          |----> FAILED（本次尝试失败，支付单可再次尝试）
   |          \----> CLOSED（超时/主动关闭）
   \----------------> CLOSED
SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED
SUCCEEDED ----------------------> REFUNDED
```

- `SUCCEEDED` 是不可逆资金事实，不能改回 `PENDING/FAILED`。
- 渠道迟到成功回调若订单已关闭，进入支付异常队列，由系统查询确认后退款或人工处理。

### 8.3 提现

```text
SUBMITTED -> REVIEWING -> APPROVED -> PAYING -> PAID
     |           |           |          \-> FAILED -> PAYING
     |           |           \-> REJECTED
     |           \-> REJECTED
     \-> CANCELLED（仅审核开始前由商家撤回）
```

- `SUBMITTED` 时在同一事务内把余额从 `available` 冻结到 `frozen`。
- `REJECTED/CANCELLED` 解冻退回可用余额；`PAID` 扣减冻结余额并写出款账本。
- `APPROVED` 后由总后台人工线下转账；上传凭证、填写银行流水号后确认 `PAID`。
- `FAILED` 必须记录原因；重试打款前仍保持冻结。禁止直接编辑金额、币种、收款账户快照。
- 申请人不得审批自己的提现；所有迁移写 `withdrawal_actions` 和 `audit_logs`。

### 8.4 租户与授权

```text
租户：ACTIVE -> SUSPENDED -> ACTIVE
      ACTIVE -> EXPIRED   -> ACTIVE（续期）

授权：SCHEDULED -> ACTIVE -> EXPIRED
                 |-------> REVOKED
```

- 到期由定时任务推进状态，同时请求层根据 `expires_at` 实时兜底，避免调度延迟继续服务。
- 租户续期恢复后台写入和用户站；内容授权续期恢复授权内容，但仍需满足内容已发布条件。

## 9. API 版本与协议策略

### 9.1 路径与受众

```text
/api/v1/...                  H5、Android、iOS 用户端
/merchant-api/v1/...         商家后台
/platform-api/v1/...         总后台
/webhooks/payments/{provider}/{account_public_id}
/internal/v1/...             内部服务，禁止公网访问
```

- 三类后台/前台接口使用不同 audience 的访问令牌，不能互换。
- App/H5 共享业务 API；差异通过 capability 和响应字段表达，不复制一套移动 API。
- `/api/v1/config/bootstrap` 返回商家品牌、语言、币种、功能开关、支付方式与最低 App 版本，不返回机密配置。

### 9.2 兼容规则

- 主版本只在路径中体现。新增可选字段、枚举可识别的扩展值、可选查询参数属于兼容变更；删除/改名字段、改变语义或必填性必须升 `v2`。
- 服务端至少维护当前主版本和上一个主版本；废弃接口通过响应头 `Deprecation`、`Sunset` 和文档公告，给 App 留足升级周期。
- 响应字段使用稳定英文键，翻译只作用于展示值。枚举未知值客户端必须按 `UNKNOWN` 处理。
- 分页：后台列表使用游标分页；需要精确总数时显式请求。排序字段采用白名单，不能把客户端字段直接拼接到 SQL。
- 时间为 RFC 3339 UTC，金额传整数最小单位；大整数 ID/金额在 JSON 中必要时以字符串传输避免客户端精度丢失。

### 9.3 通用响应、错误与并发

```json
{
  "data": {},
  "request_id": "01...",
  "meta": {}
}
```

错误至少包含 `code`、`message`、`request_id`、可选的 `field_errors`。业务错误码保持稳定，例如：

```text
AUTH_SESSION_REVOKED
TENANT_EXPIRED
PERMISSION_DENIED
CONTENT_NOT_LICENSED
ORDER_PRICE_CHANGED
PAYMENT_AMOUNT_MISMATCH
WITHDRAWAL_BALANCE_INSUFFICIENT
VERSION_CONFLICT
```

- 更新接口使用 `version` 或 `If-Match` 乐观锁，冲突返回 HTTP 409。
- 创建订单、退款、提现、兑换、群发、导出等接口要求 `Idempotency-Key`。
- 限流维度包含 IP、租户、用户/员工、接口；登录/验证码、搜索、评论/弹幕、群发使用独立额度。
- OpenAPI 是接口契约源，按用户端/商家端/平台端拆分文档并在 CI 校验破坏性变更。

## 10. 领域事件与异步任务

建议第一版即定义以下事件，并通过 `outbox_events` 可靠投递：

```text
TenantExpired / TenantRenewed
ContentSubmitted / ContentApproved / ContentRejected / ContentLicenseExpired
OrderCreated / OrderExpired
PaymentSucceeded / PaymentExceptionDetected / RefundSucceeded
EntitlementGranted / EntitlementRevoked
WalletCredited / WithdrawalSubmitted / WithdrawalPaid
UserRegistered / UserDeleted / DeviceEvicted
CommentReported / TicketCreated
NotificationCampaignScheduled / AppReleasePublished
```

消费者按 `event_id + consumer_name` 幂等。定时任务至少包括订单关闭、租户/内容授权到期、优惠券过期、消息发送、群发频控、统计聚合、导出清理、支付/退款主动查询和账单对账。

## 11. 实施顺序与验收门槛

1. 建立租户上下文、数据库规范、RBAC、审计、Outbox 和跨租户自动化测试。
2. 完成租户/域名/品牌、员工、终端用户认证及三设备策略。
3. 完成内容、媒体、翻译、授权、审核和批量导入。
4. 完成商品、人工多币种定价、订单、权益和积分不可变账本。
5. 完成支付适配器、平台代收账本、提现、后台人工退款与对账。
6. 完成互动、消息/推送、客服、营销、白标构建和统计看板。

进入前端联调前必须通过：

- 两个租户间所有资源读取、写入、导出、缓存和对象存储路径的隔离测试。
- 重复支付回调、乱序回调、支付超时后成功、部分退款、重复提现提交等幂等测试。
- 商家到期只读/暂停与续期恢复测试；授权到期自动下架测试。
- 角色自由配置、字段脱敏、高风险审计和万能验证码白名单过期测试。
- 1 万同时观看场景下，视频全部命中 CDN；业务 API、签名 URL 服务与数据库分别做容量测试。

