#!/usr/bin/env node
/** 企业微信交互、监控状态与异步任务离线自测。 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createService } from '../src/service.js'
import { buildMessages } from '../src/notify.js'
import { AibotClient } from '../src/aibot.js'
import { createCommandHandler } from '../src/commands.js'
import { encodeAction } from '../src/card-utils.js'

const silent = { info() {}, warn() {}, error() {} }
const cases = []
async function test(name, fn) {
  try {
    await fn()
    cases.push({ name, ok: true })
    console.log(`✓ ${name}`)
  } catch (err) {
    cases.push({ name, ok: false, err })
    console.error(`✗ ${name}\n  ${err.stack ?? err.message}`)
  }
}

function config(targets) {
  return {
    city: '西安', province: '陕西', targets,
    xianyu: { minGapMs: 0 }, notify: {}, report: { enabled: false, html: false },
  }
}

function serviceFor(dir, targets) {
  return createService({
    config: config(targets), statePath: path.join(dir, 'state.json'),
    reportDir: path.join(dir, 'reports'), reportScriptPath: path.join(dir, 'unused.py'),
    log: silent, xianyuClient: { async search() { throw new Error('not used') } },
  })
}

await test('默认车型取消后停止加载，重新加入后恢复', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-watch-'))
  const su7 = { id: 'xiaomi-su7', name: '小米SU7', keyword: '小米SU7', enabled: true }
  const svc = serviceFor(dir, [su7])
  assert.equal((await svc.loadTargets()).length, 1)
  assert.equal(await svc.removeTarget(su7.id), true, '默认车型也应可取消')
  assert.equal((await svc.loadTargets()).length, 0, '取消后不应继续扫描')
  assert.equal(await svc.removeTarget(su7.id), false, '重复取消应返回 false')
  const restored = await svc.addTargets([su7])
  assert.equal(restored.added.length, 1)
  assert.equal((await svc.loadTargets())[0].id, su7.id, '重新加入后应恢复默认车型')
})

await test('整轮新上架和降价聚合成一张 Webhook 卡', async () => {
  const results = ['小米SU7', '理想i6'].map((name, targetIndex) => ({
    firstRun: false,
    status: 'ok',
    agg: { targetId: `t${targetIndex}`, seriesName: name, sampleCount: 10, url: 'https://www.goofish.com/' },
    newListings: Array.from({ length: 3 }, (_, i) => ({
      listingId: `n${targetIndex}-${i}`, title: `${name} 新车 ${i}`, priceYuan: 180000,
      detailUrl: `https://www.goofish.com/item?id=n${targetIndex}-${i}`,
    })),
    priceDrops: [{ oldPrice: 200000, newPrice: 198000, listing: {
      listingId: `d${targetIndex}`, title: `${name} 降价车`, priceYuan: 198000,
      detailUrl: `https://www.goofish.com/item?id=d${targetIndex}`,
    } }],
  }))
  const messages = buildMessages(results, { maxPush: 2, dashboardUrl: 'https://cars.example.com/?token=x' })
  assert.equal(messages.length, 1, '整轮只能产生一条通知')
  assert.equal(messages[0].card.card_type, 'text_notice')
  assert.ok(messages[0].card.main_title.title.includes('8 个变化'))
  assert.ok(messages[0].card.sub_title_text.includes('降价'))
  assert.ok(messages[0].card.jump_list.length <= 3)
  assert.equal(messages[0].card.card_action.url, 'https://cars.example.com/?token=x')
})

await test('智能机器人主动推送区分群聊和单聊', async () => {
  const frames = []
  const bot = new AibotClient({ botId: 'b', secret: 's', log: silent })
  bot.ws = { readyState: 1, send(raw) { frames.push(JSON.parse(raw)) } }
  assert.equal(await bot.sendToChat({ chatid: 'group-1', chattype: 'group', from: { userid: 'u1' } }, '完成'), true)
  assert.equal(await bot.sendToChat({ chatid: '', chattype: 'single', from: { userid: 'u2' } }, {
    text: '', card: { card_type: 'text_notice', main_title: { title: '完成' } },
  }), true)
  assert.equal(frames[0].cmd, 'aibot_send_msg')
  assert.equal(frames[0].body.chatid, 'group-1')
  assert.equal(frames[0].body.chat_type, 2)
  assert.equal(frames[0].body.msgtype, 'markdown')
  assert.equal(frames[1].body.chatid, 'u2')
  assert.equal(frames[1].body.chat_type, 1)
  assert.equal(frames[1].body.msgtype, 'template_card')
})

await test('模板卡片按钮事件更新原卡并传递动作 key', async () => {
  const frames = []
  let receivedKey = ''
  const bot = new AibotClient({
    botId: 'b', secret: 's', log: silent,
    onEvent: async ({ key }) => {
      receivedKey = key
      return { card: { card_type: 'button_interaction', main_title: { title: '已加入监控' }, button_list: [] } }
    },
  })
  bot.ws = { readyState: 1, send(raw) { frames.push(JSON.parse(raw)) } }
  await bot.handleFrame({
    cmd: 'aibot_event_callback', headers: { req_id: 'event-req-1' },
    body: {
      msgid: 'event-1', chatid: 'group-1', chattype: 'group', from: { userid: 'u1' },
      event: { eventtype: 'template_card_event', eventkey: 'vw:watch_add' },
    },
  })
  assert.equal(receivedKey, 'vw:watch_add')
  assert.equal(frames[0].cmd, 'aibot_respond_update_msg')
  assert.equal(frames[0].headers.req_id, 'event-req-1')
  assert.equal(frames[0].body.response_type, 'update_template_card')
})

await test('手动扫描结束后向原会话推送完成卡', async () => {
  let finishScan
  let scanOptions
  const pushed = []
  const service = {
    async status() { return { targets: [], dashboard: { url: 'https://cars.example.com/?token=x' } } },
    async pending() { return null },
    scan(trigger, options) {
      scanOptions = { trigger, ...options }
      return new Promise((resolve) => { finishScan = resolve })
    },
  }
  const handler = createCommandHandler({
    service, log: silent,
    pushMessage: async (context, message) => { pushed.push({ context, message }) },
  })
  const context = { text: '刷新', chatid: 'group-9', from: 'u9', body: { chattype: 'group' } }
  const reply = await handler(context)
  assert.ok(String(reply).includes('正在扫描'))
  assert.equal(scanOptions.trigger, 'aibot')
  assert.equal(scanOptions.suppressNotify, true, '手动扫描不能再去固定 Webhook 重复推送')
  finishScan({ ok: true, targets: 2, okTargets: 2, failedTargets: 0, newListings: 0, priceDrops: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].context.chatid, 'group-9')
  assert.ok(pushed[0].message.card.main_title.title.includes('扫描完成'))
  assert.ok(pushed[0].message.card.sub_title_text.includes('没有新上架'))
})

await test('加入监控按钮立即更新原卡，首次扫描在后台完成并推送', async () => {
  let finishScan
  let scanOptions
  const pushed = []
  const added = []
  const service = {
    async status() { return { targets: [], allTargets: [], dashboard: { url: 'https://cars.example.com/?token=x' } } },
    async addTargets(candidates) { added.push(...candidates); return { added: candidates, skipped: [] } },
    scan(trigger, options) { scanOptions = { trigger, ...options }; return new Promise((resolve) => { finishScan = resolve }) },
  }
  const handler = createCommandHandler({ service, log: silent, pushMessage: async (_context, message) => pushed.push(message) })
  const reply = await handler.handleEvent({ key: encodeAction('watch_add', { name: '蔚来ES8', keyword: '蔚来ES8' }), chatid: 'g8' })
  assert.equal(added[0].keyword, '蔚来ES8')
  assert.ok(reply.card.sub_title_text.includes('已在监控中'))
  assert.ok(reply.card.main_title.desc.includes('正在建立'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scanOptions.targetId, added[0].id)
  assert.equal(scanOptions.suppressNotify, true)
  assert.equal(pushed.length, 0, '首次扫描未完成前不能推完成卡')
  finishScan({ ok: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pushed.length, 1)
  assert.ok(pushed[0].card.main_title.desc.includes('已加入'))
})

await test('刷新查询按钮绕过缓存并推送新结果', async () => {
  const pushed = []
  let options
  const service = {
    async status() { return { targets: [], allTargets: [], dashboard: { url: 'https://cars.example.com/?token=x' } } },
    async lookup(_keyword, opts) { options = opts; return { agg: { sampleCount: 3, price: { median: 200000, min: 190000 } } } },
  }
  const handler = createCommandHandler({ service, log: silent, pushMessage: async (_context, message) => pushed.push(message) })
  const reply = await handler.handleEvent({ key: encodeAction('query_refresh', { name: '理想L9', keyword: '理想L9' }), chatid: 'g9' })
  assert.ok(reply.card.main_title.desc.includes('正在刷新'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(options.force, true)
  assert.equal(pushed.length, 1)
  assert.ok(pushed[0].card.main_title.desc.includes('3 台'))
})

await test('监控按钮切换真实状态，重复事件不会重复执行', async () => {
  let enabledValue
  const service = {
    async status() { return { targets: [], allTargets: [{ id: 'su7', name: '小米SU7', keyword: '小米SU7', enabled: false }], dashboard: {} } },
    async setTargetEnabled(_id, enabled) { enabledValue = enabled; return true },
  }
  const handler = createCommandHandler({ service, log: silent })
  const reply = await handler.handleEvent({ key: encodeAction('monitor_toggle', { id: 'su7' }) })
  assert.equal(enabledValue, true)
  assert.equal(reply.card.card_type, 'button_interaction')

  let calls = 0
  const bot = new AibotClient({ botId: 'b', secret: 's', log: silent, onEvent: async () => { calls += 1; return null } })
  const frame = { cmd: 'aibot_event_callback', headers: { req_id: 'r1' }, body: { msgid: 'same', event: { eventkey: 'x' } } }
  await bot.handleFrame(frame)
  await bot.handleFrame(frame)
  assert.equal(calls, 1)
})

const failed = cases.filter((x) => !x.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
if (failed.length) process.exitCode = 1
