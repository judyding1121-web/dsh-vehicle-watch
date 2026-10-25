/**
 * 单文件 HTML「本轮变化」看板（无外部依赖，手机/电脑浏览器直接打开）。
 *
 * 只回答两个问题：**这一轮有哪些新车源上架？哪些车降价了？**
 * 不铺全量车源、不做搜索/排序/图表；全量数据仍在 Excel / CSV 里。
 *
 * 由 src/service.js 每轮扫描后写 reportDir/二手车监控-最新.html；
 * 插件内置本地 HTTP 服务（src/dashboard-server.js）后，手机同一 Wi-Fi 可直接打开。
 * 手动重生成：node scripts/make_html.mjs <latest.json> [out.html] [intervalHours]
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const REPORT_NAME = '二手车监控-最新.html'

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}

function safeUrl(url) {
  return /^https?:\/\//.test(String(url ?? '')) ? esc(url) : '#'
}

function wan(yuan) {
  if (yuan == null || !Number.isFinite(Number(yuan))) return '—'
  return (Number(yuan) / 10000).toFixed(2) + '万'
}

function pct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return (Number(value) * 100).toFixed(1) + '%'
}

function kmText(km) {
  if (km == null || !Number.isFinite(Number(km))) return ''
  return km >= 10000 ? (km / 10000).toFixed(2) + '万km' : Math.round(km) + 'km'
}

function pad2(n) { return String(n).padStart(2, '0') }

function fmtDateTime(iso) {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return '—'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

function fmtClock(date) {
  // 固定按 Asia/Shanghai 显示，避免 Mac 时区不是东八区时「下次扫描」时间错乱
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  const got = (type) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${got('hour')}:${got('minute')}`
}

function relTime(ms, nowMs) {
  const t = Number(ms)
  if (!t) return ''
  const diff = Math.max(0, nowMs - t)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}分钟前`
  if (diff < day) return `${Math.round(diff / hour)}小时前`
  return `${Math.round(diff / day)}天前`
}

function priceCompare(price, median) {
  if (!Number.isFinite(Number(price)) || !Number.isFinite(Number(median)) || !median) return ''
  const diff = (Number(price) - Number(median)) / Number(median)
  const pct = Math.abs(diff * 100)
  if (pct < 2) return '<span class="cmp">≈ 样本中位</span>'
  return `<span class="cmp ${diff < 0 ? 'good' : 'high'}">${diff < 0 ? '低于' : '高于'}中位 ${pct.toFixed(0)}%</span>`
}

/** 一条车源卡片：整张卡可点；有详情时展示车况/卖家/历史价格等决策信息。 */
function carCard({ listing, now, median, kind, oldPrice }) {
  const l = listing ?? {}
  const url = safeUrl(l.detailUrl)
  const price = Number(l.priceYuan)
  const detail = l.detail ?? null
  const attrs = detail?.attributes ?? {}
  const decision = l.decision ?? { tags: [], risks: [] }
  const cut = kind === 'drop' && Number.isFinite(Number(oldPrice)) && Number.isFinite(price)
    ? Number(oldPrice) - price
    : null
  const chips = [
    attrs['过户次数'] ? `过户${String(attrs['过户次数']).replace(/\D/g, '')}次` : null,
    attrs['上牌年月'] ? `上牌${attrs['上牌年月']}` : (l.licenseYear ? `${l.licenseYear}年上牌` : null),
    kmText(l.mileageKm) || null,
    attrs['车源地'] || l.area || null,
    detail?.wantCount != null ? `${detail.wantCount}人想要` : (l.wantCount != null ? `${l.wantCount}人想要` : null),
    detail?.browseCount != null ? `${detail.browseCount}浏览` : null,
    relTime(l.publishTime, now) || null,
  ].filter(Boolean)
  const sellerText = detail?.seller?.nick || l.seller || ''
  const sellerMeta = [
    detail?.seller?.soldCount != null ? `已售${detail.seller.soldCount}件` : null,
    detail?.seller?.replyRatio24h ? `回复${detail.seller.replyRatio24h}` : null,
    detail?.seller?.zhimaAuth ? '实名' : null,
  ].filter(Boolean).join(' · ')
  const tags = (l.tags ?? [])
    .filter((t) => !/(想要|小时前|天前|分钟前|上新|发布)/.test(String(t)))
    .slice(0, 3)
  const appAttr = l.listingId ? ` data-xianyu-id="${esc(l.listingId)}"` : ''
  const thumb = l.pictureUrl
    ? `<div class="thumb"><img src="${esc(l.pictureUrl)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.parentNode.classList.add('noimg')"></div>`
    : '<div class="thumb noimg"></div>'
  const detailTags = [...(decision.tags ?? []), ...tags].slice(0, 6)
  return `<li class="car">
    <a class="car-hit"${appAttr} href="${url}" target="_blank" rel="noopener">
      ${thumb}
      <div class="car-body">
        <div class="car-title" title="${esc(l.title)}">${esc(l.title)}</div>
        <div class="car-price">
          <b>${wan(price)}</b>
          ${kind === 'drop' && cut ? `<span class="old">${wan(oldPrice)}</span><span class="cut">↓${wan(cut)}</span>` : ''}
          ${priceCompare(price, median)}
        </div>
        <div class="chips">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
        ${detailTags.length ? `<div class="dtags">${detailTags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
        ${(decision.risks ?? []).length ? `<div class="drisk">${decision.risks.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
        ${detail?.desc ? `<div class="desc2">${esc(detail.desc)}</div>` : ''}
        <div class="car-foot">
          <span class="seller">${sellerText ? `卖家：${esc(sellerText)}` : ''}${sellerMeta ? ` · ${esc(sellerMeta)}` : ''}</span>
        </div>
      </div>
    </a>
  </li>`
}

function modelGroup(title, items) {
  return `<div class="group">
    <div class="group-head"><span class="model">${esc(title)}</span><span class="group-count">${items.length} 台</span></div>
    <ul class="items">${items.join('')}</ul>
  </div>`
}

function newSection(targets, now) {
  const groups = targets
    .map((t) => ({
      t,
      items: (t.newListings ?? []).map((l) => carCard({ listing: l, now, median: t.price?.median, kind: 'new' })),
    }))
    .filter((g) => g.items.length)
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  if (!total) return ''
  return `<section class="card">
    <div class="section-head"><h2><span class="dot green"></span>新上架 <em>${total} 台</em></h2><span class="hint">本轮首次出现 · 对比该车型本轮中位价</span></div>
    ${groups.map((g) => modelGroup(g.t.seriesName, g.items)).join('')}
  </section>`
}

function dropSection(targets, now) {
  const groups = targets
    .map((t) => ({
      t,
      items: (t.priceDrops ?? []).map((d) => carCard({ listing: d.listing, now, median: t.price?.median, kind: 'drop', oldPrice: d.oldPrice })),
    }))
    .filter((g) => g.items.length)
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  if (!total) return ''
  return `<section class="card">
    <div class="section-head"><h2><span class="dot red"></span>降价 <em>${total} 台</em></h2><span class="hint">较上一轮降幅 ≥ 阈值</span></div>
    ${groups.map((g) => modelGroup(g.t.seriesName, g.items)).join('')}
  </section>`
}

function emptyState(hasChanges, baseline) {
  if (hasChanges) return ''
  const tip = baseline
    ? '本轮是首次扫描/换源后的第一轮，只建立基线；下一轮起这里只显示新上架与降价。'
    : '本轮没有新车源，也没有车降价。'
  return `<section class="card empty">
    <div class="empty-icon">✓</div>
    <h2>本轮没有新上架，也没有降价</h2>
    <p>${esc(tip)}</p>
  </section>`
}

function statsTable(targets) {
  const rows = targets.map((t) => {
    if (t.status === 'failed') {
      return `<tr><td><b>${esc(t.seriesName)}</b></td><td colspan="4" class="bad">扫描失败：${esc(t.error || '')}</td></tr>`
    }
    const delta = t.compare?.medianDelta
    const trend = delta == null || delta === 0 ? '—' : `${delta > 0 ? '+' : '−'}${wan(Math.abs(delta)).replace('万', '')}万`
    return `<tr>
      <td><b>${esc(t.seriesName)}</b>${t.keyword && t.keyword !== t.seriesName ? `<div class="sub">${esc(t.keyword)}</div>` : ''}</td>
      <td class="num">${t.sampleCount ?? 0} 台</td>
      <td class="num">${wan(t.price?.min)}</td>
      <td class="num">${wan(t.price?.median)}</td>
      <td class="num">${t.mileage?.nearlyNewRatio != null ? pct(t.mileage.nearlyNewRatio) : '—'}</td>
      <td class="num ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${trend}</td>
    </tr>`
  }).join('')
  return `<div class="table-wrap stats-wrap"><table class="stats">
    <thead><tr><th>车型</th><th>样本</th><th>最低</th><th>中位</th><th>准新</th><th>较上次</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function sampleDetails(targets, now) {
  const rows = []
  for (const t of targets) {
    for (const l of t.cityListings ?? []) {
      rows.push(`<tr>
        <td><span class="pill">${esc(t.seriesName)}</span></td>
        <td class="num">${wan(l.priceYuan)}</td>
        <td><a href="${safeUrl(l.detailUrl)}" target="_blank" rel="noopener">${esc(l.title)}</a></td>
        <td>${esc(l.area || '—')}</td>
        <td class="num">${kmText(l.mileageKm) || '—'}</td>
        <td class="num">${esc(relTime(l.publishTime, now) || '—')}</td>
      </tr>`)
    }
  }
  if (!rows.length) return ''
  return `<details class="card details">
    <summary>本轮样本明细（${rows.length} 台，可展开）</summary>
    <div class="table-wrap"><table class="samples">
      <thead><tr><th>车型</th><th>价格</th><th>标题</th><th>地区</th><th>里程</th><th>发布</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>
  </details>`
}

const STYLE = `
:root{--bg:#f5f6f8;--card:#fff;--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--blue:#2563eb;--green:#16a34a;--red:#dc2626}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{overflow-x:hidden}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:760px;margin:0 auto;padding:28px 16px 48px}
.top h1{margin:0 0 6px;font-size:23px;line-height:1.35}
.top .sub{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.top .meta{margin-top:8px;color:var(--muted);font-size:13px;line-height:1.8;overflow-wrap:anywhere}
.top .meta b{color:var(--ink);font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi .k{color:var(--muted);font-size:12px}
.kpi .v{font-size:26px;font-weight:700;line-height:1.25;margin-top:2px}
.kpi.new .v{color:var(--green)}
.kpi.drop .v{color:var(--red)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 16px;margin:12px 0}
.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:4px;flex-wrap:wrap}
.section-head h2{margin:0;font-size:18px;display:flex;align-items:center;gap:8px}
.section-head h2 em{font-style:normal;font-size:13px;color:var(--muted);font-weight:500}
.section-head .hint{color:var(--muted);font-size:12px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}
.dot.green{background:var(--green)}
.dot.red{background:var(--red)}
.group{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
.group-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}
.group-head .model{font-weight:700;font-size:15px}
.group-head .group-count{color:var(--muted);font-size:12px}
.items{list-style:none;margin:0;padding:0}
.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.car-hit{display:grid;grid-template-columns:116px minmax(0,1fr);gap:14px;padding:10px;border-radius:12px;color:inherit;text-decoration:none;transition:background .15s}
.car-hit:hover{background:#f8fafc}
.car-hit:active{background:#f1f5f9}
.thumb{display:block;width:116px;height:86px;border-radius:10px;overflow:hidden;background:#f1f5f9;position:relative;flex:none}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb.noimg{background:linear-gradient(135deg,#eef2ff,#f8fafc)}
.thumb.noimg:after{content:"闲鱼车源";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12px}
.car-body{min-width:0}
.car-title{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:1.5;color:var(--ink);word-break:break-word}
.car-price{display:flex;align-items:baseline;gap:8px;margin-top:5px;flex-wrap:wrap}
.car-price b{font-size:20px;color:var(--red);font-variant-numeric:tabular-nums;line-height:1.2}
.car-price .old{color:#94a3b8;text-decoration:line-through;font-size:12px}
.car-price .cut{background:#fef2f2;color:var(--red);border-radius:6px;padding:1px 6px;font-size:12px;font-weight:600}
.cmp{font-size:12px;color:#15803d;background:#f0fdf4;border-radius:999px;padding:1px 8px}
.cmp.good{color:#15803d;background:#dcfce7}
.cmp.high{color:#b45309;background:#fffbeb}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chips span{font-size:12px;background:#f1f5f9;color:#475569;border-radius:6px;padding:1px 7px;white-space:nowrap}
.car-foot{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.seller{font-size:12px;color:var(--muted)}
.tags{display:flex;gap:4px;flex-wrap:wrap}
.tag{display:inline-block;font-size:11px;color:var(--muted);background:#f8fafc;border:1px solid #eef0f3;border-radius:6px;padding:0 6px;white-space:nowrap}
.dtags{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
.dtags span{font-size:11px;color:#0369a1;background:#f0f9ff;border:1px solid #e0f2fe;border-radius:999px;padding:0 7px;line-height:20px}
.drisk{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.drisk span{font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:999px;padding:0 7px;line-height:20px}
.desc2{margin-top:7px;color:#475569;font-size:12.5px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.empty{text-align:center;padding:28px 18px}
.empty-icon{width:40px;height:40px;line-height:40px;border-radius:50%;background:#f0fdf4;color:var(--green);font-size:20px;margin:0 auto 10px}
.empty h2{margin:0 0 6px;font-size:17px}
.empty p{margin:0;color:var(--muted);font-size:13px}
.card h3{margin:0 0 10px;font-size:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #eef0f3;vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
td.num{white-space:nowrap;font-variant-numeric:tabular-nums}
.sub{color:var(--muted);font-size:11px}
.pill{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:1px 8px;font-size:12px;white-space:nowrap}
.up{color:var(--red)}
.down{color:var(--green)}
.bad{color:#991b1b}
.details summary{cursor:pointer;color:var(--blue);font-size:13px;list-style:none}
.details summary::-webkit-details-marker{display:none}
.details summary:before{content:"＋ "}
.details[open] summary:before{content:"－ "}
.table-wrap{overflow:auto;margin-top:10px;border:1px solid var(--line);border-radius:8px;max-height:420px}
.stats-wrap{margin-top:0;border:0;border-radius:0}
.stats-wrap table{min-width:420px}
.samples a{font-size:12px}
.foot{color:var(--muted);font-size:12px;line-height:1.9;margin-top:20px}
@media (max-width:560px){
  .wrap{padding:20px 12px 36px}
  .top h1{font-size:20px}
  .kpis{gap:8px}
  .kpi{padding:10px 12px}
  .kpi .v{font-size:22px}
  .car-hit{grid-template-columns:92px minmax(0,1fr);gap:10px;padding:8px}
  .thumb{width:92px;height:70px}
  .car-price b{font-size:18px}
  .stats{font-size:12px}
  .stats th,.stats td{padding:7px 4px}
  .card{padding:14px}
}
@media print{body{background:#fff}.details{display:none}}
`

const CLICK_JS = `
(function(){
  var ua = navigator.userAgent || ''
  var isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua)
  var isWeCom = /wxwork/i.test(ua) || /WeCom/i.test(ua) || /MicroMessenger/i.test(ua)
  var isAndroid = /Android/i.test(ua)
  function appUrl(id){
    if (isAndroid) return 'intent://item?id=' + encodeURIComponent(id) + '#Intent;scheme=fleamarket;package=com.taobao.idlefish;end'
    return 'fleamarket://item?id=' + encodeURIComponent(id)
  }
  function openInApp(id, fallbackUrl){
    var hidden = false
    function markHidden(){ hidden = true }
    document.addEventListener('visibilitychange', markHidden, { once: true })
    window.addEventListener('pagehide', markHidden, { once: true })
    setTimeout(function(){ if (!hidden && !document.hidden) window.location.href = fallbackUrl }, 1600)
    window.location.href = appUrl(id)
  }
  document.addEventListener('click', function(e){
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    var a = e.target && e.target.closest ? e.target.closest('a[data-xianyu-id]') : null
    if (!a || !isMobile) return
    if (isWeCom) return // 企微 WebView 无法拉起外部 App，直接打开网页
    e.preventDefault()
    openInApp(a.getAttribute('data-xianyu-id'), a.getAttribute('href'))
  })
})();
`;

function renderHero(latest, targets, intervalHours) {
  const now = new Date(latest.generatedAt || Date.now())
  const next = new Date(now.getTime() + Math.max(1, intervalHours) * 3600_000)
  const newCount = targets.reduce((n, t) => n + (t.newListings ?? []).length, 0)
  const dropCount = targets.reduce((n, t) => n + (t.priceDrops ?? []).length, 0)
  const sampleCount = targets.reduce((n, t) => n + (t.sampleCount ?? 0), 0)
  return `<div class="top">
    <h1>西安二手车 · 本轮新上架 / 降价</h1>
    <div class="sub">小米SU7 · 理想i6 · 问界M7 · 极氪001 ｜ 闲鱼 ｜ 每 ${esc(intervalHours)} 小时自动扫描</div>
    <div class="meta">更新 <b>${esc(fmtDateTime(latest.generatedAt))}</b><br>下次扫描约 <b>${esc(fmtClock(next))}</b> ｜ 本轮 <b>${targets.filter((t) => t.status !== 'failed').length}/${targets.length}</b> 个车型成功、样本 <b>${sampleCount}</b> 台</div>
  </div>
  <div class="kpis">
    <div class="kpi new"><div class="k">新上架</div><div class="v">${newCount}</div><div class="k">台</div></div>
    <div class="kpi drop"><div class="k">降价</div><div class="v">${dropCount}</div><div class="k">台</div></div>
    <div class="kpi"><div class="k">本轮样本</div><div class="v">${sampleCount}</div><div class="k">台（过滤后）</div></div>
  </div>`
}

export function renderHtmlReport({ latest, intervalHours = 2, title = '西安二手车 · 新上架 / 降价' } = {}) {
  if (!latest || !Array.isArray(latest.targets)) throw new Error('renderHtmlReport: latest.targets 缺失')
  const byTarget = new Map()
  for (const listing of latest.listings ?? []) {
    const id = listing.targetId ?? ''
    if (!byTarget.has(id)) byTarget.set(id, [])
    byTarget.get(id).push(listing)
  }
  const targets = latest.targets.map((t) => ({
    ...t,
    cityListings: Array.isArray(t.cityListings) ? t.cityListings : (byTarget.get(t.targetId) ?? []),
  }))
  const now = Number(latest.generatedAt ? new Date(latest.generatedAt).getTime() : Date.now())
  const hasChanges = targets.some((t) => (t.newListings ?? []).length || (t.priceDrops ?? []).length)
  const baseline = targets.some((t) => t.firstRun)

  const body = [
    renderHero(latest, targets, intervalHours),
    newSection(targets, now),
    dropSection(targets, now),
    emptyState(hasChanges, baseline),
    `<section class="card"><h3>各车型行情（本轮样本）</h3>${statsTable(targets)}</section>`,
    sampleDetails(targets, now),
    `<div class="foot">数据为闲鱼卖家报价，仅供参考。</div>`,
  ].filter(Boolean).join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<title>${esc(title)} · ${esc(fmtDateTime(latest.generatedAt))}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
<script>${CLICK_JS}</script>
</body>
</html>
`
}

/** 单次查询结果页：干净的车源卡片列表，整卡可点。 */
export function renderQueryPage({ keyword = '', city = '西安', agg = {}, listings = [], now = Date.now() } = {}) {
  const items = (Array.isArray(listings) ? listings : [])
    .filter((l) => l && Number(l.priceYuan))
    .sort((a, b) => Number(a.priceYuan) - Number(b.priceYuan))
    .slice(0, 40)
  const median = agg?.price?.median
  const min = agg?.price?.min
  const meta = [
    `共 <b>${items.length}</b> 台在售`,
    median ? `中位 <b>${wan(median)}</b>` : null,
    min ? `最低 <b>${wan(min)}</b>` : null,
  ].filter(Boolean).join(' ｜ ')
  const list = items.length
    ? `<section class="card"><ul class="items">${items.map((l) => carCard({ listing: l, now, median })).join('')}</ul></section>`
    : '<section class="card"><div class="empty">没搜到在售车源</div></section>'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<title>${esc(keyword)} · 闲鱼车源</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>${esc(keyword)}</h1>
    <div class="sub">${esc(city)} · 闲鱼在售车源</div>
    <div class="meta">${meta}</div>
  </div>
  ${list}
</div>
<script>${CLICK_JS}</script>
</body>
</html>
`
}

/** 从 latest.json 生成并写入 HTML；返回输出路径。 */
export async function writeHtmlReport({ latestPath, outPath, intervalHours = 2 }) {
  const latest = JSON.parse(await readFile(latestPath, 'utf8'))
  const html = renderHtmlReport({ latest, intervalHours })
  const target = outPath || path.join(path.dirname(latestPath), REPORT_NAME)
  // 原子写：先写临时文件再 rename，避免手机正好在建站过程中打开到半截 HTML
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, html, 'utf8')
  await rename(tmp, target)
  return target
}

export { REPORT_NAME }
