import { resolveModels } from './model-resolver.js'
import { callbackButton, decodeAction, toButtonCard, urlButton } from './card-utils.js'

const GOOFISH_HOME = 'https://www.goofish.com/'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CATALOG = [
  { id: 'songl', name: '宋L', keyword: '比亚迪宋L', referenceOfficialLow: 139800, referenceOfficialHigh: 249800 },
]

const HELP = [
  '【二手车监控 · 指令】',
  '查 / 行情 / 状态：已监控车型的闲鱼样本与中位价',
  '最新 / 新上架：查看新上架和降价',
  '找宋L：查询宋L 行情；结果卡可直接加入监控',
  '监控 / 监控管理：查看、暂停或恢复车型',
  '扫描 / 刷新：立即抓一次，完成后在原会话通知',
  '看板：打开「动态 / 全部车源 / 监控」手机页面',
  '取消：取消当前待确认操作',
  '帮助：显示这条',
].join('\n')

function wan(yuan) {
  return yuan == null ? '—' : (yuan / 10000).toFixed(2) + '万'
}

function shortTime(iso) {
  return iso ? String(iso).slice(0, 16).replace('T', ' ') : '—'
}

function slugTargetId(keyword) {
  const ascii = String(keyword).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const hex = Buffer.from(String(keyword), 'utf8').toString('hex').slice(0, 12)
  return `w-${ascii ? `${ascii}-` : ''}${hex}`
}

function keywordUrl(keyword) {
  return `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`
}

function normalize(text) {
  return String(text ?? '').replace(/@\S+/g, ' ').replace(/\s+/g, '').toLowerCase()
}

function isConfirmText(text) {
  return /^[0-9]$/.test(text) ||
    /^(加入|不加入|不要|不加|取消|算了|两个|两个都加|都加|全加|要|是|好|可以|行)$/.test(text)
}

function listingLine(l, index) {
  const parts = [
    l.modelYear ? `${l.modelYear}款` : null,
    l.trim,
    l.licenseYear ? `${l.licenseYear}年` : null,
    l.mileageKm != null ? `${(l.mileageKm / 10000).toFixed(2)}万km` : null,
    wan(l.priceYuan),
  ].filter(Boolean)
  return `${index + 1}. ${parts.join('｜')}\n   ${l.detailUrl ?? ''}`
}

function clip(text, max) {
  const chars = Array.from(String(text ?? ''))
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('')
}

/** 查询结果卡片：一个卡片里放多个车系的样本/中位/最低，附车系跳转。 */
function lookupCard(items, todo, title = '西安二手车') {
  if (!items.length) return null
  const multi = items.length > 1
  const rows = items.slice(0, 5).map(({ candidate, agg }) => ({
    keyname: clip(candidate.name.replace('宋L ', ''), 5),
    value: clip(`${agg.sampleCount}台｜中位${wan(agg.price?.median)}｜最低${wan(agg.price?.min)}`, 26),
  }))
  const jumps = items.slice(0, 3).map(({ candidate }) => ({
    type: 1,
    title: clip(`${candidate.name} 车源`, 13),
    url: candidate.usedCarUrl,
  }))
  const question = todo.length === 1
    ? '要加入长期监控吗？回复：1 加入 / 2 不加入'
    : `要加入长期监控吗？回复：${todo.map((c, i) => `${i + 1} ${c.name}`).join(' / ')} / ${todo.length + 1} 都不加`
  return {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 卖家报价', desc_color: 0 },
    main_title: {
      title: clip(multi ? `${title} · 实时行情` : `${items[0].candidate.name} · 实时行情`, 26),
      desc: '临时查询，不加入监控',
    },
    emphasis_content: { title: clip(String(items.length), 10), desc: '个车系' },
    sub_title_text: clip(question, 112),
    horizontal_content_list: rows,
    jump_list: jumps,
    card_action: { type: 1, url: items[0].candidate.usedCarUrl },
  }
}

/** 把商品详情 URL 换成看板服务器的 /go 落地页：在浏览器里会尝试唤起闲鱼 App。 */
function landingUrl(itemUrl, base) {
  if (!base) return itemUrl
  const m = String(itemUrl ?? '').match(/[?&]id=([A-Za-z0-9_-]+)/)
  if (!m) return itemUrl
  try { return new URL(`go?id=${m[1]}`, base).href } catch { return itemUrl }
}

function detailCard({ candidate, listing, landingBase = '' }) {
  const rawUrl = listing.detailUrl || candidate?.usedCarUrl || candidate?.url || GOOFISH_HOME
  const url = landingUrl(rawUrl, landingBase)
  const title = listing.title || [listing.modelYear ? `${listing.modelYear}款` : null, listing.trim].filter(Boolean).join(' ')
  const area = listing.area || '西安'
  const want = listing.wantCount != null ? `${listing.wantCount}人想要` : null
  return {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 卖家报价', desc_color: 0 },
    main_title: {
      title: clip(`${candidate?.name ?? listing.seriesName ?? '闲鱼车源'} · 最低价`, 26),
      desc: clip(title || candidate?.name || '闲鱼车源', 30),
    },
    emphasis_content: { title: clip(wan(listing.priceYuan), 10), desc: '卖家报价' },
    sub_title_text: clip([area, listing.licenseYear ? `${listing.licenseYear}年上牌` : null, want].filter(Boolean).join('｜'), 112),
    horizontal_content_list: [
      { keyname: '地区', value: area },
      { keyname: '上牌', value: listing.licenseYear ? `${listing.licenseYear}年` : '—' },
      { keyname: '里程', value: listing.mileageKm != null ? `${(listing.mileageKm / 10000).toFixed(2)}万km` : '—' },
      { keyname: '想要', value: want ?? '—' },
    ],
    jump_list: [{ type: 1, title: '查看闲鱼商品', url }],
    card_action: { type: 1, url },
  }
}

/** 多个车系轮流取最低价，最多 5 张详情卡，避免全被低价车系占满。 */
function pickDetailCards(items, max = 5) {
  const pools = items.map((x) => ({ candidate: x.candidate, listings: [...x.cheapest] }))
  const out = []
  while (out.length < max && pools.some((p) => p.listings.length)) {
    for (const pool of pools) {
      if (out.length >= max) break
      const listing = pool.listings.shift()
      if (listing) out.push({ candidate: pool.candidate, listing })
    }
  }
  return out
}

function candidateOf(target) {
  return { id: target.targetId ?? target.id, name: target.seriesName ?? target.name, usedCarUrl: target.url }
}

/** 从最近一次扫描中取车源，按车系轮流取，最多 limit 台。 */
function collectListings(latestData, status, targetId = null, preferNew = false, limit = 5) {
  const candidates = new Map()
  for (const t of status?.targets ?? []) candidates.set(t.id, { id: t.id, name: t.name, usedCarUrl: t.url })
  for (const t of latestData?.targets ?? []) {
    if (!candidates.has(t.targetId)) candidates.set(t.targetId, { id: t.targetId, name: t.seriesName, usedCarUrl: t.url })
  }
  const pools = []
  for (const t of latestData?.targets ?? []) {
    if (targetId && t.targetId !== targetId) continue
    const candidate = candidates.get(t.targetId) ?? { id: t.targetId, name: t.seriesName, usedCarUrl: t.url }
    const source = preferNew
      ? (t.newListings ?? [])
      : (latestData.listings ?? []).filter((l) => l.targetId === t.targetId && l.priceYuan)
    const listings = source
      .filter((l) => l && l.detailUrl && l.priceYuan)
      .sort((a, b) => a.priceYuan - b.priceYuan)
    if (listings.length) pools.push({ candidate, listings })
  }
  const out = []
  while (out.length < limit && pools.some((p) => p.listings.length)) {
    for (const pool of pools) {
      if (out.length >= limit) break
      const listing = pool.listings.shift()
      if (listing) out.push({ candidate: pool.candidate, listing })
    }
  }
  return out
}

async function sendQueryCards(service, status, overviewCard, details, text) {
  if (status.webhooks?.wecom && details.length && typeof service.sendCards === 'function') {
    try {
      const sent = await service.sendCards([overviewCard, ...details])
      if (sent.every((r) => r?.wecom === 'ok')) return { text, card: null }
    } catch (err) {
      log.warn?.('send query cards failed: %s', err.message)
    }
  }
  return { text, card: overviewCard }
}

/** 单次查询结果卡：智能机器人只回复这一张，详情统一进入看板。 */
function queryCard({ name, desc = '西安 · 闲鱼在售', url, keyword = name, watched = false }) {
  const targetUrl = url || keywordUrl(keyword || name)
  const card = {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 实时查询', desc_color: 0 },
    main_title: { title: clip(name, 26), desc: clip(desc, 30) },
    emphasis_content: { title: '查看', desc: '在售车源' },
    sub_title_text: watched ? '已在监控中；新上架和降价会自动提醒。' : '临时查询，尚未加入长期监控。',
    jump_list: [{ type: 1, title: '查看车源', url: targetUrl }],
    card_action: { type: 1, url: targetUrl },
  }
  return toButtonCard(card, [
    urlButton('查看全部', targetUrl),
    watched ? null : callbackButton('加入监控', 'watch_add', { name, keyword: keyword || name }),
    callbackButton('刷新', 'query_refresh', { name, keyword: keyword || name }),
  ])
}

/** 查询结果页地址（看板服务提供 /query），保留看板鉴权参数。 */
function queryPageUrl(status, keyword) {
  const base = status?.dashboard?.url
  if (!base || !keyword) return null
  try {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/query`.replace(/\/+/g, '/')
    url.searchParams.set('q', keyword)
    return url.href
  } catch { return null }
}

function monitorCard(status) {
  const targets = status.allTargets ?? status.targets ?? []
  const enabled = targets.filter((t) => t.enabled !== false)
  const rows = targets.slice(0, 6).map((t) => ({
    keyname: clip(t.name, 5),
    value: t.enabled === false ? '已暂停' : (t.initialized === false ? '监控中｜待扫描' : '监控中'),
  }))
  const homeUrl = status.dashboard?.url || GOOFISH_HOME
  const card = {
    card_type: 'text_notice',
    source: { desc: '二手车监控 · 管理', desc_color: 0 },
    main_title: { title: '监控管理', desc: `${enabled.length} 个启用｜${targets.length - enabled.length} 个暂停` },
    emphasis_content: { title: String(enabled.length), desc: '个监控车型' },
    sub_title_text: clip('按钮可切换前 5 个车型；完整清单和新增入口请打开看板。', 112),
    horizontal_content_list: rows,
    card_action: { type: 1, url: homeUrl },
  }
  return toButtonCard(card, [
    ...targets.slice(0, 4).map((t) => callbackButton(`${t.enabled === false ? '恢复' : '暂停'}${clip(t.name, 5)}`, 'monitor_toggle', { id: t.id })),
    urlButton('看板管理', homeUrl),
    callbackButton('刷新清单', 'monitor'),
  ])
}

function summaryCard(status) {
  const rows = status.targets.slice(0, 6).map((t) => ({
    keyname: clip(t.name, 5),
    value: clip(`${t.initialized === false ? '待扫描' : `${wan(t.medianPrice)}｜${t.sampleCount}台`}`, 26),
  }))
  const jumps = status.targets.slice(0, 3).filter((t) => t.url).map((t) => ({ type: 1, title: clip(`${t.name} 车源`, 13), url: t.url }))
  const homeUrl = status.dashboard?.url || jumps[0]?.url || GOOFISH_HOME
  const card = {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 卖家报价', desc_color: 0 },
    main_title: { title: '西安二手车行情', desc: `${status.targets.length} 个车型｜样本内` },
    emphasis_content: { title: clip(String(status.targets.filter((t) => t.initialized !== false).length), 10), desc: '个在监控' },
    sub_title_text: clip('发车型名查询；新上架和降价会自动聚合提醒。', 112),
    horizontal_content_list: rows,
    jump_list: jumps,
    card_action: { type: 1, url: homeUrl },
  }
  return toButtonCard(card, [
    urlButton('查看全部', homeUrl),
    callbackButton('监控管理', 'monitor'),
    callbackButton('刷新', 'scan'),
  ])
}

function targetCard(target, listings, latestTarget) {
  const lowest = latestTarget?.price?.min
  const rows = [
    { keyname: '样本', value: `${target.sampleCount ?? 0} 台` },
    { keyname: '中位', value: wan(target.medianPrice) },
    { keyname: '最低', value: wan(lowest) },
    { keyname: '上次', value: shortTime(target.lastScanAt).slice(5) },
  ]
  const jumps = listings.slice(0, 3).filter((l) => l.detailUrl).map((l) => ({
    type: 1,
    title: clip(`${l.modelYear ? l.modelYear + '款' : ''}${l.trim ?? ''} ${wan(l.priceYuan)}`, 13),
    url: l.detailUrl,
  }))
  return {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 卖家报价', desc_color: 0 },
    main_title: { title: clip(`${target.name} · 西安行情`, 26), desc: clip(`样本 ${target.sampleCount ?? 0} 台｜中位 ${wan(target.medianPrice)}`, 30) },
    emphasis_content: { title: clip(wan(lowest), 10), desc: '最低卖家报价' },
    sub_title_text: clip('最低价 3 台见下方按钮；回复“最新”看新增。', 112),
    horizontal_content_list: rows,
    jump_list: jumps,
    card_action: { type: 1, url: jumps[0]?.url ?? target.url ?? 'https://www.goofish.com/' },
  }
}

function latestCard(latestData, status) {
  const targets = latestData.targets ?? []
  const newCount = targets.reduce((n, t) => n + (t.newListings ?? []).length, 0)
  const dropCount = targets.reduce((n, t) => n + (t.priceDrops ?? []).length, 0)
  const rows = targets.filter((t) => (t.newListings ?? []).length || (t.priceDrops ?? []).length).slice(0, 6).map((t) => ({
    keyname: clip(t.seriesName, 5),
    value: `新上 ${(t.newListings ?? []).length}｜降价 ${(t.priceDrops ?? []).length}`,
  }))
  const homeUrl = status?.dashboard?.url || targets.find((t) => t.url)?.url || GOOFISH_HOME
  const card = {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 最近一轮扫描', desc_color: 0 },
    main_title: { title: '最新变化', desc: `${newCount + dropCount} 个变化｜新上 ${newCount}｜降价 ${dropCount}` },
    emphasis_content: { title: clip(String(newCount + dropCount), 10), desc: '新上架＋降价' },
    sub_title_text: clip(`新上架 ${newCount} 台｜降价 ${dropCount} 台；点击查看完整车源。`, 112),
    horizontal_content_list: rows,
    jump_list: [{ type: 1, title: '查看全部变化', url: homeUrl }],
    card_action: { type: 1, url: homeUrl },
  }
  return toButtonCard(card, [urlButton('查看全部', homeUrl), callbackButton('刷新', 'scan')])
}

function scanResultCard(summary, status) {
  const busy = summary?.busy
  const ok = summary?.ok
  const newCount = summary?.newListings ?? 0
  const dropCount = summary?.priceDrops ?? 0
  const errors = (summary?.errors ?? []).map((e) => `${e.name}：${e.error}`).join('\n')
  const homeUrl = status?.dashboard?.url || GOOFISH_HOME
  const title = busy ? '扫描未开始' : (ok ? `扫描完成｜${summary.okTargets}/${summary.targets} 成功` : '扫描失败')
  const desc = busy
    ? '上一轮扫描仍在进行'
    : (ok ? `新上架 ${newCount} 台｜降价 ${dropCount} 台` : '上一份看板和报表已保留')
  const sub = busy
    ? '无需重复操作，上一轮完成后会推送结果。'
    : (ok
      ? (newCount + dropCount ? '变化车源已更新，点击查看全部。' : '本次没有新上架，也没有降价。')
      : clip(errors || summary?.message || '请稍后重试。', 112))
  const card = {
    card_type: 'text_notice',
    source: { desc: '二手车监控 · 手动扫描', desc_color: 0 },
    main_title: { title: clip(title, 26), desc: clip(desc, 30) },
    emphasis_content: { title: busy ? '进行中' : (ok ? String(newCount + dropCount) : '失败'), desc: busy ? '请稍候' : '个变化' },
    sub_title_text: clip(sub, 112),
    horizontal_content_list: [],
    jump_list: [{ type: 1, title: '打开看板', url: homeUrl }],
    card_action: { type: 1, url: homeUrl },
  }
  return toButtonCard(card, [urlButton('查看全部', homeUrl), busy ? null : callbackButton('再次扫描', 'scan')])
}

/** 车型目录匹配：宋L 默认同时匹配 EV / DM-i；明确提到 EV 或 DM 时只取一个。 */
function matchCatalog(text) {
  if (!/宋l|songl/.test(text)) return []
  const wantsDm = /dm-?i|dm/.test(text)
  const wantsEv = /ev/.test(text)
  if (wantsDm && !wantsEv) return CATALOG
  if (wantsEv && !wantsDm) return CATALOG
  return CATALOG
}

function detectConfigured(text, status) {
  const rules = [
    { id: 'xiaomi-su7', re: /小米su7|su7/, exclude: /ultra/ },
    { id: 'lixiang-i6', re: /理想i6|i6/ },
    { id: 'aito-m7', re: /问界m7|m7/ },
    { id: 'zeekr-001', re: /极氪001|001/ },
    { id: 'songl', re: /宋l|songl/ },
  ]
  const hit = rules.find((r) => r.re.test(text) && !(r.exclude && r.exclude.test(text)))
  return hit ? status.targets.find((t) => t.id === hit.id) ?? null : null
}

export function createCommandHandler({ service, log = console, analyzer = null, pushMessage = null }) {
  function startScan(context) {
    const scanning = service.scan('aibot', { suppressNotify: true })
    scanning.then(async (summary) => {
      const status = await service.status()
      const message = { text: '', card: scanResultCard(summary, status) }
      if (pushMessage) await pushMessage(context, message)
      else log.info?.('aibot scan done: new=%d drop=%d', summary.newListings ?? 0, summary.priceDrops ?? 0)
    }).catch(async (err) => {
      log.warn?.('aibot scan failed: %s', err.message)
      if (pushMessage) {
        const status = await service.status()
        await pushMessage(context, { text: '', card: scanResultCard({ ok: false, message: err.message, errors: [] }, status) })
      }
    }).catch((err) => log.warn?.('aibot scan completion push failed: %s', err.message))
    const count = Array.isArray(context?.targets) ? context.targets.length : null
    return `正在扫描${count ? ` ${count} 个` : '已监控'}车型，完成后会在此会话通知你。`
  }

  async function summary() {
    const status = await service.status()
    return { text: '', card: summaryCard(status) }
  }

  async function latest() {
    const latestData = await service.readLatest()
    if (!latestData) return '还没有扫描结果，回复“扫描”先抓一次。'
    const status = await service.status()
    return { text: '', card: latestCard(latestData, status) }
  }

  async function targetReply(targetId) {
    const status = await service.status()
    const target = status.targets.find((t) => t.id === targetId)
    if (!target) return '没找到这个车型。'
    if (!target.initialized) return `${target.name} 还没扫描过，回复“扫描”先抓一次。`
    const latestData = await service.readLatest()
    const listings = (latestData?.listings ?? [])
      .filter((l) => l.targetId === targetId && l.priceYuan)
      .sort((a, b) => a.priceYuan - b.priceYuan)
      .slice(0, 3)
    const lines = [
      `【${target.name} · 西安】`,
      `样本 ${target.sampleCount} 台｜中位 ${wan(target.medianPrice)}`,
      `上次扫描 ${shortTime(target.lastScanAt)}`,
      '',
      '最低价 3 台：',
    ]
    if (!listings.length) lines.push('暂无明细（先回复“扫描”）')
    for (const [i, l] of listings.entries()) lines.push(listingLine(l, i))
    const lt = latestData?.targets?.find((x) => x.targetId === targetId)
    const picked = collectListings(latestData, status, targetId, false, 5)
    const details = picked.map((x) => detailCard({ ...x, landingBase: status.dashboard?.url || '' }))
    if (details.length) {
      return sendQueryCards(service, status, targetCard(target, listings, lt), details, `已发${target.name}概览卡 + ${details.length} 张详情卡到群里。`)
    }
    return { text: lines.join('\n'), card: targetCard(target, listings, lt) }
  }

  async function lookup(candidates, status, title = '闲鱼二手车') {
    const already = new Set(status.targets.map((t) => t.id))
    const todo = candidates.filter((c) => !already.has(c.id))
    if (!todo.length) {
      const lines = ['这几个车型已经在监控里：']
      for (const c of candidates) {
        const t = status.targets.find((x) => x.id === c.id)
        lines.push(`${c.name}：中位 ${wan(t?.medianPrice)}｜样本 ${t?.sampleCount ?? 0} 台`)
      }
      return lines.join('\n')
    }
    const lines = ['【闲鱼二手车 · 实时查询】', '说明：临时抓取闲鱼搜索结果；卡片会经落地页尝试打开闲鱼 App（企微内需先在浏览器打开）。', '']
    const items = []
    let failed = 0
    for (const c of todo) {
      try {
        const candidate = { ...c, usedCarUrl: keywordUrl(c.keyword) }
        const { agg, listings } = await service.lookup(c.keyword, { name: c.name })
        const cheapest = listings
          .filter((l) => l.priceYuan)
          .sort((a, b) => a.priceYuan - b.priceYuan)
          .slice(0, 5)
        lines.push(`【${c.name}】样本 ${agg.sampleCount} 台｜中位 ${wan(agg.price?.median)}｜最低 ${wan(agg.price?.min)}`)
        for (const [i, l] of cheapest.slice(0, 2).entries()) lines.push(listingLine(l, i))
        lines.push('')
        items.push({ candidate, agg, cheapest })
      } catch (err) {
        failed += 1
        lines.push(`【${c.name}】查询失败：${err.message}`)
      }
    }

    // 完全没结果：直接说清楚，不要让用户“加入监控”一个搜不到车的关键词
    if (!items.length) {
      return {
        text: `${lines.join('\n')}\n\n${failed ? '查询失败，请稍后再试或检查网络。' : '没搜到车源。'}`,
        card: null,
        noResults: true,
      }
    }
    if (items.every((x) => (x.agg.sampleCount ?? 0) === 0)) {
      const names = todo.map((c) => c.name).join(' / ')
      const text = `${lines.join('\n')}\n没搜到「${names}」的西安在售车源。可能是关键词太具体或闲鱼暂无在售，换个更短的关键词（例如只发车型名）再试试。`
      return { text, card: null, noResults: true }
    }

    lines.push(todo.length === 1
      ? '要加入长期监控吗？回复：1 加入 / 2 不加入'
      : `要加入长期监控吗？回复：${todo.map((c, i) => `${i + 1} ${c.name}`).join(' / ')} / ${todo.length + 1} 都不加`)
    const text = lines.join('\n')
    const card = lookupCard(items, todo, title)
    const detailCards = pickDetailCards(items, 5).map((x) => detailCard({ ...x, landingBase: status.dashboard?.url || '' }))
    const question = todo.length === 1
      ? '要加入长期监控吗？回复：1 加入 / 2 不加入'
      : `要加入长期监控吗？回复：${todo.map((c, i) => `${i + 1} ${c.name}`).join(' / ')} / ${todo.length + 1} 都不加`

    // 有 webhook 时：概览卡 + 5 张单条车源卡走群消息（稳定、可点）；
    // 智能机器人再用文字问“是否加入”。没有 webhook 则退回单张卡片。
    if (status.webhooks?.wecom && typeof service.sendCards === 'function' && detailCards.length) {
      try {
        const sent = await service.sendCards([card, ...detailCards])
        if (sent.every((r) => r?.wecom === 'ok')) {
          return { text: `已发概览卡 + ${detailCards.length} 张详情卡到群里。
${question}`, card: null }
        }
      } catch (err) {
        log.warn?.('send lookup cards failed: %s', err.message)
      }
    }
    return { text, card }
  }

  function dashboardReply(status) {
    const d = status.dashboard
    if (!d?.url) return '看板服务未启动：检查 dashboard.enabled 是否关闭、端口是否被占用（日志搜 dashboard）。'
    const lines = ['看板（本轮新上架 / 降价，手机可直接看）：', d.url]
    if (d.stable) lines.push('公网固定地址（可长期收藏），每轮扫描后自动更新。')
    else if (d.publicUrl) lines.push('公网临时地址，每轮扫描后自动更新；若失效，重发「看板」获取新地址。')
    else if (d.publicPending) lines.push('公网隧道启动中（约 10–20 秒），稍后重发「看板」即可拿到公网地址。')
    else lines.push('当前是局域网地址：手机需与 Mac 同一 Wi-Fi；公网隧道未启动（检查 cloudflared 或 dashboard.public）。')
    return lines.join('\n')
  }

  /** 看板公网隧道可能刚启动：等它就绪再发链接，避免“链接很快生成但打不开”。 */
  async function waitDashboardReady(status, timeoutMs = 60000) {
    let current = status
    if (!current?.dashboard?.publicPending) return current
    const deadline = Date.now() + timeoutMs
    while (current.dashboard?.publicPending && Date.now() < deadline) {
      await sleep(500)
      current = await service.status()
    }
    return current
  }

  /** 按 AI 归一化后的关键词直接查，结果卡带样本/中位/最低。 */
  async function queryByKeyword(keyword, name, status, { force = false } = {}) {
    if (!keyword) return '请补充具体车型（品牌+车系，例如 小米YU7）。'
    let result
    try {
      result = await service.lookup(keyword, { name: name || keyword, enrich: true, force })
    } catch (err) {
      log.warn?.('query %s failed: %s', keyword, err.message)
      return `查询「${name || keyword}」失败：${err.message}`
    }
    const sample = result?.agg?.sampleCount ?? 0
    const title = name || keyword
    if (!sample) return { text: `没搜到「${title}」的西安在售车源。可以换个说法，或直接发“品牌+车型”。`, noResults: true }

    // 单次查询优先发独立 HTML 文件：不依赖看板/隧道链接，打开就是完整车源卡片页
    if (status.webhooks?.wecom && typeof service.writeQueryFile === 'function' && typeof service.sendFile === 'function') {
      try {
        const file = await service.writeQueryFile({ keyword, agg: result.agg, listings: result.listings })
        const sent = await service.sendFile(file)
        if (sent?.wecom === 'ok') return { text: '已生成 HTML 结果文件，发到群里了。', card: null, noResults: false }
        log.warn?.('send query file failed: %s', sent?.wecom ?? 'unknown')
      } catch (err) {
        log.warn?.('query file failed: %s', err.message)
      }
    }

    // 文件发不出去时才退回看板卡片；等待公网链接就绪，避免早期不可用链接
    status = await waitDashboardReady(status, 60000)
    return {
      text: '',
      card: queryCard({
        name: title,
        keyword,
        desc: `${sample} 台 · 中位 ${wan(result.agg.price?.median)} · 最低 ${wan(result.agg.price?.min)}`,
        url: queryPageUrl(status, keyword) || keywordUrl(keyword),
        watched: status.targets.some((t) => normalize(t.keyword) === normalize(keyword)),
      }),
    }
  }

  /** 不确定时先确认：给出候选编号，等用户选；选完再执行查询/加监控。 */
  async function confirmChoice(intent, status, key, mode = 'query') {
    const alts = (intent.alternatives ?? []).filter((a) => a?.keyword)
    if (!alts.length) {
      return intent.question || '请补充具体车型（品牌+车系，例如 小米YU7）。'
    }
    const candidates = alts.map((a) => ({ id: slugTargetId(a.keyword), name: a.name || a.keyword, keyword: a.keyword, reason: a.reason || '' }))
    await service.setPendingEntry(key, { kind: mode === 'watch' ? 'confirm-watch' : 'confirm-query', candidates })
    const lines = ['我需要确认一下你找的是哪款：', '']
    for (const [i, c] of candidates.entries()) lines.push(`${i + 1}. ${c.name}${c.reason ? `（${c.reason}）` : ''}`)
    lines.push('', '回复编号即可；也可以直接发“品牌+车型”。')
    return lines.join('\n')
  }

  async function handleQueryConfirm(pending, normalized, key) {
    const candidates = pending.candidates ?? []
    if (/取消|算了|不用|^0$/.test(normalized)) {
      await service.clearPendingEntry(key)
      return '好的，已取消。'
    }
    let chosen = null
    if (/^[1-9]$/.test(normalized)) chosen = candidates[Number(normalized) - 1] ?? null
    else {
      const text = normalize(normalized)
      chosen = candidates.find((c) => text.includes(normalize(c.name)) || normalize(c.name).includes(text) || normalize(c.keyword) === text) ?? null
    }
    if (!chosen) return `请回复编号：${candidates.map((c, i) => `${i + 1}. ${c.name}`).join(' / ')}`
    await service.clearPendingEntry(key)
    const status = await service.status()
    if (pending.kind === 'confirm-watch') return addWatchByKeyword(chosen, status, key)
    return queryByKeyword(chosen.keyword, chosen.name, status)
  }

  async function addWatchByKeyword(candidate, status, key) {
    const keyword = candidate.keyword || candidate.name
    const name = candidate.name || keyword
    if (!keyword) return '请补充具体车型（品牌+车系，例如 小米YU7）。'
    const existing = status.targets.find((t) => t.keyword === keyword || normalize(t.name) === normalize(name))
    if (existing) return `「${existing.name}」已经在监控里。`
    return addCandidates([{ id: slugTargetId(keyword), name, keyword, enabled: true }], key, status)
  }

  async function routeByIntent(intent, status, key, raw, context) {
    if (!intent) return null
    const type = intent.intent
    if (type === 'query') {
      if (intent.needs_confirmation || !intent.keyword) return confirmChoice(intent, status, key, 'query')
      const result = await queryByKeyword(intent.keyword, intent.name, status)
      if (result?.noResults && intent.alternatives?.length) return confirmChoice(intent, status, key, 'query')
      return result
    }
    if (type === 'watch_add') {
      if (intent.needs_confirmation) return confirmChoice(intent, status, key, 'watch')
      return addWatchByKeyword(intent, status, key)
    }
    if (type === 'watch_remove') {
      const target = status.targets.find((t) => normalize(t.keyword) === normalize(intent.keyword) || normalize(t.name) === normalize(intent.name))
      if (!target) return `监控里没有「${intent.name || intent.keyword || '这个车型'}」。`
      const removed = await service.removeTarget(target.id)
      return removed ? `已取消监控：${target.name}` : `未能取消「${target.name}」，请打开监控管理确认状态。`
    }
    if (type === 'latest') return latest()
    if (type === 'status') return summary()
    if (type === 'dashboard') return dashboardReply(status)
    if (type === 'help') return HELP
    if (type === 'scan') return startScan(context)
    if (type === 'unknown') {
      if (intent.alternatives?.length || intent.question) return confirmChoice(intent, status, key, 'query')
      return null
    }
    return null
  }

  /** 主路由：先让 AI 分析意图；模型不可用/返回空才走确定性兜底。 */
  async function routeWithAnalyzer(raw, status, key, context) {
    if (typeof analyzer !== 'function') return null
    let intent = null
    try {
      intent = await analyzer(raw, { targets: status.targets.map((t) => `${t.name}(${t.keyword})`) })
    } catch (err) {
      log.warn?.('analyzer failed: %s', err.message)
    }
    return routeByIntent(intent, status, key, raw, context)
  }

  async function addCandidates(candidates, key, status) {
    const result = await service.addTargets(candidates)
    const lines = []
    if (result.added.length) {
      lines.push(`已加入监控：${result.added.map((t) => t.name).join('、')}`)
      for (const t of result.added) {
        try {
          await service.scan('aibot-add', { targetId: t.id, suppressNotify: true })
          const st = await service.status()
          const row = st.targets.find((x) => x.id === t.id)
          if (row) lines.push(`${t.name}：当前样本 ${row.sampleCount ?? 0} 台，中位 ${wan(row.medianPrice)}`)
        } catch (err) {
          lines.push(`${t.name}：已加入，首次扫描稍后进行（${err.message}）`)
        }
      }
      lines.push('之后有新上架/降价会推卡片到群里。')
    }
    if (result.skipped.length) lines.push(`已在监控中：${result.skipped.map((t) => t.name).join('、')}`)
    await service.clearPendingEntry(key)
    return lines.join('\n')
  }

  async function handleConfirm(pending, normalized, key) {
    const candidates = pending.candidates ?? []
    if (/取消|算了|不加入|不要|不加|^0$/.test(normalized)) {
      await service.clearPendingEntry(key)
      return '好的，不加入监控。需要时再发“找宋L”。'
    }
    let chosen = []
    if (/^[1-9]$/.test(normalized)) {
      const idx = Number(normalized) - 1
      if (idx < candidates.length) chosen = [candidates[idx]]
      else if (normalized === String(candidates.length + 1)) chosen = []
      else return `请回复 1–${candidates.length + 1}。`
    } else if (/两个|都加|全加/.test(normalized) && candidates.length > 1) {
      chosen = candidates
    } else if (/加入|要|是|好/.test(normalized)) {
      if (candidates.length === 1) chosen = candidates
      else return `有 ${candidates.length} 个车系，请回复编号：${candidates.map((c, i) => `${i + 1} ${c.name}`).join(' / ')} / ${candidates.length + 1} 都不加。`
    } else {
      return `请回复编号：${candidates.map((c, i) => `${i + 1} ${c.name}`).join(' / ')} / ${candidates.length + 1} 都不加。`
    }
    if (!chosen.length) {
      await service.clearPendingEntry(key)
      return '好的，不加入监控。'
    }
    const status = await service.status()
    return addCandidates(chosen, key, status)
  }

  const handler = async (message) => {
    const { text, chatid = '', from = '' } = message
    const raw = String(text ?? '').trim()
    const normalized = normalize(raw)
    const key = `${chatid || 'default'}:${from || 'unknown'}`

    if (!raw) return HELP

    const pending = await service.pending(key)
    if (pending) {
      if (pending.kind === 'confirm-query' || pending.kind === 'confirm-watch') {
        const candidates = pending.candidates ?? []
        const multiple = candidates.length + 1
        const selectionLike = /^[1-9]$/.test(normalized)
          || /取消|算了|不用|^0$/.test(normalized)
          || candidates.some((c) => normalized.includes(normalize(c.name)) || normalize(c.name).includes(normalized))
        if (!pending.expired && selectionLike) {
          if (/^[1-9]$/.test(normalized) && Number(normalized) > candidates.length) {
            return `请回复 1–${multiple}（或 0 取消）。`
          }
          return handleQueryConfirm(pending, normalized, key)
        }
        await service.clearPendingEntry(key)
      }
      if (!pending.expired && isConfirmText(normalized)) {
        return handleConfirm(pending, normalized, key)
      }
      await service.clearPendingEntry(key)
    }

    if (/帮助|help|菜单|指令/.test(normalized)) return HELP
    if (/看板|网页版|dashboard/.test(normalized)) return dashboardReply(await service.status())
    if (/扫描|刷新|抓取|更新/.test(normalized)) return startScan(message)

    const status = await service.status()
    if (/^最新$|^新上架$|^新的$|^新增$/.test(normalized)) return latest()
    if (/^查$|^行情$|^状态$|^价格$|^报价$/.test(normalized)) return summary()
    if (/^监控$|^监控管理$|^管理$/.test(normalized)) {
      const current = await service.status()
      return { text: '', card: monitorCard(current) }
    }

    const routed = await routeWithAnalyzer(raw, status, key, message)
    if (routed != null) return routed

    const configured = detectConfigured(normalized, status)
    if (configured) {
      const keyword = configured.keyword || configured.name
      return {
        text: '',
        card: queryCard({
          name: configured.name,
          keyword,
          desc: `${configured.sampleCount ?? 0} 台 · 中位 ${wan(configured.medianPrice)}`,
          url: queryPageUrl(status, keyword) || keywordUrl(keyword),
          watched: true,
        }),
      }
    }

    let resolved = null
    try {
      resolved = await resolveModels(raw)
    } catch (err) {
      log.warn?.('resolve model failed: %s', err.message)
    }

    if (resolved?.models?.length) {
      const first = resolved.models[0]
      const keyword = first.keyword || first.name
      return { text: '', card: queryCard({ name: first.name, keyword, url: queryPageUrl(status, keyword) || keywordUrl(keyword) }) }
    }
    if (resolved && !resolved.models.length) {
      if (!resolved.model) return `已识别品牌「${resolved.brand}」，请补充具体车型，例如“${resolved.brand}L9”。`
      return `没找到「${resolved.brand}${resolved.model}」这个具体车系，请换一个“品牌+车型”说法（例如“理想L9”“蔚来ES8”）。`
    }

    const catalog = matchCatalog(normalized)
    if (catalog.length) {
      const first = catalog[0]
      const keyword = first.keyword || first.name
      return { text: '', card: queryCard({ name: first.name, keyword, url: queryPageUrl(status, keyword) || keywordUrl(keyword) }) }
    }

    if (/最新|新上架|新的|新增/.test(normalized)) return latest()
    if (/查|行情|状态|价格|报价/.test(normalized)) return summary()
    if (/加入/.test(normalized)) return '直接发“监控 品牌+车型”，或先查询再点“加入监控”。'
    return `没识别到「${raw.slice(0, 30)}」。\n${HELP}`
  }

  function background(context, work) {
    Promise.resolve().then(work).then(async (message) => {
      if (message && pushMessage) await pushMessage(context, message)
    }).catch((err) => log.warn?.('aibot background action failed: %s', err.message))
  }

  handler.handleEvent = async (context) => {
    const decoded = decodeAction(context?.key)
    if (!decoded) return { text: '', card: queryCard({ name: '操作已失效', desc: '请重新发送指令', watched: true }) }
    const { action, payload } = decoded
    if (action === 'monitor') {
      return { text: '', card: monitorCard(await service.status()) }
    }
    if (action === 'monitor_toggle') {
      if (!payload.id || typeof service.setTargetEnabled !== 'function') {
        return { text: '', card: monitorCard(await service.status()) }
      }
      const status = await service.status()
      const current = (status.allTargets ?? status.targets).find((t) => t.id === payload.id)
      if (current) await service.setTargetEnabled(payload.id, current.enabled === false)
      return { text: '', card: monitorCard(await service.status()) }
    }
    if (action === 'read') {
      const data = await service.readLatest()
      const status = await service.status()
      return data ? { text: '', card: latestCard(data, status) } : { text: '还没有扫描结果，请先扫描。' }
    }
    if (action === 'scan') return startScan(context)
    if (action === 'query_refresh') {
      const keyword = String(payload.keyword || payload.name || '').slice(0, 40)
      const name = String(payload.name || keyword).slice(0, 40)
      background(context, async () => queryByKeyword(keyword, name, await service.status(), { force: true }))
      return { text: '', card: queryCard({ name, keyword, desc: '正在刷新，完成后会在此会话通知你', watched: true }) }
    }
    if (action === 'watch_add') {
      const keyword = String(payload.keyword || payload.name || '').trim().slice(0, 40)
      const name = String(payload.name || keyword).trim().slice(0, 40)
      if (!keyword) return { text: '缺少车型关键词，请重新查询。' }
      const status = await service.status()
      const existing = (status.allTargets ?? status.targets).find((t) => normalize(t.keyword) === normalize(keyword))
      const result = await service.addTargets([{ id: existing?.id || slugTargetId(keyword), name, keyword, enabled: true }])
      const added = result.added?.[0]
      if (added) {
        background(context, async () => {
          const summary = await service.scan('aibot-add', { targetId: added.id, suppressNotify: true })
          const current = await service.status()
          const row = current.targets.find((t) => t.id === added.id)
          return {
            text: '',
            card: queryCard({
              name: added.name, keyword: added.keyword, watched: true,
              desc: summary.busy ? '已加入监控；另一轮扫描正在进行' : `已加入｜样本 ${row?.sampleCount ?? 0} 台｜中位 ${wan(row?.medianPrice)}`,
              url: queryPageUrl(current, added.keyword),
            }),
          }
        })
      }
      const current = await service.status()
      const url = queryPageUrl(current, keyword)
      return { text: '', card: queryCard({ name, keyword, watched: true, url, desc: added ? '已加入，正在建立首次行情基线' : '已在监控中' }) }
    }
    return { text: '暂不支持这个操作，请发送“帮助”。' }
  }

  return handler
}
