/**
 * 关键词解析：把「理想L9」「蔚来ES8」「比亚迪宋L」解析成闲鱼搜索关键词。
 *
 * 与瓜子版不同：闲鱼是按关键词搜索，不需要先抓品牌页/车系页拿 URL，
 * 所以这里完全是纯函数（无网络请求）；明显是模糊需求（“大六座”“三十万以内”）
 * 时返回空 models，由调用方交给 LLM 兜底或让用户补充。
 */

const BRANDS = [
  { name: '小米', slug: 'xiaomi', aliases: ['小米', '小米汽车', 'xiaomi'] },
  { name: '理想', slug: 'lixiang', aliases: ['理想', 'lixiang'] },
  { name: '问界', slug: 'wenjie', aliases: ['问界', 'aito', '鸿蒙智行'] },
  { name: '极氪', slug: 'zeekr', aliases: ['极氪', 'zeekr'] },
  { name: '蔚来', slug: 'nio', aliases: ['蔚来', 'nio'] },
  { name: '小鹏', slug: 'xiaopeng', aliases: ['小鹏', 'xpeng'] },
  { name: '比亚迪', slug: 'byd', aliases: ['比亚迪', 'byd'] },
  { name: '特斯拉', slug: 'tesla', aliases: ['特斯拉', 'tesla'] },
  { name: '零跑', slug: 'leapmotor', aliases: ['零跑'] },
  { name: '深蓝', slug: 'deepal', aliases: ['深蓝'] },
  { name: '阿维塔', slug: 'avatr', aliases: ['阿维塔'] },
  { name: '智界', slug: 'zhijie', aliases: ['智界'] },
  { name: '智己', slug: 'zhiji', aliases: ['智己'] },
  { name: '极狐', slug: 'arcfox', aliases: ['极狐'] },
  { name: '岚图', slug: 'voyah', aliases: ['岚图'] },
  { name: '腾势', slug: 'denza', aliases: ['腾势'] },
  { name: '领克', slug: 'lynkco', aliases: ['领克'] },
  { name: '吉利', slug: 'geely', aliases: ['吉利'] },
  { name: '长安', slug: 'changan', aliases: ['长安'] },
  { name: '奇瑞', slug: 'chery', aliases: ['奇瑞'] },
  { name: '长城', slug: 'greatwall', aliases: ['长城'] },
  { name: '哈弗', slug: 'haval', aliases: ['哈弗'] },
  { name: '坦克', slug: 'tank', aliases: ['坦克'] },
  { name: '魏牌', slug: 'wey', aliases: ['魏牌', 'wey'] },
  { name: '红旗', slug: 'hongqi', aliases: ['红旗'] },
  { name: '荣威', slug: 'roewe', aliases: ['荣威'] },
  { name: '名爵', slug: 'mg', aliases: ['名爵', 'mg'] },
  { name: '五菱', slug: 'wuling', aliases: ['五菱'] },
  { name: '宝骏', slug: 'baojun', aliases: ['宝骏'] },
  { name: '传祺', slug: 'trumpchi', aliases: ['传祺', '广汽传祺'] },
  { name: '埃安', slug: 'aion', aliases: ['埃安', '广汽埃安'] },
  { name: '哪吒', slug: 'nezha', aliases: ['哪吒'] },
  { name: '高合', slug: 'hiphi', aliases: ['高合'] },
  { name: '极越', slug: 'jiyue', aliases: ['极越'] },
  { name: '飞凡', slug: 'feifan', aliases: ['飞凡'] },
  { name: '昊铂', slug: 'hyper', aliases: ['昊铂'] },
  { name: '启源', slug: 'qiyuan', aliases: ['启源', '长安启源'] },
  { name: '银河', slug: 'galaxy', aliases: ['银河', '吉利银河'] },
  { name: '方程豹', slug: 'fangchengbao', aliases: ['方程豹'] },
  { name: '仰望', slug: 'yangwang', aliases: ['仰望'] },
]

// 口语简称：闲鱼上“宋L EV / DM-i”作为搜索词几乎全是配件，用“比亚迪宋L”才能搜到整车
const CATALOG = [
  { id: 'songl', name: '宋L', keyword: '比亚迪宋L' },
]

// 这些词说明用户说的是“需求”而不是具体车型，交给 LLM 兜底或让用户补充
const VAGUE_MODEL = /(六座|七座|五座|座|suv|mpv|轿车|纯电|增程|混动|插电|预算|以内|左右|二手|代步|家用|新车|大车|小车|那个|这款)/i

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase()
}

function matchBrand(query) {
  let best = null
  for (const brand of BRANDS) {
    for (const alias of brand.aliases) {
      const a = normalize(alias)
      if (a && query.includes(a) && (!best || a.length > best.alias.length)) best = { brand, alias: a }
    }
  }
  return best
}

/** 从品牌之后截取车型（保留原始大小写，如 L9 / ES8 / SU7 / i6）。 */
function extractModel(rawQuery, alias) {
  const compact = String(rawQuery ?? '').replace(/\s+/g, '')
  const idx = compact.toLowerCase().indexOf(alias)
  if (idx < 0) return ''
  let rest = compact.slice(idx + alias.length)
  rest = rest.replace(/^(的|那个|那款|这款|一台|一个|一辆|辆|台|车|款|：|:)+/, '')
  rest = rest.replace(/(最新|价格|报价|行情|多少钱|二手|车源|的|了|吗|呢|吧).*$/i, '')
  rest = rest.replace(/[的了吗呢吧]+$/, '')
  return rest.trim().slice(0, 20)
}

function buildModels(brand, model) {
  const normalizedModel = normalize(model)
  if (!normalizedModel) return []
  if (VAGUE_MODEL.test(normalizedModel) || normalizedModel.length > 10) return []
  if (normalizedModel.includes('宋l') || normalizedModel === 'songl') {
    return CATALOG.map((c) => ({ ...c }))
  }
  const slug = `${brand.slug}${normalizedModel.replace(/[^a-z0-9]/g, '')}`
  return [{
    id: slug || brand.slug,
    name: `${brand.name}${model}`,
    keyword: `${brand.name}${model}`,
    referenceOfficialLow: 0,
    referenceOfficialHigh: 0,
  }]
}

/**
 * @returns {Promise<null | {brand:string, model:string, models:Array<{id:string,name:string,keyword:string,referenceOfficialLow:number,referenceOfficialHigh:number}>}>}
 */
export async function resolveModels(rawQuery) {
  const query = normalize(rawQuery)
  if (!query) return null
  const hit = matchBrand(query)
  if (!hit) return null
  const model = extractModel(rawQuery, hit.alias)
  return { brand: hit.brand.name, model, models: buildModels(hit.brand, model) }
}
