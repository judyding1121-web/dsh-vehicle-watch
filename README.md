# dsh-vehicle-watch

DeepSeek Harness（DSH）Host 插件 / Cordis bundle：监控**西安** **小米SU7 / 理想i6 / 问界M7 / 极氪001** 的瓜子二手车，新上架或降价时推送到企业微信、飞书，并生成 Excel 报表。

- 每 2 小时扫一次车系页（第 1 页，40 条/车型），只保留西安车源；
- 与已见 `listing_id` 对比：**新上架**、**已跟踪车源降价**；
- 有新变化才推；企业微信用模板卡片，整卡可点跳瓜子详情；首次启动只发一条基线摘要；
- 生成 `二手车监控-最新.xlsx`（6 个 sheet）与 CSV；
- 可选企业微信「智能机器人」双向指令（查行情 / 最新 / 找新车型 / 扫描）。

> 挂牌价 ≠ 成交价；每页 40 条是样本，不承诺全站。仅个人低频自用，不商用、不公开分发数据。

---

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| DSH Desktop | **0.2.1-rc.2** | `peerDependencies` 钉死此版本；其他版本需版本豁免（见下） |
| Node.js | ≥ 24 | DSH 自带，无需另装 |
| Python 3 + `openpyxl` | 可选 | 仅生成 Excel 需要；不装可设 `report.enabled: false`，仍输出 CSV |
| 企业微信群机器人 webhook | 可选 | 不填则只落库/出表，不推送 |
| 飞书群机器人 webhook | 可选 | 同上 |
| 企业微信智能机器人 `botId`/`secret` | 可选 | 只有要双向指令时才需要 |

---

## 安装

### 方式 A：从 GitHub 安装（推荐，另一台电脑最省事）

插件管理器直接把 GitHub 仓库当 npm spec 安装，依赖（`ws`）会自动装好。

1. DSH → Web 侧栏 → **插件** → **添加插件** → **安装第三方插件**；
2. 输入仓库 spec，二选一：
   - `github:<你的GitHub用户名>/dsh-vehicle-watch`
   - `https://github.com/<你的GitHub用户名>/dsh-vehicle-watch`
3. 安装完成后确认状态是 `applied`（若提示 `restart-required`，重启 DSH）；
4. 按下面「配置」填写 webhook / 车型；
5. 30 秒后自动首扫，或让 Agent 调用 `vehicle_usedcar_scan`。

> 也可以让 Agent 调用 `plugin_manager`：`action: install_bundle`、`target: 'github:<用户名>/dsh-vehicle-watch'`。该工具需要 `danger-full-access` 或本次调用审批。
>
> 私有仓库：需要本机 Git 凭据（SSH key 或 credential helper/token）。安装前管理器会用 `git ls-remote` 探活，认证失败会继续交给 pnpm，能凭据就绪即可。

### 方式 B：clone 后按本地目录安装

适合改代码 / 离线：

```bash
git clone https://github.com/<你的GitHub用户名>/dsh-vehicle-watch.git
cd dsh-vehicle-watch
pnpm install        # 本地 link 安装不会替你装 ws，必须手动执行一次
```

然后：插件 → 添加插件 → 安装第三方插件 → 选这个目录的**绝对路径**。

### 方式 C：离线 tarball

```bash
pnpm pack           # 生成 dsh-vehicle-watch-0.1.0.tgz
```

把 `.tgz` 拷到另一台电脑，安装时填 tarball 的绝对路径（同样支持）。

> ⚠️ Desktop 的 profile 由 Electron 独占管理：**不要**手改 `~/.dsh/profiles/desktop/package.json` / `cordis.yml`，也**不要**用 `dsh plugin` CLI 改 desktop profile。只改 `cordis.patch.yml`。

---

## 配置

安装后编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在 `- id: vehicle-watch` 下填配置（可复制本仓库 [`cordis.patch.yml`](cordis.patch.yml) 的 `config` 再改）。

```yaml
- id: vehicle-watch
  config:
    scanIntervalHours: 2
    startupDelaySec: 30
    maxPushPerRun: 8
    notifyOnFirstRun: true
    priceDropAbs: 1000
    cityCode: xa
    cityName: 西安
    targets:
      - id: xiaomi-su7
        name: 小米SU7
        usedCarUrl: https://www.guazi.com/xa/xiaomiqiche/xiaomisu7/
        referenceOfficialLow: 219900
        referenceOfficialHigh: 303900
        enabled: true
      # 其余车型照抄 cordis.patch.yml
    notify:
      wecomWebhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'
      feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/...'
      feishuSecret: ''
      timeoutMs: 10000
    aibot:                       # 双向指令才需要；不需要就整段留空/删掉
      enabled: false
      botId: ''
      secret: ''
    report:
      enabled: true
      dir: ''                    # 空 = ~/.dsh/storages/vehicle-watch/reports
      pythonPath: python3        # 换机器一般不用改；Windows 填 python
      keepDays: 30
```

**注意：`config` 是整体替换，不是深合并。** 覆盖时必须重述 `targets`、`notify`、`report` 等所有字段（可整段复制仓库里的 `cordis.patch.yml` 再改）。webhook / bot secret 是凭证，`cordis.patch.yml` 权限建议 `600`，**不要提交到仓库、不要贴进对话**。

常用字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `scanIntervalHours` | 2 | 扫描间隔（小时） |
| `startupDelaySec` | 30 | 启动后首扫延迟，避免抢启动 |
| `maxPushPerRun` | 8 | 单条消息最多列几台，超出提示看 Excel |
| `priceDropAbs` | 1000 | 降价超过多少元才推 |
| `notifyOnFirstRun` | true | 首次只建基线，不逐条推 100+ 台 |
| `report.dir` | `''` | 空 = `~/.dsh/storages/vehicle-watch/reports`；可指向工作区 |
| `report.pythonPath` | `python3` | 换机器一般不用改 |

---

## 数据与状态

| 内容 | 位置 |
|---|---|
| 已见车源 / 去重状态 | `~/.dsh/storages/vehicle-watch/used-car-state.json` |
| 报表与明细 | `report.dir`（默认 `~/.dsh/storages/vehicle-watch/reports`） |
| 产物 | `二手车监控-最新.xlsx`、`latest.json`、`latest.csv`、`listings-latest.csv`、`scan-log.jsonl` |

状态与报表都**不在仓库里**，换电脑互不影响；首次运行会重新建立基线。

---

## 工具

| 工具 | 用途 |
|---|---|
| `vehicle_usedcar_scan` | 立即扫一次（可指定 `targetId`）；返回新增/降价/消息/报表路径 |
| `vehicle_usedcar_status` | 上次扫描、各车型样本数/中位价/已见数 |
| `vehicle_usedcar_bot_status` | 企微智能机器人连接状态、收发计数 |
| `vehicle_usedcar_report` | 用最近一次结果重新生成 Excel |

## 企业微信双向指令

在群里 **@机器人** 发送：

| 指令 | 回复 |
|---|---|
| `查` / `行情` / `状态` | 各车型样本数、中位价 |
| `小米SU7` / `理想i6` / `问界M7` / `极氪001` | 该车型行情 + 最低价 3 台 |
| `最新` / `新上架` | 本轮新增车源 |
| `扫描` / `刷新` | 立即抓取一次 |
| `找<车型>` | 临时查询，并问是否加入监控 |
| `取消` / `帮助` | 取消加入询问 / 指令列表 |

---

## 换电脑 / 升级 DSH 后

- **DSH 版本不同**：安装可能报 `incompatible-version`（peer 依赖钉 `0.2.1-rc.2`）。处理：插件页 → 版本豁免（或让 Agent 用 `plugin_manager` 的 `set_version_exemption`，需 `acceptRisk: true`），只对该 `包@版本 + DSH 版本` 组合生效。
- **升级插件**：可 HMR 的改动即时生效；替换已装包通常提示 `restart-required`，重启即可。
- **卸载**：插件页移除；状态文件保留在 `~/.dsh/storages/vehicle-watch/`，需要彻底清理时手动删。

## 常见问题

| 现象 | 处理 |
|---|---|
| 安装后工具不出现 | 看是否 `applied`；`restart-required` 就重启；日志找 `vehicle-watch mounted` |
| 报 `Cannot find package 'ws'` | 本地目录安装没跑 `pnpm install`；执行一次后重启 |
| 报表失败 `No module named openpyxl` | `python3 -m pip install --user openpyxl`，或 `report.enabled: false`（CSV 照常生成） |
| 首轮没推送 | 首次只建基线；或 webhook 为空（日志 `notify skipped`） |
| 数据一直不变 / 样本 <30 | 瓜子页面改版或限流；插件按设计不更新状态、不推送，看 `scan-log.jsonl` |
| DSH 关闭后不跑 | 本插件随 DSH Host 生命周期；要 7×24 需另加 launchd / 常驻服务 |

---

## 发布到 GitHub（维护者）

**本目录就是仓库根**：`package.json` 在根、声明了 `dsh.bundle.patch`，插件管理器才能把它当 bundle 安装。不要把整个 workspace 当仓库发（bundle 在子目录，安装时无法指向子目录）。

```bash
cd plugins/dsh-vehicle-watch
git init -b main
git add .
git commit -m "feat: dsh-vehicle-watch v0.1.0"

# 有 gh CLI：
gh repo create dsh-vehicle-watch --public --source=. --push
# 或网页建空仓库后：
git remote add origin https://github.com/<用户名>/dsh-vehicle-watch.git
git push -u origin main
```

发布前检查：

1. `pnpm run check`、`pnpm test` 通过；
2. 仓库里**没有** webhook、bot secret、`node_modules/`、`data/`、`*.xlsx`、`*.csv`、`scan-log.jsonl`（`.gitignore` 已覆盖，仍建议 `git status` 过一眼）；
3. `cordis.patch.yml` 里没有绝对路径（已改为 `report.dir: ''`、`pythonPath: python3`）；
4. 只发布代码，不发布抓取到的车源数据。

## 合规

- 瓜子挂牌价 ≠ 成交价；第 1 页 40 条是样本。
- 默认 2 小时 × 4 车系 ≈ 48 请求/天，请保持低频；遵守目标站点条款，不商用、不公开分发数据。
- 插件运行在 DSH Host 进程内、拥有宿主权限；安装第三方插件前先读代码。

## License

[MIT](LICENSE)
