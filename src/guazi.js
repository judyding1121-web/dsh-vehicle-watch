/**
 * 瓜子二手车车系页解析 + 样本聚合（DSH 插件版）
 * 页面是 Next.js App Router SSR，数据在 self.__next_f 的 initData（转义 JSON）里，40 条/页。
 * 只做个人低频监控：每车型 1 页、不翻页、不进详情、不登录。
 */

function extractBalanced(text, start) {
  let depth = 0, inString = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else {
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return text.slice(start, i + 1)
      }
    }
  }
  throw new Error('initData: unbalanced JSON')
}

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function looksUsable(html) {
  return typeof html === 'string' && html.includes('self.__next_f') &&
    (html.includes('initData') || html.includes('carList'))
}

/**
 * 桌面站遇到风控会 307 到 captcha；此时回退 m.guazi.com（SSR 仍可解析）。
 * 返回可用 HTML；两边都不可用时抛错。
 */
export async function fetchGuaziPage(url, { timeoutMs = 30000 } = {}) {
  const desktopUrl = String(url).replace('https://m.guazi.com', 'https://www.guazi.com')
  const mobileUrl = String(url).replace('https://www.guazi.com', 'https://m.guazi.com')
  async function get(target, ua) {
    const res = await fetch(target, {
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: 'https://www.guazi.com/',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const html = await res.text()
    return { res, html }
  }
  const desktop = await get(desktopUrl, DESKTOP_UA)
  if (desktop.res.ok && looksUsable(desktop.html)) return desktop.html
  const mobile = await get(mobileUrl, MOBILE_UA)
  if (mobile.res.ok && looksUsable(mobile.html)) return mobile.html
  throw new Error(`瓜子页面不可用（桌面 ${desktop.res.status}${desktop.res.url.includes('captcha') ? ' captcha' : ''}；移动 ${mobile.res.status}）`)
}

export function parseGuaziHtml(html) {
  const chunks = []
  const re = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)/gs
  for (const m of html.matchAll(re)) {
    try { chunks.push(JSON.parse('"' + m[1] + '"')) } catch { /* 跳过碎片 */ }
  }
  if (!chunks.length) throw new Error('未找到 self.__next_f（站点可能改版）')
  let dec = chunks.join('').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  let init = null
  const marker = dec.indexOf('"initData":{"page"')
  if (marker >= 0) {
    const brace = dec.indexOf('{', marker)
    init = JSON.parse(extractBalanced(dec, brace))
  } else {
    // 移动站 m.guazi.com 的结构：{ "carList": { "page":1, "total":..., "carList":[...] } }
    const m = dec.indexOf('"carList":{"page"')
    if (m < 0) throw new Error('未找到 initData / carList（解析器需更新）')
    const brace = dec.indexOf('{', m + '"carList":'.length)
    init = JSON.parse(extractBalanced(dec, brace))
  }
  if (!Array.isArray(init?.carList)) throw new Error('carList 缺失')
  return { init, htmlSize: html.length }
}

function parseMileage(value) {
  if (!value) return null
  const s = String(value).trim()
  const wan = s.match(/([\d.]+)\s*万公里/)
  if (wan) return Math.round(parseFloat(wan[1]) * 10000)
  const km = s.match(/([\d.]+)\s*公里/)
  if (km) return Math.round(parseFloat(km[1]))
  return null
}

function parseYear(value) {
  const m = String(value ?? '').match(/(\d{4})/)
  return m ? Number(m[1]) : null
}

function parseModelYear(title) {
  const m = String(title ?? '').match(/(\d{4})款/)
  return m ? Number(m[1]) : null
}

function parseTrim(title) {
  const m = String(title ?? '').match(/\d{4}款\s*(.+)$/)
  return m ? m[1].trim() : null
}

export function normalizeListing(car) {
  const basic = car?.skuBasicArea ?? {}
  const price = car?.priceArea ?? {}
  const listingId = basic.encryptedClueId ?? null
  const priceYuan = Number.isFinite(Number(price.purchasePrice?.amountMajor))
    ? Number(price.purchasePrice.amountMajor)
    : (price.purchasePrice?.value ? Math.round(parseFloat(price.purchasePrice.value) * 10000) : null)
  const dropYuan = Number.isFinite(Number(price.discountedAmount?.amountMajor))
    ? Number(price.discountedAmount.amountMajor) : null
  const title = basic.title ?? ''
  return {
    listingId,
    title,
    modelYear: parseModelYear(title),
    trim: parseTrim(title),
    licenseYear: parseYear(basic.licenseDate),
    mileageKm: parseMileage(basic.roadHaul),
    cityDesc: basic.carSourceCityDesc ?? null,
    priceYuan,
    priceDropYuan: dropYuan,
    tags: (car?.bottomArea?.bottomTag ?? []).map((t) => t?.text).filter(Boolean),
    detailUrl: listingId ? `https://www.guazi.com/car-detail/${listingId}.html` : null,
    pictureUrl: car?.skuPicArea?.pictureUrl ?? null,
  }
}

function quantile(values, q) {
  if (!values.length) return null
  const a = [...values].sort((x, y) => x - y)
  const pos = (a.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return a[base + 1] !== undefined ? Math.round(a[base] + rest * (a[base + 1] - a[base])) : a[base]
}

export function median(values) { return quantile(values, 0.5) }

export function aggregateListings({ target, init, listings, html, cityName = '西安', referenceOfficialLow = 0, previous = null }) {
  const cityListings = listings.filter((l) => l.cityDesc === cityName && l.priceYuan && l.listingId)
  const prices = cityListings.map((l) => l.priceYuan)
  const miles = cityListings.map((l) => l.mileageKm).filter((v) => v != null)
  const years = cityListings.map((l) => l.licenseYear).filter((v) => v != null)
  const drops = cityListings.map((l) => l.priceDropYuan).filter((v) => v != null && v > 0)
  const currentYear = new Date().getFullYear()
  const nearlyNew = cityListings.filter((l) => l.mileageKm != null && l.mileageKm <= 10000 && l.licenseYear != null && l.licenseYear >= currentYear - 1)
  const tagCount = new Map()
  for (const l of cityListings) for (const t of l.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([text, count]) => ({ text, count }))
  const foundMatch = String(html ?? '').match(/共找到[\s\S]{0,30}?([\d,]+)\s*辆/)
  const pageFound = foundMatch ? Number(foundMatch[1].replaceAll(',', '')) : null
  const med = median(prices)
  return {
    targetId: target.id,
    seriesName: target.name,
    city: cityName,
    url: target.usedCarUrl,
    status: cityListings.length >= 30 ? 'ok' : 'partial',
    sampleCount: cityListings.length,
    rawCount: listings.length,
    outOfCityCount: listings.length - cityListings.length,
    page: init.page ?? null,
    totalPage: init.totalPage ?? null,
    pageTotal: init.total ?? null,
    pageFound,
    price: {
      min: prices.length ? Math.min(...prices) : null,
      p25: quantile(prices, 0.25),
      median: med,
      p75: quantile(prices, 0.75),
      max: prices.length ? Math.max(...prices) : null,
    },
    mileage: { medianKm: median(miles), nearlyNewCount: nearlyNew.length, nearlyNewRatio: cityListings.length ? Number((nearlyNew.length / cityListings.length).toFixed(3)) : null },
    licenseYear: { min: years.length ? Math.min(...years) : null, max: years.length ? Math.max(...years) : null, median: median(years) },
    discount: { listedCount: drops.length, medianDropYuan: median(drops), maxDropYuan: drops.length ? Math.max(...drops) : null },
    reference: {
      officialLow: referenceOfficialLow || null,
      discountVsOfficialLow: med != null && referenceOfficialLow ? Number((1 - med / referenceOfficialLow).toFixed(4)) : null,
      note: '参考值：样本中位挂牌价 ÷ 新车指导价下限；未做年款/配置匹配，仅看趋势',
    },
    topTags,
    compare: {
      prevMedian: previous?.price?.median ?? null,
      medianDelta: med != null && previous?.price?.median ? med - previous.price.median : null,
      medianDeltaPct: med != null && previous?.price?.median ? Number(((med - previous.price.median) / previous.price.median * 100).toFixed(2)) : null,
      prevSampleCount: previous?.sampleCount ?? null,
    },
    cityListings: cityListings.map((l) => ({ ...l, targetId: target.id, seriesName: target.name })),
  }
}
