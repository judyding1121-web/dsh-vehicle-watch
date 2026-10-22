/**
 * 单文件 HTML 看板渲染（不依赖任何外部 CDN/资源，双击即可用浏览器打开）。
 *
 * 设计目标：一轮扫描的车源太多，群卡片只适合「看变化」；看板用于「看全量」：
 *   - 顶部 KPI + 本轮新增/降价速览
 *   - 每个车型一张卡片区：样本/分位/分布图 + 可搜索、可排序的全量车源表
 *   - 扫描历史、口径说明
 *
 * 由 src/service.js 在每次扫描后写入 reportDir/二手车监控-最新.html；
 * 也可用 `node scripts/make_html.mjs <latest.json> [out.html]` 手动重生成。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const REPORT_NAME = '二手车监控-最新.html'

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}

function safeUrl(url) {
  const s = String(url ?? '')
  return /^https?:\/\//.test(s) ? esc(s) : '#'
}

function wan(yuan) {
  if (yuan == null || !Number.isFinite(Number(yuan))) return '—'
  return (Number(yuan) / 10000).toFixed(2) + '万'
}

function wanTight(yuan) {
  if (yuan == null || !Number.isFinite(Number(yuan))) return '—'
  return (Number(yuan) / 10000).toFixed(2)
}

function pct(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return (Number(value) * 100).toFixed(digits) + '%'
}

function kmText(km) {
  if (km == null || !Number.isFinite(Number(km))) return '—'
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
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function relPublish(ms, nowMs) {
  const t = Number(ms)
  if (!t) return '—'
  const diff = Math.max(0, nowMs - t)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}分钟前`
  if (diff < day) return `${Math.round(diff / hour)}小时前`
  return `${Math.round(diff / day)}天前`
}

function statusBadge(status) {
  const map = {
    ok: ['ok', '正常'],
    partial: ['warn', '样本偏少'],
    failed: ['bad', '扫描失败'],
  }
  const [cls, label] = map[status] ?? ['muted', status ?? '未知']
  return `<span class="badge ${cls}">${esc(label)}</span>`
}

function trendText(compare) {
  if (!compare || compare.prevMedian == null || compare.medianDelta == null) return '—'
  if (compare.medianDelta === 0) return '持平'
  const sign = compare.medianDelta > 0 ? '+' : ''
  const cls = compare.medianDelta > 0 ? 'up' : 'down'
  return `<span class="${cls}">${sign}${wan(Math.abs(compare.medianDelta)).replace('万', '')}万（${sign}${Number(compare.medianDeltaPct).toFixed(1)}%）</span>`
}

function statCard(label, value, hint = '') {
  return `<div class="stat"><div class="stat-k">${esc(label)}</div><div class="stat-v">${value}</div>${hint ? `<div class="stat-h">${esc(hint)}</div>` : ''}</div>`
}

function priceBuckets(listings) {
  const prices = listings.map((l) => Number(l.priceYuan)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!prices.length) return []
  const min = prices[0]
  const max = prices[prices.length - 1]
  if (min === max) return [{ label: wan(min), count: prices.length, ratio: 1 }]
  const count = 5
  const step = (max - min) / count
  const buckets = Array.from({ length: count }, (_, i) => {
    const lo = min + step * i
    const hi = i === count - 1 ? max : min + step * (i + 1)
    return { lo, hi, count: 0 }
  })
  for (const p of prices) {
    let idx = Math.min(count - 1, Math.floor((p - min) / step))
    if (p === max) idx = count - 1
    buckets[idx].count += 1
  }
  const peak = Math.max(...buckets.map((b) => b.count), 1)
  return buckets.map((b) => ({
    label: `${wanTight(b.lo)}–${wanTight(b.hi)}万`,
    count: b.count,
    ratio: b.count / peak,
  }))
}

function distribution(listings) {
  const buckets = priceBuckets(listings)
  if (!buckets.length) return '<div class="empty small">暂无价格分布（样本为 0）</div>'
  return `<div class="dist">${buckets.map((b) => `
    <div class="dist-row">
      <span class="dist-label">${esc(b.label)}</span>
      <span class="dist-bar"><i style="width:${Math.max(2, Math.round(b.ratio * 100))}%"></i></span>
      <span class="dist-count">${b.count} 台</span>
    </div>`).join('')}</div>`
}

function listingRow(l, { newIds, drops, now, showModel = false }) {
  const isNew = newIds?.has(l.listingId)
  const drop = drops?.get(l.listingId)
  const tags = (l.tags ?? []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')
  const yearCell = [l.modelYear ? `${l.modelYear}款` : null, l.licenseYear ? `${l.licenseYear}年上牌` : null]
    .filter(Boolean).join(' · ') || '—'
  const flags = [isNew ? 'new' : null, drop ? 'drop' : null].filter(Boolean).join(' ')
  const priceCell = drop
    ? `<b class="price">${wan(l.priceYuan)}</b><span class="old">${wan(drop.oldPrice)}</span>`
    : `<b class="price">${wan(l.priceYuan)}</b>`
  return `<tr class="row ${flags}" data-price="${Number(l.priceYuan) || 0}" data-time="${Number(l.publishTime) || 0}" data-mileage="${Number(l.mileageKm) || 0}" data-flag="${flags}">
    ${showModel ? `<td class="col-model"><span class="model-chip">${esc(l.seriesName ?? '')}</span></td>` : ''}
    <td class="col-price">${priceCell}</td>
    <td class="col-year">${esc(yearCell)}</td>
    <td class="col-mileage">${esc(kmText(l.mileageKm))}</td>
    <td class="col-area">${esc(l.area || l.cityDesc || '—')}</td>
    <td class="col-title"><a href="${safeUrl(l.detailUrl)}" target="_blank" rel="noopener" title="${esc(l.title)}">${esc(l.title)}</a><div class="sub">${tags}</div></td>
    <td class="col-want">${l.wantCount != null ? esc(l.wantCount) : '—'}</td>
    <td class="col-time">${esc(relPublish(l.publishTime, now))}</td>
    <td class="col-link"><a class="link" href="${safeUrl(l.detailUrl)}" target="_blank" rel="noopener">闲鱼</a></td>
  </tr>`
}

function listingTable(listings, { newIds = null, drops = null, now, showModel = false, id = '' }) {
  if (!listings.length) return '<div class="empty small">暂无车源</div>'
  const headers = [
    showModel ? '<th data-sort="model">车型</th>' : '',
    '<th data-sort="price" class="sortable">价格</th>',
    '<th>年款</th>',
    '<th data-sort="mileage" class="sortable">里程</th>',
    '<th>地区</th>',
    '<th>标题</th>',
    '<th data-sort="want">想要</th>',
    '<th data-sort="time" class="sortable">发布</th>',
    '<th></th>',
  ].join('')
  const rows = listings.map((l) => listingRow(l, { newIds, drops, now, showModel })).join('')
  return `<div class="table-wrap"><table class="listings" id="${esc(id)}">
    <thead><tr>${headers}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function changeFeed(targets, now) {
  const items = []
  for (const t of targets) {
    for (const l of t.newListings ?? []) {
      items.push({ kind: 'new', target: t, listing: l })
    }
    for (const d of t.priceDrops ?? []) {
      items.push({ kind: 'drop', target: t, listing: d.listing, oldPrice: d.oldPrice })
    }
  }
  if (!items.length) {
    return `<div class="empty">本轮没有新上架/降价。首次扫描或换源后的第一轮只建立基线；之后只显示增量。</div>`
  }
  return `<div class="feed">${items.map((it) => {
    const isNew = it.kind === 'new'
    const price = isNew
      ? `<b>${wan(it.listing.priceYuan)}</b>`
      : `<span class="old">${wan(it.oldPrice)}</span> → <b class="price">${wan(it.listing.priceYuan)}</b>`
    const label = isNew ? '新上架' : '降价'
    return `<a class="feed-item ${isNew ? 'feed-new' : 'feed-drop'}" href="${safeUrl(it.listing.detailUrl)}" target="_blank" rel="noopener">
      <span class="feed-tag">${label}</span>
      <span class="feed-model">${esc(it.target.seriesName)}</span>
      <span class="feed-title">${esc(it.listing.title)}</span>
      <span class="feed-price">${price}</span>
      <span class="feed-meta">${esc(it.listing.area || it.target.city || '')} · ${esc(relPublish(it.listing.publishTime, now))}</span>
    </a>`
  }).join('')}</div>`
}

function targetSection(t, { now, intervalHours }) {
  const listings = (t.cityListings ?? [])
  const newIds = new Set((t.newListings ?? []).map((l) => l.listingId))
  const drops = new Map((t.priceDrops ?? []).map((d) => [d.listing.listingId, d]))
  const total = listings.length
  const failed = t.status === 'failed'

  if (failed) {
    return `<section class="model" id="m-${esc(t.targetId)}">
      <div class="model-head">
        <div><h2>${esc(t.seriesName)} ${statusBadge('failed')}</h2>
          <div class="model-meta">关键词 <code>${esc(t.keyword ?? '')}</code> · 扫描失败</div></div>
      </div>
      <div class="error-box">扫描失败：${esc(t.error || '未知错误')}</div>
    </section>`
  }

  const stats = [
    statCard('样本', `${t.sampleCount ?? 0} 台`, `原始 ${t.rawCount ?? 0} 条 · 过滤 ${t.outOfCityCount ?? 0}`),
    statCard('最低', wan(t.price?.min)),
    statCard('中位', `<b>${wan(t.price?.median)}</b>`),
    statCard('P25–P75', `${wan(t.price?.p25)} – ${wan(t.price?.p75)}`),
    statCard('最高', wan(t.price?.max)),
    statCard('准新占比', t.mileage?.nearlyNewRatio != null ? pct(t.mileage.nearlyNewRatio) : '—', '≤1万km 且 1 年内上牌'),
    statCard('参考折价', t.reference?.discountVsOfficialLow != null ? pct(t.reference.discountVsOfficialLow) : '—', '中位 ÷ 指导价下限'),
    statCard('较上次', trendText(t.compare)),
  ].join('')

  const changeChips = [
    (t.newListings ?? []).length ? `<span class="chip new">新上架 ${(t.newListings ?? []).length}</span>` : '',
    (t.priceDrops ?? []).length ? `<span class="chip drop">降价 ${(t.priceDrops ?? []).length}</span>` : '',
    t.status === 'partial' ? `<span class="chip warn">样本偏少，行情仅供参考</span>` : '',
  ].filter(Boolean).join('')

  return `<section class="model" id="m-${esc(t.targetId)}">
    <div class="model-head">
      <div>
        <h2>${esc(t.seriesName)} ${statusBadge(t.status)}</h2>
        <div class="model-meta">
          关键词 <a href="${safeUrl(t.url)}" target="_blank" rel="noopener">${esc(t.keyword ?? '')}</a>
          · 结果总数 ${t.pageTotal != null ? esc(t.pageTotal) : '未知'} 条
          · 本轮样本 ${t.sampleCount ?? 0} 台
          ${t.hasNextPage ? '· 还有下一页' : ''}
        </div>
      </div>
      <div class="chips">${changeChips}</div>
    </div>
    <div class="stats">${stats}</div>
    <div class="panel">
      <div class="panel-head"><h3>价格分布</h3><span class="hint">按本轮样本挂牌价分 5 档</span></div>
      ${distribution(listings)}
    </div>
    ${(t.newListings ?? []).length ? `<div class="panel">
      <div class="panel-head"><h3>本轮新上架</h3><span class="hint">${(t.newListings ?? []).length} 台</span></div>
      ${listingTable(t.newListings, { now, id: `new-${t.targetId}` })}
    </div>` : ''}
    ${(t.priceDrops ?? []).length ? `<div class="panel">
      <div class="panel-head"><h3>本轮降价</h3><span class="hint">${(t.priceDrops ?? []).length} 台</span></div>
      ${listingTable((t.priceDrops ?? []).map((d) => d.listing), { drops, now, id: `drop-${t.targetId}` })}
    </div>` : ''}
    <div class="panel">
      <div class="panel-head">
        <h3>全部车源</h3>
        <span class="hint">${total} 台 · 点击表头可按价格/里程/发布时间排序</span>
      </div>
      ${listingTable(listings, { newIds, drops, now, id: `all-${t.targetId}` })}
    </div>
  </section>`
}

function overviewTable(targets) {
  const rows = targets.map((t) => {
    if (t.status === 'failed') {
      return `<tr class="bad-row"><td><a href="#m-${esc(t.targetId)}">${esc(t.seriesName)}</a></td><td colspan="8">扫描失败：${esc(t.error || '')}</td></tr>`
    }
    return `<tr>
      <td><a href="#m-${esc(t.targetId)}">${esc(t.seriesName)}</a>${t.keyword && t.keyword !== t.seriesName ? `<div class="sub"><code>${esc(t.keyword)}</code></div>` : ''}</td>
      <td>${t.sampleCount ?? 0}</td>
      <td>${wan(t.price?.min)}</td>
      <td>${wan(t.price?.p25)}</td>
      <td><b>${wan(t.price?.median)}</b></td>
      <td>${wan(t.price?.p75)}</td>
      <td>${wan(t.price?.max)}</td>
      <td>${(t.newListings ?? []).length}/${(t.priceDrops ?? []).length}</td>
      <td>${statusBadge(t.status)}</td>
    </tr>`
  }).join('')
  return `<div class="table-wrap"><table class="overview">
    <thead><tr><th>车型</th><th>样本</th><th>最低</th><th>P25</th><th>中位</th><th>P75</th><th>最高</th><th>新增/降价</th><th>状态</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function scanHistory(scanLog) {
  const rows = [...scanLog].reverse().slice(0, 12)
  if (!rows.length) return '<div class="empty small">暂无扫描历史</div>'
  return `<div class="table-wrap"><table class="history">
    <thead><tr><th>时间</th><th>触发</th><th>车型</th><th>成功/失败</th><th>新增</th><th>降价</th><th>推送</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(fmtDateTime(r.scannedAt))}</td>
      <td><code>${esc(r.trigger ?? '')}</code></td>
      <td>${esc(r.targets ?? '')}</td>
      <td>${esc(r.okTargets ?? '')}/${esc(r.failedTargets ?? '')}</td>
      <td>${esc(r.newListings ?? 0)}</td>
      <td>${esc(r.priceDrops ?? 0)}</td>
      <td>${esc(r.messages ?? 0)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`
}

const STYLE = `
:root{
  --bg:#f4f6fb; --card:#ffffff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0;
  --primary:#2563eb; --primary-ink:#1e3a8a; --new:#16a34a; --drop:#dc2626; --warn:#d97706;
  --shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.06);
  --radius:14px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
a{color:var(--primary);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1180px;margin:0 auto;padding:24px 20px 60px}
.hero{background:linear-gradient(120deg,#0f172a 0%,#1e3a8a 60%,#1d4ed8 100%);color:#fff;border-radius:20px;padding:28px 30px;display:flex;gap:24px;justify-content:space-between;flex-wrap:wrap;box-shadow:var(--shadow)}
.hero h1{margin:6px 0 8px;font-size:26px;line-height:1.3;letter-spacing:.2px}
.hero-kicker{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#bfdbfe}
.hero-sub{margin:0;color:#dbeafe;font-size:13px}
.hero-meta{display:grid;grid-template-columns:auto auto;gap:10px 26px;align-content:center;font-size:13px}
.hero-meta div{display:flex;flex-direction:column;gap:2px;min-width:120px}
.hero-meta .k{color:#93c5fd;font-size:11px;letter-spacing:.08em}
.hero-meta b{font-weight:600;color:#fff}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:18px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow)}
.kpi .k{color:var(--muted);font-size:12px}
.kpi .v{font-size:24px;font-weight:700;margin-top:2px}
.kpi .h{color:var(--muted);font-size:12px}
.model-nav{display:flex;gap:8px;flex-wrap:wrap;margin:-6px 0 18px;position:sticky;top:8px;z-index:6;background:rgba(244,246,251,.92);backdrop-filter:blur(6px);padding:6px 0}
.nav-pill{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 12px;font-size:13px;color:#334155;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.nav-pill:hover{border-color:#93c5fd;text-decoration:none;color:var(--primary)}
.nav-name{font-weight:600}
.nav-count{color:var(--muted);font-size:12px}
.nav-pill.is-bad{border-color:#fecaca;color:#991b1b}
.nav-top{margin-left:auto;color:var(--muted)}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:10px 14px;margin:0 0 18px;box-shadow:var(--shadow)}
.toolbar input[type=search]{flex:1;min-width:220px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13px;outline:none}
.toolbar input[type=search]:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.toolbar label{font-size:13px;color:var(--muted);display:flex;gap:6px;align-items:center;cursor:pointer}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 20px;margin:18px 0}
.card>h2{margin:0 0 4px;font-size:18px}
.card .sub{color:var(--muted);font-size:12px}
.overview,.listings,.history{width:100%;border-collapse:collapse;font-size:13px}
.overview th,.listings th,.history th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;background:#f8fafc;position:sticky;top:0;z-index:1}
.overview td,.listings td,.history td{padding:9px 10px;border-bottom:1px solid #eef2f7;vertical-align:top}
.overview tr:hover td,.listings tr:hover td,.history tr:hover td{background:#f8fafc}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;max-height:560px}
.model{margin:34px 0}
.model-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}
.model-head h2{margin:0;font-size:22px;display:flex;gap:10px;align-items:center}
.model-meta{color:var(--muted);font-size:13px;margin-top:4px}
.model-meta code{background:#eef2ff;color:#3730a3;padding:1px 6px;border-radius:6px;font-size:12px}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--muted)}
.chip.new{color:var(--new);border-color:#bbf7d0;background:#f0fdf4}
.chip.drop{color:var(--drop);border-color:#fecaca;background:#fef2f2}
.chip.warn{color:var(--warn);border-color:#fde68a;background:#fffbeb}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}
.stat-k{color:var(--muted);font-size:12px}
.stat-v{font-size:18px;font-weight:700;margin-top:2px}
.stat-v b{font-size:20px}
.stat-h{color:var(--muted);font-size:11px;margin-top:2px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px 18px;margin:14px 0}
.panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.panel-head h3{margin:0;font-size:15px}
.panel-head .hint{color:var(--muted);font-size:12px}
.badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);font-weight:600}
.badge.ok{color:var(--new);border-color:#bbf7d0;background:#f0fdf4}
.badge.warn{color:var(--warn);border-color:#fde68a;background:#fffbeb}
.badge.bad{color:var(--drop);border-color:#fecaca;background:#fef2f2}
.badge.muted{color:var(--muted);background:#f8fafc}
.dist{display:flex;flex-direction:column;gap:6px}
.dist-row{display:grid;grid-template-columns:130px 1fr 60px;gap:10px;align-items:center;font-size:12px}
.dist-label{color:var(--muted);font-variant-numeric:tabular-nums}
.dist-bar{height:10px;background:#eef2f7;border-radius:999px;overflow:hidden}
.dist-bar i{display:block;height:100%;background:linear-gradient(90deg,#60a5fa,#2563eb);border-radius:999px}
.dist-count{text-align:right;color:var(--ink);font-variant-numeric:tabular-nums}
.feed{display:flex;flex-direction:column;gap:8px}
.feed-item{display:grid;grid-template-columns:64px 78px 1fr auto 140px;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--ink)}
.feed-item:hover{background:#f8fafc;text-decoration:none;border-color:#cbd5e1}
.feed-tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;text-align:center}
.feed-new .feed-tag{color:var(--new);background:#f0fdf4}
.feed-drop .feed-tag{color:var(--drop);background:#fef2f2}
.feed-model{font-weight:600;font-size:13px}
.feed-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#334155}
.feed-price{font-variant-numeric:tabular-nums;white-space:nowrap}
.feed-meta{font-size:12px;color:var(--muted);text-align:right;white-space:nowrap}
.price{font-variant-numeric:tabular-nums;color:var(--ink);white-space:nowrap}
.old{color:#94a3b8;text-decoration:line-through;font-size:12px;margin-left:4px}
tr.row.new td{background:#f0fdf4}
tr.row.drop td{background:#fef2f2}
.tag{display:inline-block;font-size:11px;color:var(--muted);background:#f1f5f9;border-radius:6px;padding:0 6px;margin:2px 4px 0 0;white-space:nowrap}
.sub{color:var(--muted);font-size:12px}
.col-price{white-space:nowrap}
.col-title{min-width:280px;max-width:460px}
.col-title a{color:#1e293b;font-weight:500}
.col-title a:hover{color:var(--primary)}
.col-model{white-space:nowrap}
.model-chip{font-size:12px;background:#eef2ff;color:#3730a3;border-radius:999px;padding:1px 8px}
.col-link .link{font-size:12px;color:var(--primary)}
.empty{background:#fff;border:1px dashed #cbd5e1;color:var(--muted);border-radius:12px;padding:18px 20px;text-align:center;font-size:13px}
.empty.small{padding:12px 16px;border-radius:10px;text-align:left}
.error-box{border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:12px;padding:14px 16px;font-size:13px}
.up{color:var(--drop)}
.down{color:var(--new)}
.foot{color:var(--muted);font-size:12px;margin-top:26px;line-height:1.9}
.foot code{background:#eef2ff;color:#3730a3;padding:1px 6px;border-radius:6px}
.notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:10px}
.note{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:12px;color:#475569;background:#fbfdff}
.section-title{display:flex;justify-content:space-between;align-items:baseline;margin:30px 0 10px;gap:12px;flex-wrap:wrap}
.section-title h2{margin:0;font-size:19px}
.hidden{display:none !important}
@media (max-width:760px){
  .hero{padding:22px 18px}
  .hero h1{font-size:21px}
  .hero-meta{grid-template-columns:1fr 1fr;width:100%}
  .feed-item{grid-template-columns:60px 1fr;grid-auto-rows:auto}
  .feed-model,.feed-meta{display:none}
  .col-title{min-width:200px}
  .wrap{padding:14px 12px 40px}
}
@media print{
  body{background:#fff}
  .toolbar{display:none}
  .card,.panel,.stat,.hero{box-shadow:none}
  .table-wrap{max-height:none;overflow:visible}
}
`

const SCRIPT = `
(function(){
  function textOf(row){return (row.textContent||'').toLowerCase()}
  var search=document.getElementById('q');
  var onlyChanges=document.getElementById('onlyChanges');
  function applyFilters(){
    var q=(search&&search.value||'').trim().toLowerCase();
    var only=onlyChanges&&onlyChanges.checked;
    document.querySelectorAll('table.listings tbody tr').forEach(function(tr){
      var okQ=!q||textOf(tr).indexOf(q)>=0;
      var okC=!only||tr.dataset.flag;
      tr.classList.toggle('hidden',!(okQ&&okC));
    });
  }
  if(search)search.addEventListener('input',applyFilters);
  if(onlyChanges)onlyChanges.addEventListener('change',applyFilters);

  document.querySelectorAll('th.sortable').forEach(function(th){
    th.style.cursor='pointer';
    th.addEventListener('click',function(){
      var table=th.closest('table');
      var tbody=table.querySelector('tbody');
      var key=th.dataset.sort;
      var dir=th.dataset.dir==='asc'?'desc':'asc';
      table.querySelectorAll('th.sortable').forEach(function(o){delete o.dataset.dir});
      th.dataset.dir=dir;
      var rows=Array.prototype.slice.call(tbody.querySelectorAll('tr'));
      rows.sort(function(a,b){
        var av=(a.dataset[key]===undefined?'':a.dataset[key]);
        var bv=(b.dataset[key]===undefined?'':b.dataset[key]);
        var na=parseFloat(av),nb=parseFloat(bv);
        var cmp=(isNaN(na)||isNaN(nb))?String(av).localeCompare(String(bv)):na-nb;
        return dir==='asc'?cmp:-cmp;
      });
      rows.forEach(function(r){tbody.appendChild(r)});
    });
  });
})();
`

function renderHero(latest, targets, intervalHours) {
  const now = new Date(latest.generatedAt || Date.now())
  const next = new Date(now.getTime() + Math.max(1, intervalHours) * 3600_000)
  const samples = targets.reduce((n, t) => n + (t.sampleCount ?? 0), 0)
  const raw = targets.reduce((n, t) => n + (t.rawCount ?? 0), 0)
  const filtered = targets.reduce((n, t) => n + (t.outOfCityCount ?? 0), 0)
  const newCount = targets.reduce((n, t) => n + (t.newListings ?? []).length, 0)
  const dropCount = targets.reduce((n, t) => n + (t.priceDrops ?? []).length, 0)
  const totalResults = targets.reduce((n, t) => n + (t.pageTotal ?? 0), 0)
  return `<header class="hero">
    <div>
      <div class="hero-kicker">DSH Plugin · 闲鱼行情看板</div>
      <h1>西安四车型 · 二手车监控</h1>
      <p class="hero-sub">小米SU7 / 理想i6 / 问界M7 / 极氪001 · 每 ${esc(intervalHours)} 小时自动扫描 · 卖家报价，非成交价</p>
    </div>
    <div class="hero-meta">
      <div><span class="k">更新时间</span><b>${esc(fmtDateTime(latest.generatedAt))}</b></div>
      <div><span class="k">触发</span><b>${esc(latest.trigger ?? '—')}</b></div>
      <div><span class="k">数据源</span><b>闲鱼 goofish.com</b></div>
      <div><span class="k">下次预计</span><b>约 ${esc(fmtClock(next))}</b></div>
      <div><span class="k">城市</span><b>${esc(latest.city ?? '西安')}</b></div>
      <div><span class="k">车型数</span><b>${targets.length}</b></div>
    </div>
  </header>
  <div class="kpis">
    <div class="kpi"><div class="k">本轮样本</div><div class="v">${samples}</div><div class="h">原始 ${raw} 条，过滤 ${filtered}</div></div>
    <div class="kpi"><div class="k">新上架</div><div class="v">${newCount}</div><div class="h">本轮增量</div></div>
    <div class="kpi"><div class="k">降价</div><div class="v">${dropCount}</div><div class="h">降幅 ≥ 阈值</div></div>
    <div class="kpi"><div class="k">搜索命中</div><div class="v">${totalResults || '—'}</div><div class="h">闲鱼结果总数（含噪音）</div></div>
    <div class="kpi"><div class="k">覆盖车型</div><div class="v">${targets.filter((t) => t.status !== 'failed').length}/${targets.length}</div><div class="h">扫描成功</div></div>
  </div>`
}

function renderNotes() {
  return `<div class="card">
    <h2>口径与说明</h2>
    <div class="notes">
      <div class="note"><b>报价口径</b><br>闲鱼卖家挂牌报价，可议价，<b>不是成交价</b>；同一台车可能重复挂牌或由车商发布。</div>
      <div class="note"><b>样本口径</b><br>每个关键词取搜索结果前 N 页（默认 1 页 30 条），并按「二手车类目 + 价格下限 + 关键词 + 排除词」过滤；样本 ≠ 全站。</div>
      <div class="note"><b>新增/降价</b><br>与上次扫描的 listing_id / 价格对比；首次扫描或换源后的第一轮只建立基线，不产生增量。</div>
      <div class="note"><b>参考折价</b><br>样本中位价 ÷ 新车指导价下限，未做年款/配置匹配，仅看趋势。</div>
      <div class="note"><b>数据来源</b><br><a href="https://www.goofish.com/" target="_blank" rel="noopener">闲鱼 goofish.com</a> · 低频个人监控 · 不公开分发数据。</div>
      <div class="note"><b>生成方式</b><br>DSH 插件 <code>dsh-vehicle-watch</code> 每次扫描后自动重写本文件；刷新浏览器即可看最新一轮。</div>
    </div>
  </div>`
}

export function renderHtmlReport({ latest, scanLog = [], intervalHours = 2, title = '西安四车型 · 闲鱼二手车监控' } = {}) {
  if (!latest || !Array.isArray(latest.targets)) throw new Error('renderHtmlReport: latest.targets 缺失')
  // latest.json 里 target.cityListings 被剔除以减小体积；渲染时从 latest.listings 按 targetId 挂回去
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
  const body = [
    renderHero(latest, targets, intervalHours),
    `<div class="toolbar">
      <input id="q" type="search" placeholder="搜索车型 / 标题 / 地区…（实时过滤所有表格）">
      <label><input id="onlyChanges" type="checkbox"> 只看新增/降价</label>
      <span class="hint sub">共 ${targets.reduce((n, t) => n + (t.cityListings ?? []).length, 0)} 台样本</span>
    </div>`,
    `<nav class="model-nav">${targets.map((t) => `<a href="#m-${esc(t.targetId)}" class="nav-pill ${t.status === 'failed' ? 'is-bad' : ''}">
      <span class="nav-name">${esc(t.seriesName)}</span>
      <span class="nav-count">${t.status === 'failed' ? '失败' : `${t.sampleCount ?? 0} 台`}</span>
    </a>`).join('')}<a href="#top" class="nav-pill nav-top">↑ 顶部</a></nav>`,
    `<div class="card"><h2>车型总览</h2><div class="sub">点击车型名跳到详情；表格按本轮扫描结果生成</div>${overviewTable(targets)}</div>`,
    `<div class="section-title"><h2>本轮变化</h2><span class="sub">新上架 / 降价（最多展示全部增量）</span></div><div class="card">${changeFeed(targets, now)}</div>`,
    ...targets.map((t) => targetSection(t, { now, intervalHours })),
    `<div class="card"><h2>扫描历史</h2><div class="sub">最近 12 轮（来自 scan-log.jsonl）</div>${scanHistory(scanLog)}</div>`,
    renderNotes(),
    `<div class="foot">生成时间 ${esc(fmtDateTime(latest.generatedAt))} · 数据文件 <code>latest.json</code> · 生成器 <code>dsh-vehicle-watch/src/html-report.js</code> · 本页为单文件静态报告，可直接保存/打印。</div>`,
  ].join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(fmtDateTime(latest.generatedAt))}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap" id="top">
${body}
</div>
<script>${SCRIPT}</script>
</body>
</html>
`
}

/** 从 latest.json + scan-log.jsonl 生成并写入 HTML；返回输出路径。 */
export async function writeHtmlReport({ latestPath, scanLogPath = '', outPath, intervalHours = 2 }) {
  const latest = JSON.parse(await readFile(latestPath, 'utf8'))
  let scanLog = []
  if (scanLogPath) {
    try {
      const text = await readFile(scanLogPath, 'utf8')
      scanLog = text.split('\n').filter((line) => line.trim()).slice(-20).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
    } catch { /* 没有历史文件也无妨 */ }
  }
  const html = renderHtmlReport({ latest, scanLog, intervalHours })
  const target = outPath || path.join(path.dirname(latestPath), REPORT_NAME)
  await writeFile(target, html, 'utf8')
  return target
}

export { REPORT_NAME }
