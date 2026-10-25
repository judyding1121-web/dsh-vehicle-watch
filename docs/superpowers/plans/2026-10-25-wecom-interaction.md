# 企业微信交互与看板改造实现计划

**目标：** 将二手车插件改造成单卡、同会话、有异步反馈的企业微信助手，并提供带历史动态、车源筛选和真实监控开关的手机看板。

**架构：** 命令层统一生成查询/管理结果，智能机器人通过 WebSocket 接收文字与卡片事件并主动推送异步结果；群 Webhook 保留 `text_notice` 兼容推送。服务层负责缓存、监控状态、变化历史和扫描编排，HTTP 层只处理鉴权与请求委托，HTML 使用本轮数据做纯前端筛选。

**技术栈：** Node.js 24 原生 ESM、企业微信 `template_card` / WebSocket、`node:test` 风格断言脚本、原生 HTML/CSS/JavaScript。

---

### 任务 1：监控状态可信

**文件：** `src/runtime-store.js`、`src/service.js`、`scripts/selftest.mjs`

- [ ] 写失败测试：默认配置车型取消后不出现在 `loadTargets()`，重新加入后恢复；动态车型仍可删除。
- [ ] 运行 `node scripts/selftest.mjs`，确认默认车型取消测试失败。
- [ ] 在 `watchlist.json` 增加向后兼容的 `disabledIds`，`removeWatchTarget(statePath, id, configTargets)` 对默认车型写禁用状态，对动态车型删除记录；`addWatchTargets` 可重新启用默认车型。
- [ ] `service.removeTarget()` 传入配置车型，命令层只有返回 `true` 才提示成功。
- [ ] 重跑测试，确认状态恢复和重复取消均正确。

### 任务 2：统一单卡与聚合通知

**文件：** `src/commands.js`、`src/notify.js`、`scripts/selftest.mjs`、`scripts/selftest-service.mjs`

- [ ] 写失败测试：查询只返回一张卡且不调用 `sendCards`；“最新”同时统计新上架和降价；整轮自动推送只产生一张汇总卡。
- [ ] 运行两套自测，确认旧的多卡行为与新断言冲突。
- [ ] 删除查询路径的 Webhook 补发详情卡逻辑；结果卡统一携带摘要、重点车源和看板链接。
- [ ] 智能机器人查询使用 `button_interaction`，Webhook 自动通知使用 `text_notice`；链接动作使用 URL，管理动作使用唯一 `key`。
- [ ] `buildMessages()` 将新上架/降价按整轮聚合，`maxPushPerRun` 只限制摘要重点条数，不再逐车发消息。
- [ ] 重跑测试，确认卡片类型、按钮限制、文本降级和飞书文本均正确。

### 任务 3：智能机器人按钮与异步闭环

**文件：** `src/aibot.js`、`src/commands.js`、`index.js`、`scripts/selftest.mjs`

- [ ] 写失败测试：`template_card_event` 能提取按钮 key 并调用 `aibot_respond_update_msg`；群/单聊主动推送使用正确 `chatid` 与 `chat_type`。
- [ ] 写失败测试：手动扫描先回复开始，结束后向原会话推送完成卡；忙碌、无变化和失败均有明确结果。
- [ ] 运行测试确认事件和主动推送尚未实现。
- [ ] `AibotClient` 增加事件排重、按钮事件分发、卡片更新及 `aibot_send_msg`；5 秒内可完成的按钮动作直接更新卡片。
- [ ] 命令层处理 `watch_add`、`refresh`、`dashboard`、`read` 等动作，按钮 key 不暴露凭证且长度受控。
- [ ] 手动扫描使用 `suppressNotify`，避免固定 Webhook 与原会话重复推送；完成卡包含成功车型、新上架、降价和失败原因。
- [ ] 重跑测试，验证按钮、刷新、加入监控和异常路径。

### 任务 4：缓存、历史与看板 API

**文件：** `src/service.js`、`src/runtime-store.js`、`src/dashboard-server.js`、`index.js`、`scripts/selftest-service.mjs`

- [ ] 写失败测试：同一关键词 5 分钟内只抓取一次；每轮变化写入历史并保留 7 天；无令牌请求返回 401。
- [ ] 写失败测试：看板添加、停用、重新启用默认车型会改变真实监控清单，非法输入返回 400。
- [ ] 运行服务测试确认新行为不存在。
- [ ] 服务层增加查询缓存、变化历史和 `setTargetEnabled()`；手动/定时扫描均按同一状态源读取车型。
- [ ] 看板令牌持久化在本地状态目录，仪表盘 URL 自动携带令牌；所有数据、查询和管理接口鉴权。
- [ ] `POST /api/monitor` 只接受 `add/remove/toggle`，校验车型名、关键词和 ID；GET 保持只读。
- [ ] 重跑服务测试，验证缓存、历史裁剪、鉴权和监控管理。

### 任务 5：手机看板交互

**文件：** `src/html-report.js`、`src/dashboard-server.js`、`scripts/selftest-service.mjs`

- [ ] 写失败测试：HTML 包含“动态 / 全部车源 / 监控”三个视图、24 小时与 7 天数据、实际车型清单和无死按钮动作。
- [ ] 运行测试确认旧静态看板不满足断言。
- [ ] 使用同一份嵌入 JSON 渲染三个视图；动态支持全部/新上/降价筛选，车源支持车型、价格、里程与排序。
- [ ] 监控开关和添加入口调用已鉴权 API；失败保留原状态并显示错误，成功后刷新数据。
- [ ] 查询页复用查询缓存和车源卡片；错误页提供重试与闲鱼搜索链接。
- [ ] 重跑渲染测试并检查移动端 HTML/JS 语法。

### 任务 6：配置、文档与完整验收

**文件：** `README.md`、`cordis.patch.yml`、`package.json`、`.github/workflows/ci.yml`

- [ ] 更新企业微信指令、双通道行为、看板鉴权与状态兼容说明，不写入任何真实凭证。
- [ ] 运行 `pnpm run check`。
- [ ] 运行 `pnpm test`，确认全部离线测试通过。
- [ ] 运行 `pnpm pack` 冒烟，确认新增源码和文档进入包、状态文件与凭证不进入包。
- [ ] 检查 `git diff --check`、敏感信息和最终 diff，确保没有仓库外运行时状态被提交。
