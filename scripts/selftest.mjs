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
import { renderHtmlReport, renderQueryPage } from '../src/html-report.js'
import { aggregateListings, filterListings, matchesKeyword, parseXianyuCard, parseXianyuDetail, searchUrl } from '../src/xianyu.js'
import { summarizeListing } from '../src/decision.js'
import { resolveModels } from '../src/model-resolver.js'
import { createLlmAnalyzer, normalizeIntent } from '../src/llm-analyzer.js'

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
            picUrl: 'https://image-public.guazistatic.com/test.jpg',
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
    pictureUrl: 'https://image-public.guazistatic.com/test.jpg',
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
  const lookupCalls = []
  return {
    sentCards,
    added,
    pendingMap,
    lookupCalls,
    async status() {
      return {
        source: 'xianyu',
        targets,
        webhooks: { wecom: true },
        dashboard: { enabled: true, url: 'http://192.168.1.10:47800/' },
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
      lookupCalls.push(keyword)
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
      newListings: listings.slice(0, 3),
      priceDrops: [{ listing: listings[4], oldPrice: 190000, newPrice: listings[4].priceYuan }],
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

await test('理想L9：返回一张结果卡，点开是 HTML 车源卡片页', async () => {
  const service = makeService({ targets: [SU7] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '@机器人 找个理想L9', chatid: 'g1', from: 'u1' })
  assert.equal(service.sentCards.length, 0, '不再发多张详情卡')
  assert.ok(reply?.card, '应返回一张卡片')
  assert.ok(reply.card.main_title.title.includes('理想L9'))
  assert.ok(reply.card.card_action.url.includes('/query?q='), '卡片应跳到 HTML 查询结果页')
  assert.ok(decodeURIComponent(reply.card.card_action.url).includes('理想L9'))
  assert.equal(service.pendingMap.size, 0, '不再写入 pending / 不提示加入监控')
  assert.equal(reply.text, '', '不带用法提示')
})

await test('宋L：返回一张结果卡，关键词是「比亚迪宋L」', async () => {
  const service = makeService({ targets: [SU7] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '找宋L', chatid: 'g2', from: 'u2' })
  assert.ok(reply?.card)
  const url = decodeURIComponent(reply.card.card_action.url)
  assert.ok(url.includes('比亚迪宋L'))
  assert.equal(service.pendingMap.size, 0)
})

await test('已监控小米SU7：也返回一张结果卡（不堆文字）', async () => {
  const service = makeService({ targets: [SU7], latest: makeLatest(SU7) })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '看看小米SU7', chatid: 'g3', from: 'u3' })
  assert.equal(service.sentCards.length, 0)
  assert.ok(reply?.card)
  assert.ok(reply.card.main_title.title.includes('小米SU7'))
  assert.ok(decodeURIComponent(reply.card.card_action.url).includes('小米SU7'))
})

await test('查行情：只返回 1 张汇总卡，不向 Webhook 补发详情', async () => {
  const service = makeService({ targets: [SU7], latest: makeLatest(SU7) })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '查', chatid: 'g4', from: 'u4' })
  assert.equal(service.sentCards.length, 0)
  assert.equal(reply.card.card_type, 'button_interaction')
  assert.ok(reply.card.main_title.title.includes('行情'))
  assert.ok(reply.card.button_list.length <= 6)
})

await test('最新：一张卡同时包含新上架与降价', async () => {
  const service = makeService({ targets: [SU7], latest: makeLatest(SU7) })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '最新', chatid: 'g5', from: 'u5' })
  assert.equal(service.sentCards.length, 0)
  assert.equal(reply.card.card_type, 'button_interaction')
  assert.ok(reply.card.main_title.title.includes('最新变化'))
  assert.ok(reply.card.sub_title_text.includes('降价'))
})

await test('AI 意图解析器：能解析 JSON、拒绝坏输出', async () => {
  const goodLlm = {
    stream: () => (async function* () {
      yield { type: 'text-delta', text: '{"intent":"query","brand":"小米","model":"YU7","keyword":"小米YU7","name":"小米YU7","confidence":0.96,"needs_confirmation":false,"alternatives":[]}' }
    })(),
  }
  const analyze = createLlmAnalyzer({ getLlm: () => goodLlm, log: { warn() {} } })
  const intent = await analyze('查个小米御7', { targets: [] })
  assert.equal(intent.intent, 'query')
  assert.equal(intent.keyword, '小米YU7')
  assert.equal(intent.needs_confirmation, false)

  const badLlm = { stream: () => (async function* () { yield { type: 'text-delta', text: '我觉得你想查小米' } })() }
  const analyzeBad = createLlmAnalyzer({ getLlm: () => badLlm, log: { warn() {} } })
  assert.equal(await analyzeBad('随便', {}), null, '坏输出应返回 null，交给确定性兜底')
})

await test('AI 意图解析：御7 → 小米YU7，直接出结果卡', async () => {
  const service = makeService({ targets: [SU7] })
  const analyzer = async () => ({
    intent: 'query', brand: '小米', model: 'YU7', keyword: '小米YU7', name: '小米YU7',
    confidence: 0.96, needs_confirmation: false, alternatives: [],
  })
  const handler = createCommandHandler({ service, analyzer, log: console })
  const reply = await handler({ text: '查个小米御7？', chatid: 'ai1', from: 'u1' })
  assert.ok(service.lookupCalls.includes('小米YU7'), '应按归一化后的关键词查询，而不是字面搜御7')
  assert.ok(!service.lookupCalls.includes('小米御7'))
  assert.ok(reply?.card, '高置信度应直接出结果卡')
  assert.ok(decodeURIComponent(reply.card.card_action.url).includes('小米YU7'))
  assert.equal(service.pendingMap.size, 0, '能确认时不应再询问')
})

await test('AI 意图解析：不确定时先给候选，用户确认后再查', async () => {
  const service = makeService({ targets: [SU7] })
  const analyzer = async () => ({
    intent: 'query', confidence: 0.35, needs_confirmation: true,
    question: '你想看哪款六座 SUV？',
    alternatives: [
      { name: '理想L9', keyword: '理想L9', reason: '六座增程SUV' },
      { name: '问界M9', keyword: '问界M9', reason: '六座增程SUV' },
    ],
  })
  const handler = createCommandHandler({ service, analyzer, log: console })
  const reply = await handler({ text: '想买个六座SUV', chatid: 'ai2', from: 'u2' })
  const text = typeof reply === 'string' ? reply : (reply.text ?? '')
  assert.ok(text.includes('1. 理想L9'))
  assert.ok(text.includes('2. 问界M9'))
  assert.equal(service.lookupCalls.length, 0, '不确定时不应乱查')
  const pending = service.pendingMap.get('ai2:u2')
  assert.equal(pending.kind, 'confirm-query')

  const second = await handler({ text: '1', chatid: 'ai2', from: 'u2' })
  assert.ok(service.lookupCalls.includes('理想L9'), '确认后才查询')
  assert.ok(decodeURIComponent(second.card.card_action.url).includes('理想L9'))
  assert.equal(service.pendingMap.get('ai2:u2'), undefined, '确认后应清 pending')
})

await test('AI 意图解析：watch_add 自动归一化后加入监控', async () => {
  const service = makeService({ targets: [SU7] })
  const analyzer = async () => ({
    intent: 'watch_add', brand: '小米', model: 'YU7', keyword: '小米YU7', name: '小米YU7',
    confidence: 0.95, needs_confirmation: false, alternatives: [],
  })
  const handler = createCommandHandler({ service, analyzer, log: console })
  const reply = await handler({ text: '把YU7加入监控', chatid: 'ai3', from: 'u3' })
  assert.ok(service.added.some((t) => t.keyword === '小米YU7'), '应按归一化关键词加监控')
  assert.ok(String(typeof reply === 'string' ? reply : reply.text).includes('已加入监控'))
})

await test('AI 意图解析：模型输出兼容旧格式/低置信度自动确认', async () => {
  const legacy = normalizeIntent({ brand: '理想', model: 'L9', confidence: 0.9, alternatives: [] })
  assert.equal(legacy.intent, 'query')
  assert.equal(legacy.keyword, '理想L9')
  assert.equal(legacy.needs_confirmation, false)
  const vague = normalizeIntent({ intent: 'query', brand: '蔚来', model: 'ES8', confidence: 0.5 })
  assert.equal(vague.needs_confirmation, true)
})

await test('pending 过期后新查询仍应执行（蔚来ES8）', async () => {
  const service = makeService({ targets: [SU7] })
  service.pendingMap.set('g6:u6', { expired: true, candidates: [{ id: 'songl-ev', name: '宋L EV', keyword: '宋L EV' }] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '你帮我查一个蔚来的那个ES8', chatid: 'g6', from: 'u6' })
  assert.ok(reply?.card)
  assert.ok(reply.card.main_title.title.includes('蔚来ES8'))
  assert.equal(service.sentCards.length, 0)
  assert.equal(service.pendingMap.get('g6:u6'), undefined, '过期 pending 应被清理')
})

await test('pending 未过期但用户发新问题：清掉旧询问并执行新查询', async () => {
  const service = makeService({ targets: [SU7] })
  service.pendingMap.set('g7:u7', { candidates: [{ id: 'lixiangl9', name: '理想L9', keyword: '理想L9' }] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '我要查蔚来ES8', chatid: 'g7', from: 'u7' })
  assert.ok(reply?.card)
  assert.ok(reply.card.main_title.title.includes('蔚来ES8'))
  assert.equal(service.sentCards.length, 0)
  assert.equal(service.pendingMap.get('g7:u7'), undefined, '新查询应清掉旧 pending')
})

await test('AI 意图：模糊需求先给候选，不瞎查', async () => {
  const service = makeService({ targets: [SU7] })
  const analyzer = async () => ({
    intent: 'query', confidence: 0.35, needs_confirmation: true,
    question: '你想看哪款六座 SUV？',
    alternatives: [{ name: '理想L9', keyword: '理想L9', reason: '六座增程' }],
  })
  const handler = createCommandHandler({ service, log: console, analyzer })
  const reply = await handler({ text: '想买个理想的大六座，有什么二手', chatid: 'g8', from: 'u8' })
  const text = typeof reply === 'string' ? reply : (reply.text ?? '')
  assert.ok(text.includes('1. 理想L9'))
  assert.equal(service.lookupCalls.length, 0, '不确定时不应乱查')
  assert.equal(service.pendingMap.get('g8:u8')?.kind, 'confirm-query')
})

await test('AI 意图：低置信度且无候选时只追问，不执行', async () => {
  const service = makeService({ targets: [SU7] })
  const analyzer = async () => ({ intent: 'unknown', confidence: 0.2, needs_confirmation: true, question: '请补充具体车型', alternatives: [] })
  const handler = createCommandHandler({ service, log: console, analyzer })
  const reply = await handler({ text: '想买个三十万以内的纯电SUV', chatid: 'g9', from: 'u9' })
  const text = typeof reply === 'string' ? reply : (reply.text ?? '')
  assert.ok(String(text).includes('请补充具体车型'))
  assert.equal(service.lookupCalls.length, 0)
  assert.equal(service.pendingMap.size, 0)
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
  assert.equal(listing.pictureUrl, 'https://image-public.guazistatic.com/test.jpg')
})

await test('详情解析：车况属性/卖家信誉/热度/描述', async () => {
  const raw = {
    itemDO: {
      itemId: 'c1', title: '2024款 小米SU7 标准版', soldPrice: 198000, itemStatusStr: '在线',
      desc: '个人一手，24年7月上牌，原版原漆，无事故，3.5万公里',
      wantCnt: 12, browseCnt: 320, collectCnt: 4, gmtCreate: 1792852176000,
      cpvLabels: [
        { propertyName: '过户次数', valueName: '0次' },
        { propertyName: '上牌年月', valueName: '2024年 07月' },
        { propertyName: '车源地', valueName: '陕西 西安' },
        { propertyName: '上牌地', valueName: '陕 A' },
        { propertyName: '燃油类型', valueName: '纯电动' },
        { propertyName: '亮点配置', valueName: '真皮座椅' },
      ],
      imageInfos: [{ url: 'http://img.alicdn.com/a.jpg' }],
      commonTags: [{ text: '可自提' }],
    },
    sellerDO: {
      nick: '测试卖家', city: '西安', replyRatio24h: '90%', hasSoldNumInteger: 30,
      zhimaAuth: true, remarkDO: { sellerGoodRemarkCnt: 12, sellerBadRemarkCnt: 0 },
      lastVisitTime: '刚刚擦亮', userRegDay: 3000,
    },
  }
  const d = parseXianyuDetail(raw)
  assert.equal(d.attributes['过户次数'], '0次')
  assert.equal(d.attributes['上牌年月'], '2024年 07月')
  assert.equal(d.seller.nick, '测试卖家')
  assert.equal(d.seller.replyRatio24h, '90%')
  assert.equal(d.browseCount, 320)
  assert.equal(d.images[0], 'https://img.alicdn.com/a.jpg')
  assert.ok(d.desc.includes('原版原漆'))

  const listing = { listingId: 'c1', title: raw.itemDO.title, priceYuan: 198000, detail: d, history: { firstPrice: 210000, previousPrice: 205000, minPrice: 198000, dropCount: 1 } }
  const decision = summarizeListing(listing, { median: 220000 })
  for (const tag of ['一手', '原版原漆', '个人一手', '低于中位10%', '卖家已实名']) {
    assert.ok(decision.tags.includes(tag), `应识别 ${tag}，实际 ${decision.tags.join('/')}`)
  }
  assert.ok(decision.tags.length <= 8)
  const risky = summarizeListing({ ...listing, detail: { ...d, desc: '事故车 泡水 调表 营运' } }, { median: 220000 })
  assert.ok(risky.risks.some((r) => r.includes('事故')))
  assert.ok(risky.risks.some((r) => r.includes('调表')))

  // “无事故/非营运”不能被误判成风险
  const safe = summarizeListing({ ...listing, detail: { ...d, desc: '车况精品，无事故无水淹，非营运，无调表' } }, { median: 220000 })
  assert.equal(safe.risks.length, 0, `不应误报风险：${safe.risks.join('/')}`)
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

await test('HTML 看板：新上架/降价说清楚，车型行情可选展开', async () => {
  const latest = makeLatest(SU7)
  latest.targets[0].newListings = latest.targets[0].newListings.slice(0, 1)
  latest.targets[0].priceDrops = []
  const html = renderHtmlReport({ latest, intervalHours: 2 })
  assert.ok(html.startsWith('<!doctype html>'))
  for (const kw of ['新上架', '降价', '各车型行情', '本轮样本', '小米SU7', '样本明细', '人想要', '卖家：']) {
    assert.ok(html.includes(kw), `看板应包含「${kw}」`)
  }
  assert.ok(html.includes('image-public.guazistatic.com'), '应渲染车源缩略图')
  assert.ok(html.includes('class="car-hit"'), '整张卡片应可点击')
  assert.ok(html.includes('fleamarket://item?id='), '应带闲鱼 App scheme')
  assert.ok(html.includes('data-xianyu-id='), '链接应带 item id 供 App 跳转')
  assert.ok(html.includes('intent://item?id='), 'Android 应使用 intent 唤起闲鱼')
  assert.ok(!html.includes('看车源'), '不再显示多余的操作提示')
  assert.ok(!html.includes('env-tip'), '不再显示企微提示条')
  assert.ok(html.includes('样本中位') || html.includes('低于中位') || html.includes('高于中位'), '应显示与中位价的对比')
  assert.ok(html.includes('https://www.goofish.com/item?id='), '看板应包含闲鱼商品链接')
  assert.ok(!html.includes('>undefined<'), '看板不应出现空字段 undefined')

  const empty = renderHtmlReport({ latest: { ...latest, targets: [{ ...latest.targets[0], newListings: [], priceDrops: [] }] }, intervalHours: 2 })
  assert.ok(empty.includes('本轮没有新上架，也没有降价'))
})

await test('看板指令：返回局域网看板地址', async () => {
  const service = makeService({ targets: [SU7], latest: makeLatest(SU7) })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '看板', chatid: 'g10', from: 'u10' })
  assert.ok(String(reply.text || reply).includes('192.168.1.10:47800'))
})

await test('关键词解析是纯函数：不联网也能解析品牌+车型', async () => {
  const r1 = await resolveModels('理想L9')
  assert.equal(r1.models[0].keyword, '理想L9')
  const r2 = await resolveModels('你帮我查一个蔚来的那个ES8')
  assert.equal(r2.models[0].keyword, '蔚来ES8')
  const r3 = await resolveModels('想买个理想的大六座')
  assert.equal(r3.models.length, 0)
  // 子品牌优先 + 去标点：“比亚迪的方程豹豹8。” → 方程豹豹8
  const r4 = await resolveModels('@车型查询-二狗二手车测试 查这个比亚迪的方程豹豹8。')
  assert.equal(r4.brand, '方程豹')
  assert.equal(r4.models[0].keyword, '方程豹豹8')
})

await test('查询结果页：卡片可点、无用法提示', async () => {
  const html = renderQueryPage({
    keyword: '理想L9',
    agg: { price: { min: 250000, median: 280000 } },
    listings: fixtureListings('理想L9', 3).map((l) => ({ ...l, seriesName: '理想L9', targetId: 'lixiangl9' })),
  })
  assert.ok(html.includes('理想L9'))
  assert.ok(html.includes('class="car-hit"'), '整卡可点')
  assert.ok(html.includes('data-xianyu-id='))
  assert.ok(!html.includes('看车源'), '不要多余操作提示')
  const empty = renderQueryPage({ keyword: '不存在', agg: { price: {} }, listings: [] })
  assert.ok(empty.includes('没搜到在售车源'))
})

await test('查询结果页 0 结果：只显示没搜到，不写 pending', async () => {
  const html = renderQueryPage({ keyword: '方程豹豹8', agg: { price: {} }, listings: [] })
  assert.ok(html.includes('没搜到在售车源'))
  const service = makeService({ targets: [SU7] })
  const handler = createCommandHandler({ service, log: console })
  const reply = await handler({ text: '@机器人 查这个比亚迪的方程豹豹8。', chatid: 'g11', from: 'u11' })
  assert.ok(reply?.card, '返回结果卡')
  assert.equal(service.pendingMap.size, 0)
})

const failed = cases.filter((c) => !c.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
if (failed.length) process.exit(1)
