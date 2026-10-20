/**
 * 瓜子车型解析器：把「理想L9」「小米YU7」「比亚迪宋L」解析成瓜子车系 URL。
 * 思路：城市页拿品牌 slug → 品牌页拿车系列表 → 按“品牌 + 车型”匹配。
 * 只做个人低频查询，带 1 小时内存缓存。
 */

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const CITY = 'xa'
const BRAND_FALLBACK = {
  理想: 'lixiang', 小米: 'xiaomiqiche', 问界: 'aito', 极氪: 'jike', 比亚迪: 'byd',
  特斯拉: 'tesila', 蔚来: 'nio', 小鹏: 'xiaopeng', 零跑: 'leapmotor', 深蓝: 'deepal',
  长安: 'changan', 吉利: 'geely', 领克: 'lynkco', 哈弗: 'haval', 坦克: 'tank', 魏牌: 'wey',
  奇瑞: 'chery', 星途: 'exeed', 捷途: 'jetour', 红旗: 'hongqi', 荣威: 'roewe', 名爵: 'mg',
  五菱: 'wuling', 宝骏: 'baojun', 传祺: 'trumpchi', 埃安: 'aion', 智己: 'zhiji',
  阿维塔: 'avatr', 岚图: 'voyah', 极狐: 'arcfox', 腾势: 'denza', 方程豹: 'fangchengbao',
  仰望: 'yangwang', 哪吒: 'nezha', 高合: 'hiphi', 极越: 'jiyue', 极石: 'jishi',
  飞凡: 'feifan', 昊铂: 'hyper', 启源: 'qiyuan', 银河: 'galaxy',
}

const brandCache = { at: 0, map: new Map() }
const seriesCache = new Map() // brand -> { at, list }

function norm(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase()
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': MOBILE_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://www.guazi.com/',
    },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function pairs(html) {
  const out = []
  const patterns = [
    /\\"name\\":\\"([^"\\]+)\\",\\"value\\":\\"([a-z0-9_-]+)\\"/g,
    /"name":"([^"]+)","value":"([a-z0-9_-]+)"/g,
  ]
  for (const re of patterns) {
    for (const m of html.matchAll(re)) out.push({ name: m[1], slug: m[2] })
  }
  return out
}

async function brandMap() {
  if (Date.now() - brandCache.at < 3600_000 && brandCache.map.size) return brandCache.map
  const map = new Map(Object.entries(BRAND_FALLBACK))
  try {
    const html = await fetchText(`https://m.guazi.com/${CITY}/`)
    const brandLinks = new Set([...html.matchAll(new RegExp(`href="/${CITY}/([a-z0-9_-]+)/"`, 'g'))].map((m) => m[1]))
    for (const { name, slug } of pairs(html)) {
      if (!brandLinks.has(slug)) continue
      map.set(name, slug)
      map.set(name.replace(/汽车$/, ''), slug)
      map.set(name.replace(/新能源$/, ''), slug)
    }
  } catch {
    // 保留 fallback
  }
  brandCache.at = Date.now()
  brandCache.map = map
  return map
}

async function seriesList(brandSlug) {
  const cached = seriesCache.get(brandSlug)
  if (cached && Date.now() - cached.at < 3600_000) return cached.list
  const html = await fetchText(`https://m.guazi.com/${CITY}/${brandSlug}/`)
  const links = new Set()
  for (const m of html.matchAll(new RegExp(`href="/${CITY}/${brandSlug}/([a-z0-9_-]+)/"`, 'g'))) links.add(m[1])
  const nameBySlug = new Map()
  for (const { name, slug } of pairs(html)) {
    if (links.has(slug)) nameBySlug.set(slug, name)
  }
  const list = [...links].map((slug) => ({ slug, name: nameBySlug.get(slug) ?? slug }))
  seriesCache.set(brandSlug, { at: Date.now(), list })
  return list
}

function extractModel(query, brandName) {
  let rest = query
  const idx = rest.indexOf(brandName)
  if (idx >= 0) rest = rest.slice(idx + brandName.length)
  rest = rest.replace(/^(的|那个|那款|这款|一台|一个|一辆|辆|台|车|款|：|:)+/, '')
  rest = rest.replace(/(最新|价格|报价|行情|多少钱|二手|车源|的|了|吗|呢|吧).*$/, '')
  rest = rest.replace(/[的了吗呢吧]+$/, '')
  return rest.trim()
}

/**
 * @returns {Promise<{brand:string,model:string,models:Array<{id:string,name:string,usedCarUrl:string,referenceOfficialLow:number,referenceOfficialHigh:number}>}|null>}
 */
export async function resolveModels(rawQuery) {
  const query = norm(rawQuery)
  const map = await brandMap()
  // 最长品牌名优先，避免“理想”匹配到“理”之类
  const names = [...map.keys()].filter((n) => n && query.includes(norm(n))).sort((a, b) => b.length - a.length)
  if (!names.length) return null
  const brandName = names[0]
  const brandSlug = map.get(brandName)
  const model = extractModel(query, norm(brandName))
  if (!model) return { brand: brandName, model: '', models: [] }

  const modelNorm = norm(model)
  const list = await seriesList(brandSlug)
  let hits = list.filter((s) => norm(s.name).includes(modelNorm))
  // 中文车型名无法靠 slug 匹配；只有纯字母/数字车型（L9、SU7、001）再做 slug 兜底
  if (!hits.length && /^[a-z0-9-]+$/.test(modelNorm)) {
    hits = list.filter((s) => norm(s.slug).includes(modelNorm))
  }
  const seen = new Set()
  hits = hits.filter((s) => (seen.has(s.slug) ? false : (seen.add(s.slug), true)))
  const models = hits.map((s) => ({
    id: s.slug,
    name: s.name,
    usedCarUrl: `https://www.guazi.com/${CITY}/${brandSlug}/${s.slug}/`,
    referenceOfficialLow: 0,
    referenceOfficialHigh: 0,
  }))
  return { brand: brandName, model, models }
}
