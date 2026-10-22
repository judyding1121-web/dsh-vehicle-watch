/**
 * DSH Host-only Cordis bundle：闲鱼（西安）二手车新上架/降价监控 + 智能机器人双向指令
 * 定时搜索 → 过滤非车商品 → 与已见 listing 对比 → 企微/飞书推送 → Excel 报表
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { createService } from './src/service.js'
import { AibotClient } from './src/aibot.js'
import { createCommandHandler } from './src/commands.js'
import { createLlmAnalyzer } from './src/llm-analyzer.js'
import { REPORT_NAME } from './src/html-report.js'
import { dashboardUrls, startDashboardServer } from './src/dashboard-server.js'
import { startQuickTunnel } from './src/dashboard-tunnel.js'

export const name = 'vehicle-watch'
export const inject = ['tools', 'timer']

const Target = z.object({
  id: z.string().required(),
  name: z.string().required(),
  keyword: z.string().default(''),       // 闲鱼搜索关键词；旧配置缺失时回退用 name
  usedCarUrl: z.string().default(''),    // 历史字段（瓜子版），保留以兼容旧配置
  referenceOfficialLow: z.natural().default(0),
  referenceOfficialHigh: z.natural().default(0),
  enabled: z.boolean().default(true),
})

export const Config = z.object({
  city: z.string().default('西安'),
  province: z.string().default('陕西'),
  cityCode: z.string().default('xa'),        // 历史字段，保留兼容
  cityName: z.string().default('西安'),      // 历史字段，保留兼容
  minPriceYuan: z.natural().default(30000),  // 低于此价视为配件/租车/残值车，过滤掉
  carCategoryId: z.string().default('127302001'), // 闲鱼“二手车”类目 id
  excludeKeywords: z.array(z.string()).default([
    '租车', '日租', '床垫', '车模', '配件', '订单', '返现', '定金', '事故', '水淹', '残值', '批发',
  ]),
  scanIntervalHours: z.natural().default(2),
  startupDelaySec: z.natural().default(30),
  maxPushPerRun: z.natural().default(8),
  notifyOnFirstRun: z.boolean().default(true),
  priceDropAbs: z.natural().default(1000),

  targets: z.array(Target).default([]),

  notify: z.object({
    wecomWebhook: z.string().default(''),
    feishuWebhook: z.string().default(''),
    feishuSecret: z.string().default(''),
    timeoutMs: z.natural().default(10000),
  }).default({}),

  dashboard: z.object({
    enabled: z.boolean().default(true),
    public: z.boolean().default(true),   // 启动 Cloudflare 快速隧道，户外手机可看
    tunnelCommand: z.string().default(''), // cloudflared 路径；空 = 自动查找
    port: z.natural().default(47800),
    host: z.string().default(''),        // 空 = 0.0.0.0（同一局域网可访问）
  }).default({}),

  llm: z.object({
    enabled: z.boolean().default(true),
    provider: z.string().default('deepseek-account'),
    model: z.string().default('deepseek-flash'),
    timeoutMs: z.natural().default(15000),
  }).default({}),

  aibot: z.object({
    enabled: z.boolean().default(false),
    botId: z.string().default(''),
    secret: z.string().default(''),
    wsUrl: z.string().default('wss://openws.work.weixin.qq.com'),
    heartbeatMs: z.natural().default(25000),
  }).default({}),

  xianyu: z.object({
    cookie: z.string().default(''),          // 可选：登录 Cookie，匿名也能搜，填了更稳
    pages: z.natural().default(1),           // 每个关键词翻几页（每页 30 条）
    minGapMs: z.natural().default(3000),     // 请求间隔，太低容易触发风控
    timeoutMs: z.natural().default(20000),
  }).default({}),

  fetch: z.object({
    minGapMs: z.natural().default(3000),
    timeoutMs: z.natural().default(20000),
    userAgent: z.string().default(''),
  }).default({}),

  report: z.object({
    enabled: z.boolean().default(true),
    html: z.boolean().default(true),          // 扫描后生成单文件 HTML 看板
    dir: z.string().default(''),
    pythonPath: z.string().default('python3'),
    keepDays: z.natural().default(30),
  }).default({}),
})

export function apply(ctx, config) {
  const log = ctx.logger('vehicle-watch')
  const statePath = dshHomePath('storages', 'vehicle-watch', 'used-car-state.json')
  const reportDir = config.report?.dir || dshHomePath('storages', 'vehicle-watch', 'reports')
  const reportScriptPath = fileURLToPath(new URL('./scripts/make_report.py', import.meta.url))

  const service = createService({ config, statePath, reportDir, reportScriptPath, log })
  const run = (trigger) => service.scan(trigger).catch((err) => log.error('scan failed: %s', err?.stack ?? err))

  // 本地/公网看板：手机可直接看「本轮新上架/降价」
  if (config.dashboard?.enabled !== false) {
    ctx.effect(async () => {
      let started
      try {
        started = await startDashboardServer({
          filePath: path.join(reportDir, REPORT_NAME),
          jsonPath: path.join(reportDir, 'latest.json'),
          port: config.dashboard?.port ?? 47800,
          host: config.dashboard?.host || '0.0.0.0',
          log,
        })
      } catch (err) {
        log.warn('dashboard server failed: %s', err.message)
        service.setDashboard({ enabled: false, error: err.message })
        return () => {}
      }

      const urls = dashboardUrls(started.port)
      let tunnel = null
      let disposed = false
      const publish = () => service.setDashboard({
        enabled: true,
        port: started.port,
        url: tunnel?.url || urls.lan || urls.local,
        publicUrl: tunnel?.url ?? null,
        publicPending: config.dashboard?.public !== false && !tunnel,
        urls: { ...urls, public: tunnel?.url ?? null },
      })
      publish()
      log.info('dashboard ready: %s (phone: %s)', urls.local, urls.lan || urls.local)

      // 公网隧道在后台启动，不阻塞插件激活；退出时回退到局域网并最多重试 3 次
      let tunnelAttempts = 0
      let retryTimer = null
      const startTunnel = async () => {
        if (disposed || config.dashboard?.public === false) return
        try {
          const t = await startQuickTunnel({ port: started.port, command: config.dashboard?.tunnelCommand || '', log })
          if (disposed) { t.close().catch(() => {}); return }
          tunnel = t
          urls.public = t.url
          tunnelAttempts = 0
          publish()
          log.info('dashboard public: %s', t.url)
          t.onExit?.((code) => {
            if (disposed) return
            log.warn('public tunnel exited (code %s)，5s 后重试', code)
            tunnel = null
            urls.public = null
            publish()
            if (tunnelAttempts < 3) {
              tunnelAttempts += 1
              retryTimer = setTimeout(startTunnel, 5000)
            }
          })
        } catch (err) {
          log.warn('public tunnel failed: %s（户外手机只能用局域网地址）', err.message)
          if (!disposed && tunnelAttempts < 3) {
            tunnelAttempts += 1
            retryTimer = setTimeout(startTunnel, 10000)
          }
        }
      }
      startTunnel()

      return () => {
        disposed = true
        if (retryTimer) clearTimeout(retryTimer)
        if (tunnel) tunnel.close().catch(() => {})
        started.close().catch(() => {})
      }
    }, 'vehicle-watch: dashboard')
  }

  // 企业微信「智能机器人」双向通道：接收文本指令并回复（WebSocket 长连接）
  let aibot = null
  if (config.aibot?.enabled && config.aibot.botId && config.aibot.secret) {
    const analyzer = config.llm?.enabled === false ? null : createLlmAnalyzer({
      getLlm: () => { try { return ctx.get('llm') } catch { return null } },
      provider: config.llm?.provider,
      model: config.llm?.model,
      timeoutMs: config.llm?.timeoutMs,
      log,
    })
    const handler = createCommandHandler({ service, log, analyzer })
    aibot = new AibotClient({
      botId: config.aibot.botId,
      secret: config.aibot.secret,
      wsUrl: config.aibot.wsUrl,
      heartbeatMs: config.aibot.heartbeatMs,
      log,
      onText: (msg) => handler(msg),
    })
    ctx.effect(() => {
      try { aibot.connect() } catch (err) { log.error('aibot connect failed: %s', err.message) }
      return () => aibot.close()
    }, 'vehicle-watch: aibot')
  }

  // 定时扫描：默认每 2 小时；启动 30s 后先跑一次（不阻塞 DSH 启动）
  ctx.interval(() => run('timer'), Math.max(1, config.scanIntervalHours) * 3600_000)
  ctx.timeout(() => run('startup'), Math.max(5, config.startupDelaySec) * 1000)

  ctx.tools.register(defineTool({
    name: 'vehicle_usedcar_scan',
    description: '立即搜索一次闲鱼（西安四车型），返回本次新上架/降价数量与各车型样本行情。',
    parameters: {
      targetId: { type: 'string', description: '只扫某个车型（可选：xiaomi-su7 / lixiang-i6 / aito-m7）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const result = await service.scan('tool', { targetId: args?.targetId || null })
      if (exec?.signal?.aborted) throw new Error('aborted')
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vehicle_usedcar_status',
    description: '查看闲鱼二手车监控状态：各车型上次扫描时间、西安样本数、中位价、已见车源数、上次运行结果、智能机器人连接状态。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const status = await service.status()
      return { ...status, aibot: aibot?.getStatus() ?? { enabled: false } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vehicle_usedcar_bot_status',
    description: '查看企业微信智能机器人（双向）的连接状态、收发计数与最后错误。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return aibot?.getStatus() ?? { enabled: false, connected: false }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vehicle_usedcar_report',
    description: '用最近一次扫描结果重新生成 Excel 报表与 HTML 看板（二手车监控-最新.xlsx / .html），返回文件路径。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const report = await service.generateNow()
      return report
    },
  }))

  log.info('vehicle-watch mounted: source=xianyu targets=%d interval=%dh reportDir=%s aibot=%s', config.targets.length, config.scanIntervalHours, reportDir, config.aibot?.enabled ? 'on' : 'off')
}
