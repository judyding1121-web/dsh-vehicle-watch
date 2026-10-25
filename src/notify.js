import { createHmac } from 'node:crypto'

const GOOFISH_HOME = 'https://www.goofish.com/'

export function formatWan(yuan) {
  return yuan == null ? '—' : (yuan / 10000).toFixed(2) + '万'
}

function clip(text, max) {
  const chars = Array.from(String(text ?? ''))
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('')
}

function mileageText(km) {
  return km == null ? '—' : (km / 10000).toFixed(2) + '万km'
}

function decisionText(listing) {
  const tags = listing?.decision?.tags ?? []
  const risks = listing?.decision?.risks ?? []
  return [...tags, ...risks.map((r) => `⚠${r}`)].join(' · ')
}

function attrText(listing, key) {
  return listing?.detail?.attributes?.[key] ?? null
}

function safeUrl(url, fallback) {
  const u = String(url ?? '')
  return u.startsWith('http://') || u.startsWith('https://') ? u : fallback
}

/** 一条新车源/降价车源的卡片（text_notice，整卡可点，跳闲鱼商品页）。 */
function listingCard({ seriesName, kind, listing, cityName, oldPrice = null }) {
  const isDrop = kind === 'drop' && oldPrice != null
  const detailUrl = safeUrl(listing.detailUrl, GOOFISH_HOME)
  const title = isDrop ? `${seriesName} · 降价` : `${seriesName} · 新上架`
  const detail = listing.detail ?? null
  const attrs = detail?.attributes ?? {}
  const seller = detail?.seller?.nick || listing.seller || null
  const desc = clip(
    [listing.modelYear ? `${listing.modelYear}款` : null, listing.trim].filter(Boolean).join(' ') || listing.title || '闲鱼车源',
    30,
  )
  const price = formatWan(listing.priceYuan)
  const area = attrs['车源地'] || listing.area || cityName
  const transfer = attrs['过户次数'] || null
  const want = detail?.wantCount ?? listing.wantCount
  const tagLine = decisionText(listing)
  const sub = isDrop
    ? clip([`原价 ${formatWan(oldPrice)} → 现价 ${price}（↓${formatWan(oldPrice - listing.priceYuan)}）`, tagLine].filter(Boolean).join('｜'), 112)
    : clip([area, transfer ? `过户${String(transfer).replace(/\D/g, '')}次` : null, want != null ? `${want}人想要` : null, tagLine].filter(Boolean).join('｜'), 112)
  const rows = isDrop
    ? [
        { keyname: '原价', value: formatWan(oldPrice) },
        { keyname: '现价', value: price },
        { keyname: '降幅', value: '↓' + formatWan(oldPrice - listing.priceYuan) },
        { keyname: '过户', value: transfer ?? '—' },
      ]
    : [
        { keyname: '过户', value: transfer ?? '—' },
        { keyname: '上牌', value: attrs['上牌年月'] || (listing.licenseYear ? `${listing.licenseYear}年` : '—') },
        { keyname: '里程', value: mileageText(listing.mileageKm) },
        { keyname: '卖家', value: clip(seller ?? '—', 12) },
      ]
  return {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 卖家报价', desc_color: 0 },
    main_title: { title: clip(title, 26), desc },
    emphasis_content: { title: clip(price, 10), desc: isDrop ? '现卖家报价' : '卖家报价' },
    sub_title_text: sub,
    horizontal_content_list: rows,
    jump_list: [{ type: 1, title: '查看闲鱼商品', url: detailUrl }],
    card_action: { type: 1, url: detailUrl },
  }
}

/** 首轮基线卡片：点击进入闲鱼搜索页。 */
function firstRunCard({ agg, cityName }) {
  const seriesUrl = safeUrl(agg.url, GOOFISH_HOME)
  return {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 卖家报价', desc_color: 0 },
    main_title: { title: clip(`${agg.seriesName} · 监控已启动`, 26), desc: clip(`${cityName}样本 ${agg.sampleCount} 台`, 30) },
    emphasis_content: { title: clip(`中位 ${formatWan(agg.price?.median)}`, 10), desc: '卖家报价' },
    sub_title_text: clip('后续有新上架/降价会推卡片；样本为闲鱼搜索结果，点击查看搜索页', 112),
    horizontal_content_list: [
      { keyname: '样本', value: `${agg.sampleCount} 台` },
      { keyname: '过滤', value: `${agg.outOfCityCount} 台` },
      { keyname: '结果数', value: agg.pageTotal != null ? `${agg.pageTotal} 条` : '—' },
      { keyname: '准新', value: agg.mileage?.nearlyNewRatio != null ? `${(agg.mileage.nearlyNewRatio * 100).toFixed(0)}%` : '—' },
    ],
    jump_list: [{ type: 1, title: '查看闲鱼搜索', url: seriesUrl }],
    card_action: { type: 1, url: seriesUrl },
  }
}

function overflowCard({ seriesName, count, seriesUrl }) {
  return {
    card_type: 'text_notice',
    source: { desc: '闲鱼 · 卖家报价', desc_color: 0 },
    main_title: { title: clip(`${seriesName} · 另有 ${count} 台新上架`, 26), desc: '本轮新增车源较多' },
    emphasis_content: { title: clip(String(count), 10), desc: '台' },
    sub_title_text: '卡片只展示前几条，点击进入闲鱼搜索看全部',
    jump_list: [{ type: 1, title: '查看闲鱼搜索', url: seriesUrl }],
    card_action: { type: 1, url: seriesUrl },
  }
}

export function buildMessages(results, {
  cityName = '西安', maxPush = 8, notifyOnFirstRun = true, dashboardUrl = '',
} = {}) {
  const successful = (results ?? []).filter((r) => r.status !== 'failed')
  if (!successful.length) return []
  const baseline = successful.every((r) => r.firstRun)
  if (baseline && !notifyOnFirstRun) return []

  const changes = successful.flatMap((r) => [
    ...(r.newListings ?? []).map((listing) => ({ kind: 'new', seriesName: r.agg.seriesName, listing })),
    ...(r.priceDrops ?? []).map((drop) => ({ kind: 'drop', seriesName: r.agg.seriesName, ...drop })),
  ])
  if (!baseline && !changes.length) return []

  changes.sort((a, b) => a.kind === b.kind ? 0 : (a.kind === 'drop' ? -1 : 1))
  const newCount = changes.filter((c) => c.kind === 'new').length
  const dropCount = changes.length - newCount
  const totalSamples = successful.reduce((n, r) => n + (r.agg.sampleCount ?? 0), 0)
  const homeUrl = safeUrl(dashboardUrl, safeUrl(changes[0]?.listing?.detailUrl, safeUrl(successful[0]?.agg?.url, GOOFISH_HOME)))
  const title = baseline ? `监控已启动｜${successful.length} 个车型` : `本轮发现 ${changes.length} 个变化`
  const highlights = baseline
    ? successful.slice(0, Math.max(1, maxPush)).map((r) => `${r.agg.seriesName}｜样本 ${r.agg.sampleCount} 台｜中位 ${formatWan(r.agg.price?.median)}`)
    : changes.slice(0, Math.max(1, maxPush)).map((c) => c.kind === 'drop'
      ? `${c.seriesName}｜${formatWan(c.oldPrice)} → ${formatWan(c.newPrice)}｜降价 ${formatWan(c.oldPrice - c.newPrice)}`
      : `${c.seriesName}｜${formatWan(c.listing.priceYuan)}｜${clip(c.listing.title, 28)}`)
  const card = {
    card_type: 'text_notice',
    source: { desc: baseline ? '闲鱼 · 监控基线' : '闲鱼 · 本轮变化', desc_color: 0 },
    main_title: {
      title: clip(title, 26),
      desc: clip(baseline ? `${cityName}｜样本 ${totalSamples} 台` : `新上架 ${newCount} 台｜降价 ${dropCount} 台`, 30),
    },
    emphasis_content: baseline
      ? { title: clip(String(totalSamples), 10), desc: '当前样本' }
      : { title: clip(String(newCount), 10), desc: `新上架｜降价 ${dropCount} 台` },
    sub_title_text: clip(highlights.join('\n'), 112),
    horizontal_content_list: successful.slice(0, 6).map((r) => ({
      keyname: clip(r.agg.seriesName, 5),
      value: clip(baseline
        ? `${r.agg.sampleCount} 台｜中位 ${formatWan(r.agg.price?.median)}`
        : `新上 ${(r.newListings ?? []).length}｜降价 ${(r.priceDrops ?? []).length}`, 26),
    })),
    jump_list: [{ type: 1, title: dashboardUrl ? '查看全部变化' : '查看闲鱼车源', url: homeUrl }],
    card_action: { type: 1, url: homeUrl },
  }
  const text = baseline
    ? `【二手车监控已启动】\n${highlights.join('\n')}\n${homeUrl}`
    : `【本轮发现 ${changes.length} 个变化】\n新上架 ${newCount} 台｜降价 ${dropCount} 台\n${highlights.join('\n')}\n${homeUrl}`
  return [{ targetId: null, kind: baseline ? 'first-run-summary' : 'scan-summary', text, card }]
}

/** WeCom markdown 上限 4096 字节（UTF-8）；按字节截断，避免中文被截半。 */
function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8') + '\n…（已截断）'
}

function feishuSign(secret, timestamp) {
  const key = `${timestamp}\n${secret}`
  return createHmac('sha256', key).update('').digest('base64')
}

export class Notifier {
  constructor({ wecomWebhook = '', feishuWebhook = '', feishuSecret = '', timeoutMs = 10000, log = console } = {}) {
    this.wecomWebhook = wecomWebhook
    this.feishuWebhook = feishuWebhook
    this.feishuSecret = feishuSecret
    this.timeoutMs = timeoutMs
    this.log = log
  }

  get configured() {
    return Boolean(this.wecomWebhook || this.feishuWebhook)
  }

  /** message 可以是字符串，或 { text, card }。企微优先发 template_card，飞书用 text。 */
  async send(message) {
    if (!this.configured) return { skipped: 'no-webhook' }
    const text = typeof message === 'string' ? message : (message?.text ?? '')
    const card = typeof message === 'object' ? message?.card : null
    const out = {}
    if (this.wecomWebhook) {
      const body = card
        ? { msgtype: 'template_card', template_card: card }
        : { msgtype: 'markdown', markdown: { content: truncateUtf8(text, 4000) } }
      out.wecom = await this.postWithRetry(this.wecomWebhook, body, 'wecom')
    }
    if (this.feishuWebhook) {
      const body = { msg_type: 'text', content: { text: truncateUtf8(text.replace(/\*\*/g, ''), 10000) } }
      if (this.feishuSecret) {
        const timestamp = Math.floor(Date.now() / 1000)
        body.timestamp = String(timestamp)
        body.sign = feishuSign(this.feishuSecret, timestamp)
      }
      out.feishu = await this.postWithRetry(this.feishuWebhook, body, 'feishu')
    }
    return out
  }

  async postWithRetry(url, body, channel) {
    let lastErr
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        const text = await res.text().catch(() => '')
        if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
        try {
          const json = JSON.parse(text)
          if (json?.errcode != null && json.errcode !== 0) throw new Error(`errcode=${json.errcode} ${json.errmsg ?? ''}`)
          if (json?.code != null && json.code !== 0) throw new Error(`code=${json.code} ${json.msg ?? ''}`)
        } catch (e) {
          if (e instanceof SyntaxError) return 'ok'
          throw e
        }
        return 'ok'
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800))
      }
    }
    this.log.warn?.('notify %s failed: %s', channel, lastErr?.message ?? lastErr)
    return `error: ${lastErr?.message ?? lastErr}`
  }
}
