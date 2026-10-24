/**
 * 闲鱼（goofish.com）搜索适配器。
 *
 * 数据来源：闲鱼 PC 搜索的 mtop 接口，匿名也能用（内置随机 cna + 自动获取 _m_h5_tk 签名令牌）；
 * 可选在配置里填登录 Cookie 提高稳定性。只做个人低频查询：每次 1–2 页、每页 30 条。
 *
 * 与瓜子不同：闲鱼是 C2C 卖家挂牌，搜索结果是「关键词相关」而不是车系全集，
 * 因此需要过滤非车商品（床垫/租车/配件/订单返现…）和明显低于市场价的残值车。
 */
import { createHash, randomBytes } from 'node:crypto'

const APPKEY = '34839810'
const API_BASE = 'https://h5api.m.goofish.com/h5'
const HOME_URL = 'https://www.goofish.com/'
const GAIA_API = 'mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get'
const SEARCH_API = 'mtop.taobao.idlemtopsearch.pc.search'
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SEARCH_SPM_CNT = 'a21ybx.search.0.0'
const SEARCH_SPM_PRE = 'a21ybx.search.searchInput.0'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 搜索结果页 URL，用于卡片跳转。 */
export function searchUrl(keyword) {
  return `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`
}

/** 关键词匹配用的归一化：去空白 + 小写（“小米 Su7” 与 “小米su7” 等价）。 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase()
}

function randomCna() {
  return randomBytes(13).toString('base64').replace(/[+/=]/g, '').slice(0, 24)
}

function parseCookieHeader(header) {
  const out = []
  for (const part of String(header ?? '').split(';')) {
    const pair = part.trim()
    const i = pair.indexOf('=')
    if (i > 0) out.push([pair.slice(0, i).trim(), pair.slice(i + 1).trim()])
  }
  return out
}

function parseMileage(title) {
  const s = String(title ?? '')
  const wan = s.match(/([\d.]+)\s*万公里/)
  if (wan) return Math.round(parseFloat(wan[1]) * 10000)
  const km = s.match(/([\d.]+)\s*公里/)
  if (km) return Math.round(parseFloat(km[1]))
  return null
}

function parseModelYear(title) {
  const m = String(title ?? '').match(/(20\d{2})\s*款/)
  return m ? Number(m[1]) : null
}

function parseLicenseYear(title) {
  const s = String(title ?? '')
  // “2025年2月” / “26年1月” / “23年上牌” / “2024年上牌”
  let m = s.match(/(20\d{2}|\d{2})\s*年(?:\s*\d{1,2}\s*月)?\s*(?:上牌|上户|入户|款)/i)
  if (!m) m = s.match(/(?:上牌|上户|入户)[：:\s]*(20\d{2}|\d{2})\s*年/)
  if (!m) m = s.match(/(20\d{2})\s*年\s*\d{1,2}\s*月/)
  if (!m) return null
  const y = Number(m[1])
  return y < 100 ? 2000 + y : y
}

function parseTrim(title) {
  const m = String(title ?? '').match(/(?:20\d{2}|\d{2})\s*款\s*(.+)/)
  return m ? m[1].replace(/【.*$/, '').trim().slice(0, 60) : null
}

function parseWant(tags) {
  for (const t of tags) {
    const m = String(t).match(/([\d.]+)\s*(万?)\s*人?想要/)
    if (m) return Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1))
  }
  return null
}

function priceFromParts(parts) {
  const text = (parts ?? []).map((p) => p?.text ?? '').join('').replace(/[¥￥,]/g, '').trim()
  if (!text) return null
  const wan = text.match(/^([\d.]+)\s*万/)
  if (wan) return Math.round(parseFloat(wan[1]) * 10000)
  const n = parseFloat(text)
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * 把一张搜索结果卡片转成统一 listing；非商品/广告卡返回 null。
 * 字段大多在 clickParam.args（干净数值），标题/地区等在 exContent。
 */
export function parseXianyuCard(card) {
  const main = card?.data?.item?.main
  if (!main) return null
  const ex = main.exContent ?? {}
  const args = main.clickParam?.args ?? {}
  const listingId = args.item_id || args.id || ex.itemId
  if (!listingId) return null
  const priceYuan = Number(args.displayPrice ?? args.price) || priceFromParts(ex.price)
  if (!priceYuan) return null
  const title = String(ex.title ?? '').trim()
  if (!title) return null
  const tags = []
  for (const zone of Object.values(ex.fishTags ?? {})) {
    for (const tag of zone?.tagList ?? []) {
      const content = tag?.data?.content
      if (content) tags.push(String(content))
    }
  }
  const publishTime = Number(args.publishTime) || null
  const area = String(ex.area ?? '').trim()
  return {
    listingId: String(listingId),
    title,
    priceYuan,
    area,
    cityDesc: '',
    publishTime,
    publishAt: publishTime ? new Date(publishTime).toISOString() : null,
    seller: String(ex.userNickName ?? '').trim(),
    pictureUrl: (() => {
      const pic = String(ex.picUrl ?? ex.pictureUrl ?? '').trim()
      if (!pic) return null
      return pic.replace(/^http:\/\//i, 'https://')
    })(),
    categoryId: String(args.cCatId ?? args.catId ?? ''),
    wantCount: parseWant(tags),
    tags,
    modelYear: parseModelYear(title),
    trim: parseTrim(title),
    licenseYear: parseLicenseYear(title),
    mileageKm: parseMileage(title),
    detailUrl: `https://www.goofish.com/item?id=${listingId}`,
    priceDropYuan: null,
  }
}

/** 关键词要在标题里出现（整词优先，其次品牌+车型分词都出现）。 */
export function matchesKeyword(title, keyword) {
  const t = normalizeText(title)
  const k = normalizeText(keyword)
  if (!t || !k) return false
  if (t.includes(k)) return true
  const tokens = String(keyword)
    .split(/[\s,，、/]+/)
    .map(normalizeText)
    .filter(Boolean)
  if (tokens.length > 1) return tokens.every((token) => t.includes(token))
  // “小米SU7” 这种中文品牌 + 英文车型：拆成品牌（连续中文）+ 车型（字母数字）再匹配
  const split = String(keyword).match(/^([\u4e00-\u9fa5]+)([a-zA-Z0-9].*)$/)
  if (split) return t.includes(normalizeText(split[1])) && t.includes(normalizeText(split[2]))
  return false
}

/** 过滤非车商品、残值/事故车、与关键词无关的结果；返回保留的 listings。 */
export function filterListings(listings, { keyword, cityName = '西安', minPriceYuan = 30000, excludeKeywords = [], carCategoryId = '127302001', requireCityHint = true } = {}) {
  const excludes = (excludeKeywords ?? []).map(normalizeText).filter(Boolean)
  const out = []
  for (const l of listings) {
    if (!l?.listingId || !l.priceYuan) continue
    // 闲鱼搜索结果混着配件/用品/租车；二手车类目 id 固定，先按类目过滤一遍
    if (carCategoryId && l.categoryId && l.categoryId !== carCategoryId) continue
    if (l.priceYuan < minPriceYuan) continue
    if (!matchesKeyword(l.title, keyword)) continue
    const normTitle = normalizeText(l.title)
    if (excludes.some((w) => normTitle.includes(w))) continue
    // 城市筛选由服务端 division 过滤完成；个别商家卡 area 为空，标题里写西安的保留
    if (!l.area && requireCityHint && !normTitle.includes(normalizeText(cityName)) && !normTitle.includes('西安')) continue
    out.push({ ...l, cityDesc: cityName })
  }
  return out
}

/** 把保留的车源聚合成行情快照（保留瓜子版字段名，报表/卡片不用改结构）。 */
export function aggregateListings({ target, listings, rawCount = 0, pageInfo = {}, cityName = '西安', previous = null, referenceOfficialLow = 0 }) {
  const prices = listings.map((l) => l.priceYuan).filter((v) => Number.isFinite(v))
  const sorted = [...prices].sort((a, b) => a - b)
  const quantile = (q) => {
    if (!sorted.length) return null
    const pos = (sorted.length - 1) * q
    const base = Math.floor(pos)
    const rest = pos - base
    return sorted[base + 1] !== undefined ? Math.round(sorted[base] + rest * (sorted[base + 1] - sorted[base])) : sorted[base]
  }
  const median = (values) => {
    const arr = values.filter((v) => v != null).sort((a, b) => a - b)
    if (!arr.length) return null
    const mid = Math.floor(arr.length / 2)
    return arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2)
  }
  const miles = listings.map((l) => l.mileageKm).filter((v) => v != null)
  const years = listings.map((l) => l.licenseYear).filter((v) => v != null)
  const currentYear = new Date().getFullYear()
  const nearlyNew = listings.filter((l) => l.mileageKm != null && l.mileageKm <= 10000 && l.licenseYear != null && l.licenseYear >= currentYear - 1)
  const tagCount = new Map()
  for (const l of listings) for (const t of l.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([text, count]) => ({ text, count }))
  const med = quantile(0.5)
  return {
    targetId: target.id,
    seriesName: target.name,
    keyword: target.keyword,
    source: 'xianyu',
    city: cityName,
    url: searchUrl(target.keyword),
    status: listings.length >= 10 ? 'ok' : 'partial',
    sampleCount: listings.length,
    rawCount: Math.max(rawCount, listings.length),
    outOfCityCount: Math.max(0, Math.max(rawCount, listings.length) - listings.length),
    page: pageInfo.page ?? 1,
    pageTotal: pageInfo.total ?? null,
    pageFound: null,
    hasNextPage: pageInfo.hasNextPage ?? null,
    price: {
      min: prices.length ? Math.min(...prices) : null,
      p25: quantile(0.25),
      median: med,
      p75: quantile(0.75),
      max: prices.length ? Math.max(...prices) : null,
    },
    mileage: { medianKm: median(miles), nearlyNewCount: nearlyNew.length, nearlyNewRatio: listings.length ? Number((nearlyNew.length / listings.length).toFixed(3)) : null },
    licenseYear: { min: years.length ? Math.min(...years) : null, max: years.length ? Math.max(...years) : null, median: median(years) },
    discount: { listedCount: 0, medianDropYuan: null, maxDropYuan: null },
    reference: {
      officialLow: referenceOfficialLow || null,
      discountVsOfficialLow: med != null && referenceOfficialLow ? Number((1 - med / referenceOfficialLow).toFixed(4)) : null,
      note: '参考值：样本中位挂价 ÷ 新车指导价下限；未做年款/配置匹配，仅看趋势',
    },
    topTags,
    compare: {
      prevMedian: previous?.price?.median ?? null,
      medianDelta: med != null && previous?.price?.median ? med - previous.price.median : null,
      medianDeltaPct: med != null && previous?.price?.median ? Number(((med - previous.price.median) / previous.price.median * 100).toFixed(2)) : null,
      prevSampleCount: previous?.sampleCount ?? null,
    },
    cityListings: listings.map((l) => ({ ...l, targetId: target.id, seriesName: target.name })),
  }
}

/**
 * 闲鱼 mtop 客户端：维护 cookie 会话、_m_h5_tk 签名令牌、请求间隔与风控重试。
 * 一个实例复用整个插件生命周期；令牌过期会自动刷新。
 */
export function createXianyuClient({ cookie = '', minGapMs = 3000, timeoutMs = 20000, userAgent = DEFAULT_UA, log = console } = {}) {
  const jar = new Map([['cna', randomCna()]])
  let lastRequestAt = 0
  let initializing = null
  // 所有网络请求串行执行：扫描（4 个车型）与机器人临时查询可能并发，避免令牌刷新竞争/瞬时爆发
  let requestQueue = Promise.resolve()
  function enqueue(task) {
    const run = requestQueue.then(task, task)
    requestQueue = run.then(() => {}, () => {})
    return run
  }

  for (const [k, v] of parseCookieHeader(cookie)) jar.set(k, v)
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const h5Token = () => (jar.get('_m_h5_tk') ?? '').split('_')[0]

  function storeCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(';')[0]
      const i = pair.indexOf('=')
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
  }

  async function throttle() {
    const gap = minGapMs - (Date.now() - lastRequestAt)
    if (gap > 0) await sleep(gap)
    lastRequestAt = Date.now()
  }

  function sign(token, t, dataStr) {
    return createHash('md5').update(`${token}&${t}&${APPKEY}&${dataStr}`).digest('hex')
  }

  async function mtop(api, data, { spmCnt = 'a21ybx.home.0.0', spmPre = '', token } = {}) {
    return enqueue(async () => {
      const t = Date.now()
      const dataStr = JSON.stringify(data)
      const tk = token ?? h5Token() ?? 'undefined'
      const params = new URLSearchParams({
        jsv: '2.7.2', appKey: APPKEY, t: String(t), sign: sign(tk, t, dataStr), v: '1.0',
        type: 'originaljson', accountSite: 'xianyu', dataType: 'json', timeout: String(timeoutMs),
        api, sessionOption: 'AutoLoginOnly', spm_cnt: spmCnt,
      })
      if (spmPre) params.set('spm_pre', spmPre)
      await throttle()
      const res = await fetch(`${API_BASE}/${api}/1.0/?${params}`, {
        method: 'POST',
        headers: {
          'user-agent': userAgent,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          referer: HOME_URL,
          origin: 'https://www.goofish.com',
          cookie: cookieHeader(),
        },
        body: 'data=' + encodeURIComponent(dataStr),
        signal: AbortSignal.timeout(timeoutMs),
      })
      storeCookies(res)
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { throw new Error(`闲鱼接口返回非 JSON（HTTP ${res.status}）`) }
      if (!res.ok) throw new Error(`闲鱼接口 HTTP ${res.status}`)
      return json
    })
  }

  function retList(result) {
    return Array.isArray(result?.ret) ? result.ret.map(String) : []
  }

  async function initToken() {
    // 首页拿 cna/cookie2 等基础 cookie（失败也继续，签名令牌才是关键）
    try {
      const res = await fetch(HOME_URL, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) })
      storeCookies(res)
    } catch (err) {
      log.warn?.('xianyu home failed: %s', err.message)
    }
    // 匿名请求 gaia 拿 _m_h5_tk（令牌为空是正常的，响应会下发 cookie）
    await mtop(GAIA_API, { piUrl: 'https://h5.m.goofish.com/wow/moyu/moyu-project/xy-site/pages/announcement' }, { token: 'undefined' })
    if (!h5Token()) {
      await mtop(GAIA_API, { piUrl: 'https://h5.m.goofish.com/wow/moyu/moyu-project/xy-site/pages/announcement' }, { token: 'undefined' })
    }
    if (!h5Token()) throw new Error('闲鱼签名令牌获取失败（可能需要登录 Cookie 或触发风控）')
  }

  async function ensureToken() {
    if (h5Token()) return
    initializing ??= initToken().finally(() => { initializing = null })
    await initializing
  }

  function buildSearchPayload(keyword, page, { province = '陕西', city = '西安', rowsPerPage = 30 } = {}) {
    return {
      pageNumber: page,
      keyword,
      fromFilter: true,
      rowsPerPage,
      sortValue: 'desc',
      sortField: 'create',
      customDistance: '',
      gps: '',
      propValueStr: { searchFilter: '' },
      customGps: '',
      searchReqFromPage: 'pcSearch',
      extraFilterValue: JSON.stringify({
        divisionList: [{ province: province ?? '', city: city ?? '' }],
        excludeMultiPlacesSellers: '0',
        extraDivision: '',
      }),
      userPositionJson: '{}',
    }
  }

  /** 搜索一页，返回解析后的 listings + 分页信息（过滤交给 filterListings）。 */
  async function search(keyword, page = 1, { province = '陕西', city = '西安', rowsPerPage = 30 } = {}) {
    await ensureToken()
    let result
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await mtop(SEARCH_API, buildSearchPayload(keyword, page, { province, city, rowsPerPage }), {
        spmCnt: SEARCH_SPM_CNT, spmPre: SEARCH_SPM_PRE,
      })
      const ret = retList(result)
      const ok = ret.some((r) => r.startsWith('SUCCESS'))
      if (ok) break
      const tokenProblem = ret.some((r) => /TOKEN|SESSION/i.test(r))
      const risk = ret.some((r) => /RGV587|SM::|FAIL_SYS_USER_VALIDATE|被挤爆/i.test(r))
      if (attempt === 2) throw new Error(`闲鱼搜索失败：${ret.join('; ') || '未知错误'}`)
      if (tokenProblem || risk) {
        // 令牌过期/风控：重新拿令牌，退避后重试一次
        jar.delete('_m_h5_tk')
        jar.delete('_m_h5_tk_enc')
        await sleep(risk ? 3000 : 500)
        await ensureToken()
        continue
      }
      throw new Error(`闲鱼搜索失败：${ret.join('; ') || '未知错误'}`)
    }
    const data = result?.data ?? {}
    const resultList = Array.isArray(data.resultList) ? data.resultList : []
    const listings = resultList.map(parseXianyuCard).filter(Boolean)
    const info = data.resultInfo ?? {}
    return {
      listings,
      rawCount: resultList.length,
      pageInfo: {
        page,
        total: info?.sqiControlFields?.docNumWhenFirstPage ?? null,
        hasNextPage: info?.hasNextPage ?? null,
      },
    }
  }

  return { search, ensureToken, searchUrl }
}
