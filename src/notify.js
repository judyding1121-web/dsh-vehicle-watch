import { createHmac } from 'node:crypto'

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

function safeUrl(url, fallback) {
  const u = String(url ?? '')
  return u.startsWith('http://') || u.startsWith('https://') ? u : fallback
}

/** 一条新车源/降价车源的卡片（text_notice，整卡可点，跳瓜子详情页）。 */
function listingCard({ seriesName, kind, listing, cityName, oldPrice = null }) {
  const isDrop = kind === 'drop' && oldPrice != null
  const detailUrl = safeUrl(listing.detailUrl, 'https://www.guazi.com/xa/')
  const title = isDrop ? `${seriesName} · 降价` : `${seriesName} · 新上架`
  const desc = clip(
    [listing.modelYear ? `${listing.modelYear}款` : null, listing.trim].filter(Boolean).join(' ') || listing.title || '二手车',
    30,
  )
  const price = formatWan(listing.priceYuan)
  const sub = isDrop
    ? `原价 ${formatWan(oldPrice)} → 现价 ${price}（↓${formatWan(oldPrice - listing.priceYuan)}）`
    : `${listing.licenseYear ? listing.licenseYear + '年上牌' : '上牌年未知'}｜${mileageText(listing.mileageKm)}｜${cityName}`
  const rows = isDrop
    ? [
        { keyname: '原价', value: formatWan(oldPrice) },
        { keyname: '现价', value: price },
        { keyname: '降幅', value: '↓' + formatWan(oldPrice - listing.priceYuan) },
        { keyname: '城市', value: cityName },
      ]
    : [
        { keyname: '年款', value: listing.modelYear ? `${listing.modelYear}款` : '—' },
        { keyname: '上牌', value: listing.licenseYear ? `${listing.licenseYear}年` : '—' },
        { keyname: '里程', value: mileageText(listing.mileageKm) },
        { keyname: '已减', value: listing.priceDropYuan ? formatWan(listing.priceDropYuan) : '—' },
      ]
  return {
    card_type: 'text_notice',
    source: { desc: '瓜子二手车 · 挂牌价', desc_color: 0 },
    main_title: { title: clip(title, 26), desc },
    emphasis_content: { title: clip(price, 10), desc: isDrop ? '现挂牌价' : '挂牌价' },
    sub_title_text: clip(sub, 112),
    horizontal_content_list: rows,
    jump_list: [{ type: 1, title: '查看瓜子车源', url: detailUrl }],
    card_action: { type: 1, url: detailUrl },
  }
}

/** 首轮基线卡片：点击进入瓜子车系页。 */
function firstRunCard({ agg, cityName }) {
  const seriesUrl = safeUrl(agg.url, 'https://www.guazi.com/xa/')
  return {
    card_type: 'text_notice',
    source: { desc: '瓜子二手车 · 挂牌价', desc_color: 0 },
    main_title: { title: clip(`${agg.seriesName} · 监控已启动`, 26), desc: clip(`${cityName}样本 ${agg.sampleCount} 台`, 30) },
    emphasis_content: { title: clip(`中位 ${formatWan(agg.price?.median)}`, 10), desc: '挂牌价' },
    sub_title_text: clip('后续有新上架/降价会推卡片；以下均为样本内统计，点击查看车系页', 112),
    horizontal_content_list: [
      { keyname: '样本', value: `${agg.sampleCount} 台` },
      { keyname: '外市', value: `${agg.outOfCityCount} 台` },
      { keyname: '共找到', value: agg.pageFound != null ? `${agg.pageFound} 台` : '—' },
      { keyname: '准新', value: agg.mileage?.nearlyNewRatio != null ? `${(agg.mileage.nearlyNewRatio * 100).toFixed(0)}%` : '—' },
    ],
    jump_list: [{ type: 1, title: '查看瓜子车系', url: seriesUrl }],
    card_action: { type: 1, url: seriesUrl },
  }
}

function overflowCard({ seriesName, count, seriesUrl }) {
  return {
    card_type: 'text_notice',
    source: { desc: '瓜子二手车 · 挂牌价', desc_color: 0 },
    main_title: { title: clip(`${seriesName} · 另有 ${count} 台新上架`, 26), desc: '本轮新增车源较多' },
    emphasis_content: { title: clip(String(count), 10), desc: '台' },
    sub_title_text: '卡片只展示前几条，点击进入车系页看全部',
    jump_list: [{ type: 1, title: '查看瓜子车系', url: seriesUrl }],
    card_action: { type: 1, url: seriesUrl },
  }
}

export function buildMessages(results, { cityName = '西安', maxPush = 8, notifyOnFirstRun = true } = {}) {
  const messages = []
  for (const r of results) {
    if (r.status === 'failed') continue
    const seriesName = r.agg.seriesName
    const seriesUrl = safeUrl(r.agg.url, 'https://www.guazi.com/xa/')

    if (r.firstRun) {
      if (!notifyOnFirstRun) continue
      messages.push({
        targetId: r.agg.targetId,
        kind: 'first-run',
        text: `【${seriesName} · ${cityName}】监控已启动\n当前样本 ${r.agg.sampleCount} 台，中位价 ${formatWan(r.agg.price?.median)}（挂牌价）\n${seriesUrl}`,
        card: firstRunCard({ agg: r.agg, cityName }),
      })
      continue
    }

    for (const listing of r.newListings.slice(0, maxPush)) {
      const detailUrl = safeUrl(listing.detailUrl, seriesUrl)
      messages.push({
        targetId: r.agg.targetId,
        kind: 'new',
        text: `【${seriesName} · ${cityName}】新上架\n${listing.title}\n${formatWan(listing.priceYuan)}｜${mileageText(listing.mileageKm)}\n${detailUrl}`,
        card: listingCard({ seriesName, kind: 'new', listing, cityName }),
      })
    }
    if (r.newListings.length > maxPush) {
      messages.push({
        targetId: r.agg.targetId,
        kind: 'new-overflow',
        text: `【${seriesName} · ${cityName}】另有 ${r.newListings.length - maxPush} 台新上架，查看 ${seriesUrl}`,
        card: overflowCard({ seriesName, count: r.newListings.length - maxPush, seriesUrl }),
      })
    }

    for (const d of r.priceDrops.slice(0, maxPush)) {
      const detailUrl = safeUrl(d.listing.detailUrl, seriesUrl)
      messages.push({
        targetId: r.agg.targetId,
        kind: 'drop',
        text: `【${seriesName} · ${cityName}】降价\n${d.listing.title}\n${formatWan(d.oldPrice)} → ${formatWan(d.newPrice)}（↓${formatWan(d.oldPrice - d.newPrice)}）\n${detailUrl}`,
        card: listingCard({ seriesName, kind: 'drop', listing: d.listing, cityName, oldPrice: d.oldPrice }),
      })
    }
  }
  return messages
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
