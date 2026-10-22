#!/usr/bin/env node
/**
 * 自测：不依赖企业微信回调，也不访问外网，直接跑命令处理器 + 闲鱼解析/过滤纯函数，验证：
 * 1) 任意品牌+车型解析成闲鱼关键词（理想L9 → lixiangl9 / 理想L9）
 * 2) 口语简称（宋L → EV / DM-i 多车系）
 * 3) 已监控车型精确匹配（小米SU7 不再被“理想”影响）
 * 4) 卡片数量 = 1 概览 + 5 详情
 * 5) pending 是否写入正确候选
 * 6) 非车商品/残值车过滤（床垫、租车、事故车、无关车型）
 *
 * 运行：node scripts/selftest.mjs
 */
import assert from 'node:assert/strict'

import { createCommandHandler } from '../src/commands.js'
import { aggregateListings, filterListings, matchesKeyword, parseXianyuCard, searchUrl } from '../src/xianyu.js'
import { resolveModels } from '../src/model-resolver.js'

const NOW = '2026-10-20T12:47:02+08:00'

/** 造一条“闲鱼搜索结果卡片”，用于解析测试。 */
function rawCard({ id = 'c1', title, area = '雁塔区', price = 180000, time = 1792638407000, tags = ['1天内上新'] }) {
  return {
    data: {
      item: {
        main: {
          exContent: {
            itemId: String(id),
            title,
            area,
            price: [{ text: '¥' }, { text: (price / 10000).toFixed(2) }, { text: '万' }],
            fishTags: { z: { tagList: tags.map((t) => ({ data: { content: t } })) } },
            userNickName: '测试卖家',
            picUrl: null,
          },
          clickParam: {
            args: {
              item_id: String(id),
              displayPrice: String(price),
              publishTime: String(time),
              seller_id: 'seller-1',
            },
          },
        },
      },
    },
  }
}

function fixtureListings(keyword, count = 6) {
  return Array.from({ length: count }, (_, i) => ({
    listingId: `c${i + 1}`,
    title: `${keyword} 2024款 测试车 ${i + 1}`,
    priceYuan: 180000 + i * 1000,
    area: '雁塔区',
    cityDesc: '西安',
    publishTime: 1792638407000,
    seller: '测试卖家',
    wantCount: i * 2,
    tags: ['1天内上新'],
    modelYear: 2024,
    trim: 'Pro',
    licenseYear: 2025,
    mileageKm: 5000 + i * 1000,
    detailUrl: `https://www.goofish.com/item?id=c${i + 1}`,
    priceDropYuan: null,
  }))
}

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
        source: 'xianyu',
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
    async lookup(keyword, { name = keyword } = {}) {
      const all = fixtureListings(keyword)
      const agg = aggregateListings({
        target: { id: keyword, name, keyword },
        listings: all,
        rawCount: all.length + 4,
        pageInfo: { page: 1, total: 128, hasNextPage: true },
        cityName: '西安',
      })
      return { agg, listings: agg.cityListings, keyword }
    },
    async sendCards(cards) {
      sentCards.push(...cards)
      return cards.map(() => ({ wecom: 'ok' }))
    },
  }
}

function makeLatest(target, keyword = target.name) {
  const listings = fixtureListings(keyword).map((l) => ({ ...l, targetId: target.id, seriesName: target.name }))
  return {
    generatedAt: NOW,
    source: 'xianyu',
    city: '西安',
    targets: [{
      targetId: target.id, seriesName: target.name, keyword, url: searchUrl(keyword),
      price: { min: 180000, median: 182500 }, sampleCount: listings.length,
      newListings: listings.slice(0, 3), priceDrops: [],
    }],
    listings,
  }
}

const SU7 = {
  id: 'xiaomi-su7', name: '小米SU7', keyword: '小米SU7', url: searchUrl('小米SU7'),
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
  assert.ok(service.sentCards[0].card_action.url.includes('goofish.com/search'), '概览卡应跳到闲鱼搜索')
  assert.ok(service.sentCards[1].main_title.title.includes('理想L9'), '详情卡应属于理想L9')
  const pending = service.pendingMap.get('g1:u1')
  assert.ok(pending, '应写入 pending')
  assert.equal(pending.candidates[0].id, 'lixiangl9')
  assert.equal(pending.candidates[0].keyword, '理想L9')
})

await test('宋L：解析为「比亚迪宋L」关键词，1 概览 + 5 详情', async () => {
  const service = makeService({ targets: [SU7] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '找宋L', chatid: 'g2', from: 'u2' })
  assert.ok(String(reply.text).includes('5 张详情卡'))
  assert.equal(service.sentCards.length, 6)
  assert.ok(JSON.stringify(service.sentCards).includes('宋L'))
  const pending = service.pendingMap.get('g2:u2')
  assert.equal(pending.candidates.length, 1)
  assert.equal(pending.candidates[0].keyword, '比亚迪宋L')
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
  assert.ok(service.sentCards[0].main_title.title.includes('新上架'))
  assert.ok(String(reply.text).includes('5 张详情卡'))
})

await test('pending 过期后新查询仍应执行（蔚来ES8）', async () => {
  const service = makeService({ targets: [SU7] })
  service.pendingMap.set('g6:u6', { expired: true, candidates: [{ id: 'songl-ev', name: '宋L EV', keyword: '宋L EV' }] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '你帮我查一个蔚来的那个ES8', chatid: 'g6', from: 'u6' })
  assert.ok(!String(reply.text).includes('询问已过期'), '不应被过期 pending 拦截')
  assert.equal(service.sentCards.length, 6, '应正常查询并发 1+5 张卡')
  assert.ok(service.sentCards[0].main_title.title.includes('蔚来ES8'))
  assert.equal(service.pendingMap.get('g6:u6').candidates[0].id, 'nioes8')
})

await test('pending 未过期但用户发新问题：清掉旧询问并执行新查询', async () => {
  const service = makeService({ targets: [SU7] })
  service.pendingMap.set('g7:u7', { candidates: [{ id: 'lixiangl9', name: '理想L9', keyword: '理想L9' }] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '我要查蔚来ES8', chatid: 'g7', from: 'u7' })
  assert.equal(service.sentCards.length, 6)
  assert.ok(service.sentCards[0].main_title.title.includes('蔚来ES8'))
  assert.equal(service.pendingMap.get('g7:u7').candidates[0].id, 'nioes8')
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

await test('闲鱼卡片解析：标题/价格/地区/想要数/年款里程', async () => {
  const card = rawCard({ id: '1092982842778', title: '2024款 小米SU7 四驱Max版 3.8万公里', area: '雁塔区', price: 212800, tags: ['3天内上新', '12人想要'] })
  const listing = parseXianyuCard(card)
  assert.equal(listing.listingId, '1092982842778')
  assert.equal(listing.priceYuan, 212800)
  assert.equal(listing.area, '雁塔区')
  assert.equal(listing.wantCount, 12)
  assert.equal(listing.modelYear, 2024)
  assert.equal(listing.mileageKm, 38000)
  assert.equal(listing.detailUrl, 'https://www.goofish.com/item?id=1092982842778')
})

await test('过滤：非车商品/租车/事故残值/无关车型 都被剔除', async () => {
  const cards = [
    rawCard({ id: '1', title: '小米SU7 2024款 个人一手 2万公里', price: 175000 }),
    rawCard({ id: '2', title: '小米SU7 2025款 准新车', price: 212800 }),
    rawCard({ id: '3', title: '小米SU7充气床垫 9.9新', price: 450 }),
    rawCard({ id: '4', title: '小米SU7 西安租车 350一天', price: 350 }),
    rawCard({ id: '5', title: '小米SU7 事故水淹残值批发', price: 16800 }),
    rawCard({ id: '6', title: '智界R7 2025款 纯电SUV', price: 157000 }),
  ]
  const listings = cards.map(parseXianyuCard).filter(Boolean)
  const kept = filterListings(listings, {
    keyword: '小米SU7', cityName: '西安', minPriceYuan: 30000,
    excludeKeywords: ['租车', '床垫', '事故', '水淹', '残值', '批发'],
  })
  assert.deepEqual(kept.map((l) => l.listingId), ['1', '2'])
  assert.ok(matchesKeyword('小米 Su7 2024款', '小米SU7'))
  assert.ok(!matchesKeyword('智界R7', '小米SU7'))
})

await test('聚合：样本/中位/过滤数正确', async () => {
  const listings = [
    { listingId: '1', title: '小米SU7 A', priceYuan: 170000, area: '雁塔区', tags: [] },
    { listingId: '2', title: '小米SU7 B', priceYuan: 190000, area: '未央区', tags: [] },
    { listingId: '3', title: '小米SU7 C', priceYuan: 210000, area: '雁塔区', tags: [] },
  ]
  const agg = aggregateListings({
    target: { id: 'xiaomi-su7', name: '小米SU7', keyword: '小米SU7' },
    listings, rawCount: 30,
    pageInfo: { page: 1, total: 1338, hasNextPage: true },
    cityName: '西安',
  })
  assert.equal(agg.sampleCount, 3)
  assert.equal(agg.outOfCityCount, 27)
  assert.equal(agg.price.median, 190000)
  assert.equal(agg.pageTotal, 1338)
  assert.equal(agg.cityListings.length, 3)
  assert.equal(agg.url, 'https://www.goofish.com/search?q=' + encodeURIComponent('小米SU7'))
})

await test('关键词解析是纯函数：不联网也能解析品牌+车型', async () => {
  const r1 = await resolveModels('理想L9')
  assert.equal(r1.models[0].keyword, '理想L9')
  const r2 = await resolveModels('你帮我查一个蔚来的那个ES8')
  assert.equal(r2.models[0].keyword, '蔚来ES8')
  const r3 = await resolveModels('想买个理想的大六座')
  assert.equal(r3.models.length, 0)
})

const failed = cases.filter((c) => !c.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
if (failed.length) process.exit(1)
