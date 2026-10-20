#!/usr/bin/env node
/**
 * 自测：不依赖企业微信回调，默认也不访问外网，直接跑命令处理器，验证：
 * 1) 任意品牌+车型解析（理想L9 → lixiangl9）
 * 2) 多车系查询（宋L → EV/DM-i）
 * 3) 已监控车型精确匹配（小米SU7 不再被“理想”影响）
 * 4) 卡片数量 = 1 概览 + 5 详情
 * 5) pending 是否写入正确候选
 *
 * 默认用固定 fixture 伪造瓜子页面（CI 稳定）；要连真实页面跑：
 *   SELFTEST_ONLINE=1 node scripts/selftest.mjs
 *
 * 运行：node plugins/dsh-vehicle-watch/scripts/selftest.mjs
 */
import assert from 'node:assert/strict'
import { createCommandHandler } from '../src/commands.js'

// ---- 离线 fixture：构造一份最小的 self.__next_f initData 页面，替代真实瓜子请求 ----
const FIXTURE_CARS = Array.from({ length: 6 }, (_, i) => ({
  skuPicArea: { pictureUrl: null },
  skuBasicArea: {
    encryptedClueId: `c17175119629635${i}`,
    title: `小米汽车 小米SU7 2024款 ${['后驱长续航智驾版', 'Pro版', 'Max版'][i % 3]}`,
    licenseDate: '2025年',
    carSourceCityDesc: '西安',
    roadHaul: `${(0.56 + i * 0.2).toFixed(2)}万公里`,
  },
  scoreArea: {},
  priceArea: {
    purchasePrice: { value: String(18 + i), unit: '万', amountMajor: (18 + i) * 10000 },
    discountedAmount: { amountMajor: 5000 + i * 100 },
  },
  skuPredictArea: {},
  liveArea: {},
  bottomArea: {},
  countdownArea: {},
}))

const FIXTURE_PAYLOAD = JSON.stringify({ initData: { page: 1, totalPage: 10, total: 40, carList: FIXTURE_CARS } })
const FIXTURE_HTML = '<html><body><script>self.__next_f.push([1,'
  + JSON.stringify(FIXTURE_PAYLOAD)
  + '])</script></body></html>'

// 车型解析器要抓「城市页 → 品牌页」才拿得到车系链接，离线时也要给出最小可解析页面
const CITY_HTML = '<html><body>'
  + ['lixiang', 'nio', 'xiaomiqiche'].map((slug) => `<a href="/xa/${slug}/">${slug}</a>`).join('')
  + '</body></html>'
const SERIES_HTML = {
  lixiang: '<html><body><a href="/xa/lixiang/lixiangl9/">理想L9</a>'
    + '<script>{"name":"理想L9","value":"lixiangl9"}</script></body></html>',
  nio: '<html><body><a href="/xa/nio/wles8/">蔚来ES8</a>'
    + '<script>{"name":"蔚来ES8","value":"wles8"}</script></body></html>',
}

function fixturePage(url) {
  let u
  try { u = new URL(String(url)) } catch { return FIXTURE_HTML }
  if (!u.hostname.endsWith('guazi.com')) return null
  if (/^\/xa\/?$/.test(u.pathname)) return CITY_HTML
  const m = u.pathname.match(/^\/xa\/([a-z0-9_-]+)\/?$/)
  if (m) return SERIES_HTML[m[1]] ?? '<html></html>'
  return FIXTURE_HTML
}

if (process.env.SELFTEST_ONLINE !== '1') {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const html = fixturePage(input)
    if (html !== null) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    return realFetch(input, init)
  }
}

const NOW = '2026-10-20T12:47:02+08:00'

function makeService({ targets = [], latest = null } = {}) {
  const pendingMap = new Map()
  const sentCards = []
  const added = []
  return {
    sentCards,
    added,
    pendingMap,
    async status() {
      return {
        targets,
        webhooks: { wecom: true },
        lastRun: { scannedAt: NOW },
      }
    },
    async readLatest() {
      return latest
    },
    async pending(key) {
      return pendingMap.get(key) ?? null
    },
    async setPendingEntry(key, value) {
      pendingMap.set(key, { ...value, createdAt: NOW })
      return pendingMap.get(key)
    },
    async clearPendingEntry(key) {
      pendingMap.delete(key)
    },
    async addTargets(candidates) {
      added.push(...candidates)
      return { added: candidates, skipped: [] }
    },
    async scan() {
      return { ok: true }
    },
    async sendCards(cards) {
      sentCards.push(...cards)
      return cards.map(() => ({ wecom: 'ok' }))
    },
  }
}

function makeLatest(target) {
  const listings = Array.from({ length: 6 }, (_, i) => ({
    targetId: target.id, title: `2024款 测试车 ${i + 1}`, modelYear: 2024, trim: 'Pro',
    licenseYear: 2025, mileageKm: 5000 + i * 1000, priceYuan: 180000 + i * 1000,
    detailUrl: `https://www.guazi.com/car-detail/c${i + 1}.html`,
  }))
  return {
    generatedAt: NOW,
    targets: [{
      targetId: target.id, seriesName: target.name, url: target.url,
      price: { min: 180000 }, newListings: listings.slice(0, 3),
    }],
    listings,
  }
}

const SU7 = {
  id: 'xiaomi-su7', name: '小米SU7', url: 'https://www.guazi.com/xa/xiaomiqiche/xiaomisu7/',
  initialized: true, sampleCount: 38, medianPrice: 215350, lastScanAt: NOW,
}

const cases = []
async function test(name, fn) {
  try {
    await fn()
    cases.push({ name, ok: true })
    console.log(`✓ ${name}`)
  } catch (err) {
    cases.push({ name, ok: false, err })
    console.error(`✗ ${name}\n  ${err.message}`)
  }
}

await test('理想L9：解析为 lixiangl9，发 1 概览 + 5 详情，不返回理想i6', async () => {
  const service = makeService({ targets: [SU7] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '@机器人 找个理想L9', chatid: 'g1', from: 'u1' })
  assert.equal(service.sentCards.length, 6, '应发 6 张卡（1 概览 + 5 详情）')
  assert.ok(String(reply.text).includes('5 张详情卡'), '应提示已发 5 张详情卡')
  assert.ok(!JSON.stringify(service.sentCards).includes('理想i6'), '不应出现理想i6')
  assert.ok(service.sentCards[0].card_action.url.includes('lixiangl9'), '概览卡应跳到理想L9车系')
  assert.ok(service.sentCards[1].main_title.title.includes('理想L9'), '详情卡应属于理想L9')
  const pending = service.pendingMap.get('g1:u1')
  assert.ok(pending, '应写入 pending')
  assert.equal(pending.candidates[0].id, 'lixiangl9')
})

await test('宋L：解析出 EV/DM-i 多车系，1 概览 + 5 详情', async () => {
  const service = makeService({ targets: [SU7] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '找宋L', chatid: 'g2', from: 'u2' })
  assert.ok(String(reply.text).includes('5 张详情卡'))
  assert.equal(service.sentCards.length, 6)
  assert.ok(JSON.stringify(service.sentCards).includes('宋L EV'))
  assert.ok(JSON.stringify(service.sentCards).includes('宋L DM-i'))
  const pending = service.pendingMap.get('g2:u2')
  assert.equal(pending.candidates.length, 2)
})

await test('已监控小米SU7：1 概览 + 5 详情卡片', async () => {
  const service = makeService({ targets: [SU7], latest: makeLatest(SU7) })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '看看小米SU7', chatid: 'g3', from: 'u3' })
  assert.equal(service.sentCards.length, 6, '应发 1 概览 + 5 详情')
  assert.ok(service.sentCards[0].main_title.title.includes('小米SU7'))
  assert.ok(String(reply.text).includes('5 张详情卡'))
})

await test('查行情：1 汇总卡 + 5 详情卡', async () => {
  const service = makeService({ targets: [SU7], latest: makeLatest(SU7) })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '查', chatid: 'g4', from: 'u4' })
  assert.equal(service.sentCards.length, 6, '应发 1 概览 + 5 详情')
  assert.ok(service.sentCards[0].main_title.title.includes('行情'))
  assert.ok(String(reply.text).includes('5 张详情卡'))
})

await test('最新：1 概览 + 5 详情卡', async () => {
  const service = makeService({ targets: [SU7], latest: makeLatest(SU7) })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '最新', chatid: 'g5', from: 'u5' })
  assert.equal(service.sentCards.length, 6, '应发 1 概览 + 5 详情')
  assert.ok(String(reply.text).includes('5 张详情卡'))
})


await test('pending 过期后新查询仍应执行（蔚来ES8）', async () => {
  const service = makeService({ targets: [SU7] })
  service.pendingMap.set('g6:u6', { expired: true, candidates: [{ id: 'songl-ev', name: '宋L EV' }] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '你帮我查一个蔚来的那个ES8', chatid: 'g6', from: 'u6' })
  assert.ok(!String(reply.text).includes('询问已过期'), '不应被过期 pending 拦截')
  assert.equal(service.sentCards.length, 6, '应正常查询并发 1+5 张卡')
  assert.ok(service.sentCards[0].main_title.title.includes('蔚来ES8'))
  assert.equal(service.pendingMap.get('g6:u6').candidates[0].id, 'wles8')
})

await test('pending 未过期但用户发新问题：清掉旧询问并执行新查询', async () => {
  const service = makeService({ targets: [SU7] })
  service.pendingMap.set('g7:u7', { candidates: [{ id: 'lixiangl9', name: '理想L9' }] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '我要查蔚来ES8', chatid: 'g7', from: 'u7' })
  assert.equal(service.sentCards.length, 6)
  assert.ok(service.sentCards[0].main_title.title.includes('蔚来ES8'))
  assert.equal(service.pendingMap.get('g7:u7').candidates[0].id, 'wles8')
})


await test('模糊说法：规则失败时用模型解析出理想L9', async () => {
  const service = makeService({ targets: [SU7] })
  const analyzer = async () => ({ brand: '理想', model: 'L9', confidence: 0.9, alternatives: [] })
  const handler = createCommandHandler({ service, log: console, analyzer })
  const reply = await handler({ text: '想买个理想的大六座，有什么二手', chatid: 'g8', from: 'u8' })
  assert.equal(service.sentCards.length, 6, '应发 1+5 张卡')
  assert.ok(service.sentCards[0].main_title.title.includes('理想L9'))
  assert.ok(!String(reply.text).includes('没找到'))
})

await test('模型也解析不出时：提示用户确认车型，不瞎编结果', async () => {
  const service = makeService({ targets: [SU7] })
  const analyzer = async () => ({ brand: '未知', model: '', confidence: 0, alternatives: [{ brand: '理想', model: 'L9' }] })
  const handler = createCommandHandler({ service, log: console, analyzer })
  const reply = await handler({ text: '想买个三十万以内的纯电SUV', chatid: 'g9', from: 'u9' })
  assert.equal(service.sentCards.length, 0)
  const text = typeof reply === 'string' ? reply : (reply.text || '')
  assert.ok(String(text).includes('请回复具体'))
  assert.ok(String(text).includes('理想L9'))
})

const failed = cases.filter((c) => !c.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
if (failed.length) process.exit(1)
