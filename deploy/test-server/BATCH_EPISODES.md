# 批量剧集上传与自动时长

适用于 Night Flix 总部公共内容管理和代理商内容管理，不涉及闪创项目。

## 使用

1. 创建短剧草稿，打开详情，选择“批量添加剧集”。
2. 一次选择多个 MP4 / MOV / WebM。系统按文件名自然排序，从现有最大集数后连续编号；
   上传前可修改起始集数、每集编号和标题，标题默认取文件名。
3. 每个文件单独读取视频时长，向上取整到秒。不再默认 60 秒或要求手填；
   单集上传也自动填写只读时长。无法读取的文件会明确报错，不使用虚构时长。
4. 点击“上传并添加 / 重试未完成”。按集串行安全上传与保存，已成功的集数不会重复上传；
   部分失败可重试。已有同号剧集不覆盖，需调整编号。
5. 完成后返回短剧详情。批量操作只创建正片草稿，不自动发布、不生成试看视频。

浏览器读取本地文件 metadata，不是服务器 ffprobe 或自动转码。旧记录不会被自动改写。
每集最大 2 GiB，每部最多 1000 集；浏览器必须支持所选视频格式。
保持页面打开，可在当前窗口暂停/继续；关闭或刷新不会保留未完成文件队列，已保存剧集保留。
文件继续存到已启用的服务器硬盘存储，沿用租户隔离、SHA256、临时签名、完成校验及内容版本 CAS。

## 可重复验收

- `pnpm --filter @drama/contracts build`
- `pnpm --filter @drama/admin test`：56 项，包括 8 项批量/自动时长回归。
- `pnpm --filter @drama/admin typecheck`
- `smoke-batch-episodes.mjs` 使用独立无头 Chrome、真实测试 API、真实 HTTPS/S3 及自制 MP4，
  检查自然排序、3/7/11 秒逐集保存、单集 7 秒自动填写、失败文件重试不重传成功文件。
  默认只在该测试浏览器内替换静态页面为本地制品；`--live` 则直接访问已部署页面。
  每次运行会创建独立、未上架测试草稿，不能误当无写入检查；凭证仅从私有 JSON 读取。

```sh
PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node deploy/test-server/smoke-batch-episodes.mjs \
  /absolute/artifact /private/access.private.json /private/synthetic-mp4-directory
```

测试视频目录包含 `EP_01.mp4`（3 秒）、`EP_02.mp4`（7 秒）、`EP_10.mp4`（11 秒）。
测试脚本不发送邮件、不调用付费服务、不发布短剧、不修改用户已有短剧。

应用改动无数据库迁移、无新增服务或依赖，不需要重装 APK。
