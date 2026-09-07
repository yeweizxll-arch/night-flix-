# 后台显式按钮源码清单

这是 302 个显式按钮定义的静态绑定清单，不等于 302 个按钮已完成真实浏览器验收。Ant Design 自动生成的分页、选择器、日期及弹窗按钮不包含在该数量中。实际测试状态见同目录 admin-whitebox-20260907.md；绑定核对不能替代成功、失败、权限和易用性测试。

| 源码位置 | 文案或动态表达式 | 绑定方式 |
| --- | --- | --- |
| AdminApp.tsx:35 | 退出登录 | 点击处理函数 |
| AnalyticsDashboardPage.tsx:315 | 应用（最多 90 天） | 点击处理函数 |
| AnalyticsDashboardPage.tsx:316 | 刷新 | 点击处理函数 |
| AnalyticsDashboardPage.tsx:321 | 重试 | 点击处理函数 |
| AnalyticsDashboardPage.tsx:485 | 刷新 | 点击处理函数 |
| AnalyticsDashboardPage.tsx:487 | 重试 | 点击处理函数 |
| AnalyticsDashboardPage.tsx:502 | 上一页 | 点击处理函数 |
| AnalyticsDashboardPage.tsx:504 | 下一页 | 点击处理函数 |
| AuditLogPage.tsx:214 | 查询 | 表单提交 |
| AuditLogPage.tsx:215 | 重置 | 点击处理函数 |
| AuditLogPage.tsx:221 | 重试 | 点击处理函数 |
| AuditLogPage.tsx:286 | 详情 | 点击处理函数 |
| BatchEpisodeUploadModal.tsx:98 | 移除 | 点击处理函数 |
| BatchEpisodeUploadModal.tsx:103 | 上传并添加 / 重试未完成 | 点击处理函数 |
| BatchEpisodeUploadModal.tsx:104 | 暂停 | 点击处理函数 |
| BatchEpisodeUploadModal.tsx:105 | 完成并返回 | 点击处理函数 |
| CommerceCatalogPage.tsx:419 | {activeTab === 'membership' ? '创建会员套餐' : activeTab === 'points' ? '创建金币包' : activeTab === 'content'  | 点击处理函数 |
| CommerceCatalogPage.tsx:459 | 重试 | 点击处理函数 |
| CommerceCatalogPage.tsx:729 | 编辑文案 | 点击处理函数 |
| CommerceCatalogPage.tsx:730 | 设置价格 | 点击处理函数 |
| CommerceCatalogPage.tsx:735 | {record.status === 'active' ? '停用' : '启用'} | 确认或上传组件 |
| CommerceCatalogPage.tsx:781 | 编辑 | 点击处理函数 |
| CommerceCatalogPage.tsx:832 | 编辑 | 点击处理函数 |
| CommerceCatalogPage.tsx:925 | 删除 | 点击处理函数 |
| CommerceCatalogPage.tsx:928 | 添加语言 | 点击处理函数 |
| CommerceOrderPage.tsx:276 | 刷新 | 点击处理函数 |
| CommerceOrderPage.tsx:281 | 重试 | 点击处理函数 |
| CommerceOrderPage.tsx:343 | 详情 | 点击处理函数 |
| CommerceOrderPage.tsx:381 | {knownRefundOrderIds.has(detail.id) ? '已有退款记录' : '全额退款'} | 点击处理函数 |
| CommerceOrderPage.tsx:393 | 重试 | 点击处理函数 |
| CommerceOrderPage.tsx:420 | 进入二次确认 | 表单提交 |
| CommerceOrderPage.tsx:440 | 刷新商店交易 | 点击处理函数 |
| ContentLicensingPage.tsx:400 | 发放授权 | 点击处理函数 |
| ContentLicensingPage.tsx:552 | 创建授权包 | 点击处理函数 |
| ContentLicensingPage.tsx:556 | 重试 | 点击处理函数 |
| ContentLicensingPage.tsx:601 | 管理内容 | 点击处理函数 |
| ContentLicensingPage.tsx:657 | 筛选 | 点击处理函数 |
| ContentLicensingPage.tsx:658 | 清除 | 点击处理函数 |
| ContentLicensingPage.tsx:664 | 重试 | 点击处理函数 |
| ContentLicensingPage.tsx:738 | 撤销 | 点击处理函数 |
| ContentLicensingPage.tsx:867 | 重试 | 点击处理函数 |
| ContentRevenuePage.tsx:239 | 配置分成策略 | 点击处理函数 |
| ContentRevenuePage.tsx:247 | 查询 | 点击处理函数 |
| ContentRevenuePage.tsx:248 | 确认月度结算 | 点击处理函数 |
| ContentRevenuePage.tsx:258 | 保存分成基数 | 点击处理函数 |
| ContentRevenuePage.tsx:259 | 按已确认策略核算 500 笔 | 点击处理函数 |
| ContentRevenuePage.tsx:260 | 录入商店净收入凭据 | 点击处理函数 |
| ContentRevenuePage.tsx:261 | 录入内容广告对账行 | 点击处理函数 |
| ContentRevenuePage.tsx:262 | 确认历史核对报告 | 点击处理函数 |
| ContentRevenuePage.tsx:305 | 编辑 | 点击处理函数 |
| ContentRevenuePage.tsx:344 | 保存策略 | 表单提交 |
| CustomerFeedbackPanel.tsx:33 | 刷新反馈 | 点击处理函数 |
| CustomerFeedbackPanel.tsx:40 | 回复 | 点击处理函数 |
| CustomerManagementPage.tsx:308 | 查询代理商用户 | 点击处理函数 |
| CustomerManagementPage.tsx:342 | 筛选 | 点击处理函数 |
| CustomerManagementPage.tsx:343 | 刷新 | 点击处理函数 |
| CustomerManagementPage.tsx:357 | {record.username} | 点击处理函数 |
| CustomerManagementPage.tsx:384 | 详情 | 点击处理函数 |
| CustomerManagementPage.tsx:386 | {record.status === 'active' ? '停用' : '启用'} | 点击处理函数 |
| CustomerManagementPage.tsx:390 | 全部下线 | 点击处理函数 |
| CustomerManagementPage.tsx:414 | 上一页 | 点击处理函数 |
| CustomerManagementPage.tsx:422 | 下一页 | 点击处理函数 |
| CustomerManagementPage.tsx:471 | 确认 {statusTarget?.status === 'active' ? '停用' : '启用'} | 表单提交 |
| CustomerManagementPage.tsx:504 | 确认 {revokeTarget?.deviceId ? '撤销设备' : '踢下会话'} | 表单提交 |
| CustomerManagementPage.tsx:561 | 撤销设备 | 点击处理函数 |
| CustomerManagementPage.tsx:576 | 重试 | 点击处理函数 |
| DramaRankingButton.tsx:45 | 权重排行 | 点击处理函数 |
| DramaRankingButton.tsx:50 | 重新加载 | 点击处理函数 |
| InteractionModerationPage.tsx:268 | {targetType === 'report' ? `${reasonCategoryLabel(item.reasonCategory)} · ${item.targetType === 'com | 点击处理函数 |
| InteractionModerationPage.tsx:314 | {actionLabel(action)} | 点击处理函数 |
| InteractionModerationPage.tsx:370 | 刷新 | 点击处理函数 |
| InteractionModerationPage.tsx:377 | 重试 | 点击处理函数 |
| InteractionModerationPage.tsx:405 | 新增敏感词 | 点击处理函数 |
| InteractionModerationPage.tsx:409 | 重试 | 点击处理函数 |
| InteractionModerationPage.tsx:439 | 停用 | 确认或上传组件 |
| InteractionModerationPage.tsx:441 | 启用 | 点击处理函数 |
| InteractionModerationPage.tsx:488 | 确认 {actionTarget ? actionLabel(actionTarget.action) : '操作'} | 表单提交 |
| InteractionModerationPage.tsx:510 | 新增 | 表单提交 |
| LoginPage.tsx:99 | 登录 | 表单提交 |
| MerchantListPage.tsx:137 | 创建代理商 | 点击处理函数 |
| MerchantListPage.tsx:143 | 重试 | 点击处理函数 |
| MerchantListPage.tsx:192 | 站点配置 | 点击处理函数 |
| MerchantListPage.tsx:196 | 应用构建 | 点击处理函数 |
| MerchantListPage.tsx:297 | 确认创建 | 表单提交 |
| PaymentSettingsPage.tsx:385 | 连接测试 | 点击处理函数 |
| PaymentSettingsPage.tsx:393 | 轮换凭据 | 点击处理函数 |
| PaymentSettingsPage.tsx:404 | 停用 | 点击处理函数 |
| PaymentSettingsPage.tsx:413 | 启用 | 点击处理函数 |
| PaymentSettingsPage.tsx:440 | 刷新 | 点击处理函数 |
| PaymentSettingsPage.tsx:442 | 新建 Stripe Hosted Checkout | 点击处理函数 |
| PaymentSettingsPage.tsx:454 | 创建 Fake 配置（本地测试） | 点击处理函数 |
| PaymentSettingsPage.tsx:481 | 重试 | 点击处理函数 |
| PaymentSettingsPage.tsx:535 | 保存收款路由 | 点击处理函数 |
| PlatformAdminShell.tsx:200 | <Button aria-label="打开导航" className="mobile-menu-button" icon={<MenuOutlined />} onClick={() => setM | 点击处理函数 |
| PlatformAdminShell.tsx:216 | 退出 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:441 | 重试 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:528 | 上传专用图标 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:548 | 上传专用启动图 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:558 | 保存构建资料 | 表单提交 |
| PlatformAppBuildDrawer.tsx:610 | 刷新 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:615 | 重试 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:660 | 详情 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:663 | 取消 | 确认或上传组件 |
| PlatformAppBuildDrawer.tsx:667 | 下载 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:927 | 上传图片 | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:951 | {available ? '创建构建任务' : '前置条件未满足'} | 点击处理函数 |
| PlatformAppBuildDrawer.tsx:962 | 签名链路未配置 | 明确禁用 |
| PlatformContentLibraryPage.tsx:945 | 上传图片 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:956 | 保存公共短剧 | 表单提交 |
| PlatformContentLibraryPage.tsx:980 | 停用 | 确认或上传组件 |
| PlatformContentLibraryPage.tsx:1012 | 上传文件 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1015 | 保存轨道 | 表单提交 |
| PlatformContentLibraryPage.tsx:1045 | 单独上传正片 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1053 | 单独上传试看 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1058 | 保存剧集 | 表单提交 |
| PlatformContentLibraryPage.tsx:1085 | 保存 {taxonomyName(taxonomyEditor?.type ?? 'categories')} | 表单提交 |
| PlatformContentLibraryPage.tsx:1102 | 确认删除 | 表单提交 |
| PlatformContentLibraryPage.tsx:1192 | 刷新 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1194 | 创建公共短剧 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1203 | {translationValue(record.translations, 'title') \|\| record.code} | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1229 | 详情 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1231 | 编辑 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1233 | 创建新版本 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1236 | 发布 | 确认或上传组件 |
| PlatformContentLibraryPage.tsx:1241 | 下架 | 确认或上传组件 |
| PlatformContentLibraryPage.tsx:1245 | 紧急全局下架 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1248 | 删除 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1251 | 恢复 | 确认或上传组件 |
| PlatformContentLibraryPage.tsx:1315 | 刷新 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1317 | 创建 {taxonomyName(type)} | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1340 | 恢复 | 确认或上传组件 |
| PlatformContentLibraryPage.tsx:1345 | 编辑 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1346 | 删除 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1421 | 添加单集 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1421 | 批量添加剧集 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1436 | 编辑 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1436 | 字幕/配音 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1458 | 添加语言 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1473 | 移除 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1664 | 重试 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1703 | 开始安全上传 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1706 | 取消上传 | 点击处理函数 |
| PlatformContentLibraryPage.tsx:1718 | 重试 | 点击处理函数 |
| PlatformFinancePage.tsx:399 | 刷新 | 点击处理函数 |
| PlatformFinancePage.tsx:403 | 重试 | 点击处理函数 |
| PlatformFinancePage.tsx:417 | {value} | 点击处理函数 |
| PlatformFinancePage.tsx:441 | 详情 | 点击处理函数 |
| PlatformFinancePage.tsx:444 | 批准 | 点击处理函数 |
| PlatformFinancePage.tsx:445 | 驳回 | 点击处理函数 |
| PlatformFinancePage.tsx:449 | 确认打款 | 点击处理函数 |
| PlatformFinancePage.tsx:517 | 运行到期结算 | 表单提交 |
| PlatformFinancePage.tsx:552 | 保存结算策略 | 表单提交 |
| PlatformFinancePage.tsx:574 | 立即隐藏账户 | 点击处理函数 |
| PlatformFinancePage.tsx:576 | 查看完整收款账户 | 点击处理函数 |
| PlatformFinancePage.tsx:583 | 批准 | 点击处理函数 |
| PlatformFinancePage.tsx:584 | 驳回 | 点击处理函数 |
| PlatformFinancePage.tsx:588 | 确认打款 | 点击处理函数 |
| PlatformFinancePage.tsx:599 | 重试 | 点击处理函数 |
| PlatformFinancePage.tsx:609 | 重新确认并加载 | 点击处理函数 |
| PlatformFinancePage.tsx:734 | 进入二次确认 | 表单提交 |
| PublicDramaPoolPage.tsx:168 | 重试 | 点击处理函数 |
| PublicDramaPoolPage.tsx:183 | 审核通过 | 点击处理函数 |
| PublicDramaPoolPage.tsx:184 | 拒绝 | 点击处理函数 |
| PublicDramaPoolPage.tsx:186 | 配置并上架 | 点击处理函数 |
| PublicDramaPoolPage.tsx:194 | 下架 | 确认或上传组件 |
| PublicDramaPoolPage.tsx:200 | 重试 | 点击处理函数 |
| RefundManagementPanel.tsx:211 | 发起全额退款 | 点击处理函数 |
| RefundManagementPanel.tsx:225 | 刷新 | 点击处理函数 |
| RefundManagementPanel.tsx:227 | 重试 | 点击处理函数 |
| RefundManagementPanel.tsx:232 | {value} | 点击处理函数 |
| RefundManagementPanel.tsx:239 | 详情 | 点击处理函数 |
| RefundManagementPanel.tsx:258 | 重试 | 点击处理函数 |
| RefundManagementPanel.tsx:274 | 进入二次确认 | 表单提交 |
| RoleManagementPage.tsx:251 | {canManage && !role.isSystem ? '配置权限' : '查看权限'} | 点击处理函数 |
| RoleManagementPage.tsx:255 | 编辑 | 点击处理函数 |
| RoleManagementPage.tsx:312 | 刷新 | 点击处理函数 |
| RoleManagementPage.tsx:314 | 创建角色 | 点击处理函数 |
| RoleManagementPage.tsx:321 | 重试 | 点击处理函数 |
| RoleManagementPage.tsx:420 | 关闭 | 点击处理函数 |
| RuntimeConfigForm.tsx:38 | 删除 | 点击处理函数 |
| RuntimeConfigForm.tsx:40 | 添加商店商品 | 点击处理函数 |
| RuntimeConfigForm.tsx:42 | 保存运行配置 | 表单提交 |
| SiteSettingsPanel.tsx:345 | 重试 | 点击处理函数 |
| SiteSettingsPanel.tsx:427 | 保存配置 | 表单提交 |
| SiteSettingsPanel.tsx:443 | 重试 | 点击处理函数 |
| SiteSettingsPanel.tsx:452 | {createDomainKind === 'subdomain' ? '分配子域名' : '绑定独立域名'} | 点击处理函数 |
| SiteSettingsPanel.tsx:517 | 验证 DNS | 点击处理函数 |
| SiteSettingsPanel.tsx:522 | 证书状态 | 点击处理函数 |
| SiteSettingsPanel.tsx:534 | 设为主域名 | 确认或上传组件 |
| SiteSettingsPanel.tsx:542 | {domain.enabled ? '停用' : '启用'} | 确认或上传组件 |
| SiteSettingsPanel.tsx:590 | 确认 | 表单提交 |
| SiteSettingsPanel.tsx:626 | 确认状态 | 表单提交 |
| SiteSettingsPanel.tsx:644 | {value ? `更换${label}` : `上传${label}`} | 点击处理函数 |
| SiteSettingsPanel.tsx:645 | 清除 {label} | 点击处理函数 |
| StaffManagementPage.tsx:348 | 创建员工 | 点击处理函数 |
| StaffManagementPage.tsx:390 | 刷新 | 点击处理函数 |
| StaffManagementPage.tsx:400 | {record.username} | 点击处理函数 |
| StaffManagementPage.tsx:434 | 资料/角色 | 点击处理函数 |
| StaffManagementPage.tsx:441 | {record.status === 'active' ? '停用' : '启用'} | 确认或上传组件 |
| StaffManagementPage.tsx:450 | 重置密码 | 点击处理函数 |
| StaffManagementPage.tsx:451 | 撤销会话 | 点击处理函数 |
| StaffManagementPage.tsx:557 | 确认重置 | 表单提交 |
| StaffManagementPage.tsx:569 | 确认撤销 | 表单提交 |
| StaffManagementPage.tsx:614 | 重试 | 点击处理函数 |
| StorageProviderPage.tsx:301 | 编辑 | 点击处理函数 |
| StorageProviderPage.tsx:312 | {provider.status === 'active' ? '停用' : '启用'} | 确认或上传组件 |
| StorageProviderPage.tsx:322 | 删除 | 确认或上传组件 |
| StorageProviderPage.tsx:338 | 创建 S3 配置 | 点击处理函数 |
| StorageProviderPage.tsx:351 | 重试 | 点击处理函数 |
| TenantAdminShell.tsx:296 | <Button aria-label="打开导航" className="mobile-menu-button" icon={<MenuOutlined />} onClick={() => setM | 点击处理函数 |
| TenantAdminShell.tsx:312 | 退出 | 点击处理函数 |
| TenantCommunicationSettingsPage.tsx:246 | 刷新状态 | 点击处理函数 |
| TenantCommunicationSettingsPage.tsx:257 | 重试 | 点击处理函数 |
| TenantCommunicationSettingsPage.tsx:294 | {config ? '替换凭据' : '录入凭据'} | 点击处理函数 |
| TenantCommunicationSettingsPage.tsx:297 | 发送真实测试 | 点击处理函数 |
| TenantCommunicationSettingsPage.tsx:307 | {config.status === 'active' ? '停用' : '启用'} | 确认或上传组件 |
| TenantCommunicationSettingsPage.tsx:386 | 保存并停用，等待重新测试 | 表单提交 |
| TenantCommunicationSettingsPage.tsx:413 | 提交测试任务 | 表单提交 |
| TenantContentListPage.tsx:992 | 上传图片 | 点击处理函数 |
| TenantContentListPage.tsx:1003 | 保存短剧 | 表单提交 |
| TenantContentListPage.tsx:1038 | 单独上传正片 | 点击处理函数 |
| TenantContentListPage.tsx:1046 | 单独上传试看 | 点击处理函数 |
| TenantContentListPage.tsx:1051 | 保存剧集 | 表单提交 |
| TenantContentListPage.tsx:1083 | 保存 {taxonomyName(taxonomyEditor?.type ?? 'categories')} | 表单提交 |
| TenantContentListPage.tsx:1102 | 确认删除 | 表单提交 |
| TenantContentListPage.tsx:1146 | 提交异步导入 | 点击处理函数 |
| TenantContentListPage.tsx:1217 | 刷新 | 点击处理函数 |
| TenantContentListPage.tsx:1219 | 创建短剧 | 点击处理函数 |
| TenantContentListPage.tsx:1228 | {translationValue(record.translations, 'title') \|\| record.code} | 点击处理函数 |
| TenantContentListPage.tsx:1255 | 详情 | 点击处理函数 |
| TenantContentListPage.tsx:1257 | 编辑 | 点击处理函数 |
| TenantContentListPage.tsx:1260 | 确认上架 | 确认或上传组件 |
| TenantContentListPage.tsx:1265 | 下架 | 确认或上传组件 |
| TenantContentListPage.tsx:1270 | 撤回旧审核 | 确认或上传组件 |
| TenantContentListPage.tsx:1274 | 删除 | 点击处理函数 |
| TenantContentListPage.tsx:1277 | 恢复 | 确认或上传组件 |
| TenantContentListPage.tsx:1341 | 刷新 | 点击处理函数 |
| TenantContentListPage.tsx:1343 | 创建 {taxonomyName(type)} | 点击处理函数 |
| TenantContentListPage.tsx:1370 | 恢复 | 确认或上传组件 |
| TenantContentListPage.tsx:1375 | 编辑 | 点击处理函数 |
| TenantContentListPage.tsx:1376 | 删除 | 点击处理函数 |
| TenantContentListPage.tsx:1437 | 刷新任务 | 点击处理函数 |
| TenantContentListPage.tsx:1438 | 导出 JSON | 点击处理函数 |
| TenantContentListPage.tsx:1439 | 导出 CSV | 点击处理函数 |
| TenantContentListPage.tsx:1441 | 导入 JSON/CSV | 点击处理函数 |
| TenantContentListPage.tsx:1453 | {value} | 点击处理函数 |
| TenantContentListPage.tsx:1459 | 详情 | 点击处理函数 |
| TenantContentListPage.tsx:1527 | 添加单集 | 点击处理函数 |
| TenantContentListPage.tsx:1527 | 批量添加剧集 | 点击处理函数 |
| TenantContentListPage.tsx:1542 | 编辑 | 点击处理函数 |
| TenantContentListPage.tsx:1580 | 刷新异步状态 | 点击处理函数 |
| TenantContentListPage.tsx:1595 | 上一页 | 点击处理函数 |
| TenantContentListPage.tsx:1597 | 下一页 | 点击处理函数 |
| TenantContentListPage.tsx:1613 | 添加语言 | 点击处理函数 |
| TenantContentListPage.tsx:1628 | 移除 | 点击处理函数 |
| TenantContentListPage.tsx:1803 | 重试 | 点击处理函数 |
| TenantContentListPage.tsx:1850 | 开始安全上传 | 点击处理函数 |
| TenantContentListPage.tsx:1853 | 取消上传 | 点击处理函数 |
| TenantContentListPage.tsx:1870 | 重试 | 点击处理函数 |
| TenantFinancePage.tsx:294 | {value} | 点击处理函数 |
| TenantFinancePage.tsx:324 | 撤回 | 确认或上传组件 |
| TenantFinancePage.tsx:341 | 刷新 | 点击处理函数 |
| TenantFinancePage.tsx:345 | 申请提现 | 点击处理函数 |
| TenantFinancePage.tsx:365 | 重试 | 点击处理函数 |
| TenantFinancePage.tsx:411 | 重试 | 点击处理函数 |
| TenantFinancePage.tsx:460 | 加载更早记录 | 点击处理函数 |
| TenantFinancePage.tsx:476 | 重试 | 点击处理函数 |
| TenantFinancePage.tsx:504 | 撤回申请 | 确认或上传组件 |
| TenantFinancePage.tsx:514 | 重试 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:291 | 编辑 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:292 | 发布 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:293 | 删除 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:305 | 刷新 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:306 | 新建草稿 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:308 | 重试 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:320 | 上一页 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:322 | 下一页 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:332 | 刷新 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:334 | 重试 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:341 | 详情 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:351 | 上一页 | 点击处理函数 |
| TenantLegalPrivacyPage.tsx:353 | 下一页 | 点击处理函数 |
| TenantNotificationPage.tsx:448 | 详情 | 点击处理函数 |
| TenantNotificationPage.tsx:450 | 编辑 | 点击处理函数 |
| TenantNotificationPage.tsx:454 | 排期 | 点击处理函数 |
| TenantNotificationPage.tsx:457 | 取消 | 点击处理函数 |
| TenantNotificationPage.tsx:498 | 新建草稿 | 点击处理函数 |
| TenantNotificationPage.tsx:502 | 重试 | 点击处理函数 |
| TenantNotificationPage.tsx:509 | {value} | 点击处理函数 |
| TenantNotificationPage.tsx:551 | 重试 | 点击处理函数 |
| TenantNotificationPage.tsx:600 | 刷新状态 | 点击处理函数 |
| TenantNotificationPage.tsx:601 | 重试 | 点击处理函数 |
| TenantNotificationPage.tsx:629 | {config ? '替换凭据' : '录入凭据'} | 点击处理函数 |
| TenantNotificationPage.tsx:630 | 测试连接 | 点击处理函数 |
| TenantNotificationPage.tsx:633 | 停用 | 点击处理函数 |
| TenantNotificationPage.tsx:636 | 启用 | 点击处理函数 |
| TenantNotificationPage.tsx:756 | 删除 | 点击处理函数 |
| TenantNotificationPage.tsx:763 | 添加语言 | 点击处理函数 |
| TenantReferralPage.tsx:187 | 重试 | 点击处理函数 |
| TenantReferralPage.tsx:229 | 保存规则 | 表单提交 |
| TenantReferralPage.tsx:259 | 刷新 | 点击处理函数 |
| TenantReferralPage.tsx:263 | 重试 | 点击处理函数 |
