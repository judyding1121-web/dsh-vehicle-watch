/**
 * DSH Host-only Cordis bundle：瓜子二手车（西安四车型）新上架/降价监控 + 智能机器人双向指令
 * 定时抓取 → 与已见 listing 对比 → 企微/飞书推送 → Excel 报表
 */
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { createService } from './src/service.js'
import { AibotClient } from './src/aibot.js'
import { createCommandHandler } from './src/commands.js'
import { createLlmAnalyzer } from './src/llm-analyzer.js'

export const name = 'vehicle-watch'
export const inject = ['tools', 'timer']

const Target = z.object({
  id: z.string().required(),
  name: z.string().required(),
  usedCarUrl: z.string().required(),
  referenceOfficialLow: z.natural().default(0),
  referenceOfficialHigh: z.natural().default(0),
  enabled: z.boolean().default(true),
})

export const Config = z.object({
  cityCode: z.string().default('xa'),
  cityName: z.string().default('西安'),
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

  fetch: z.object({
    minGapMs: z.natural().default(2500),
    timeoutMs: z.natural().default(30000),
    userAgent: z.string().default(''),
  }).default({}),

  report: z.object({
    enabled: z.boolean().default(true),
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
    description: '立即扫描一次瓜子二手车（西安四车型），返回本次新上架/降价数量与各车型样本行情。',
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
    description: '查看二手车监控状态：各车型上次扫描时间、西安样本数、中位价、已见车源数、上次运行结果、智能机器人连接状态。',
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
    description: '用最近一次扫描结果重新生成 Excel 报表（二手车监控-最新.xlsx），返回文件路径。',
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

  log.info('vehicle-watch mounted: targets=%d interval=%dh reportDir=%s aibot=%s', config.targets.length, config.scanIntervalHours, reportDir, config.aibot?.enabled ? 'on' : 'off')
}
