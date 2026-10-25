/**
 * 把「搜索结果 + 详情」压成决策标签/风险提示，供卡片、推送、查询页共用。
 * 只做规则抽取，不臆造：描述里没写的“无事故”不会自动当作事实。
 */

const POSITIVE_DESC = [
  [/原版原漆|全车原漆|原漆/, '原版原漆'],
  [/个人一手|一手车|个人车源/, '个人一手'],
  [/无事故|无重大事故|无火烧|无水淹|无泡水/, '描述无事故'],
  [/4S保养|全程4S|4S店保养/, '4S保养'],
  [/准新|准新车/, '准新'],
  [/无剐蹭|无钣金|无修复/, '无钣金'],
]
const NEGATIVE_DESC = [
  [/(?<!无)(事故|碰撞|追尾|泡水|水淹|火烧)/, '描述含事故/水淹词'],
  [/(?<!无)(调表|改表)/, '疑似调表'],
  [/(?<!非)(营运转非|营运车|租赁车)/, '营运/租赁'],
  [/抵押|查封|纠纷/, '抵押/查封'],
  [/(?<!无)(大修|更换发动机|切割|焊接)/, '大修/切割'],
]

function pctText(n) {
  return `${Math.abs(n).toFixed(0)}%`
}

export function summarizeListing(listing, { median = null, cityName = '西安' } = {}) {
  const tags = []
  const risks = []
  const push = (arr, v) => { if (v && !arr.includes(v)) arr.push(v) }
  const detail = listing?.detail ?? null
  const attrs = detail?.attributes ?? {}
  const desc = `${listing?.title ?? ''} ${detail?.desc ?? ''}`
  const seller = detail?.seller ?? null

  // 价格位置
  if (median && listing?.priceYuan) {
    const diff = (Number(listing.priceYuan) - Number(median)) / Number(median)
    if (diff <= -0.03) push(tags, `低于中位${pctText(diff * 100)}`)
    if (diff <= -0.15) push(tags, '明显低于中位')
    if (diff <= -0.25) push(risks, '价格异常低，需核实')
    if (diff >= 0.15) push(risks, '高于中位较多')
  }

  // 详情里的车辆属性（闲鱼二手车 CPV）
  const transfer = attrs['过户次数']
  if (transfer != null) {
    const m = String(transfer).match(/(\d+)/)
    if (m) {
      const n = Number(m[1])
      push(tags, n === 0 ? '一手' : `过户${n}次`)
      if (n >= 3) push(risks, '过户次数偏多')
      if (n >= 2 && /个人一手|一手车|个人车源/.test(desc)) push(risks, `描述一手但过户${n}次`)
    }
  }
  if (attrs['车源地'] && !String(attrs['车源地']).includes(cityName)) push(risks, `车源地${attrs['车源地']}`)
  if (attrs['上牌地'] && !/^陕/.test(String(attrs['上牌地']))) push(risks, `上牌地${attrs['上牌地']}`)

  // 描述关键词
  for (const [re, label] of POSITIVE_DESC) if (re.test(desc)) push(tags, label)
  for (const [re, label] of NEGATIVE_DESC) if (re.test(desc)) push(risks, label)

  // 卖家
  if (seller?.zhimaAuth) push(tags, '卖家已实名')
  if (seller?.replyRatio24h) {
    const r = parseFloat(String(seller.replyRatio24h))
    if (Number.isFinite(r) && r >= 80) push(tags, `回复率${seller.replyRatio24h}`)
  }
  if (seller?.goodRemarks != null && seller?.badRemarks != null) {
    if (seller.goodRemarks >= 10 && seller.badRemarks <= 1) push(tags, '卖家口碑好')
    if (seller.badRemarks >= 3) push(risks, '卖家差评较多')
  }
  if (seller?.soldCount != null && seller.soldCount >= 20) push(tags, `卖家已售${seller.soldCount}件`)

  // 热度
  if (detail?.wantCount != null && detail.wantCount >= 10) push(tags, `${detail.wantCount}人想要`)
  if (detail?.browseCount != null && detail.browseCount >= 200) push(tags, `${detail.browseCount}浏览`)

  // 历史价格
  const h = listing?.history
  if (h?.previousPrice != null && listing?.priceYuan != null && listing.priceYuan < h.previousPrice) {
    push(tags, `较上次↓${((h.previousPrice - listing.priceYuan) / 10000).toFixed(2)}万`)
  }
  if (h?.minPrice != null && listing?.priceYuan != null && listing.priceYuan <= h.minPrice) push(tags, '历史最低')
  if (h?.firstPrice != null && listing?.priceYuan != null && listing.priceYuan < h.firstPrice) {
    push(tags, `较首次↓${((h.firstPrice - listing.priceYuan) / 10000).toFixed(2)}万`)
  }

  return { tags: tags.slice(0, 8), risks: risks.slice(0, 4) }
}
