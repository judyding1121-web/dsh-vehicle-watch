import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { aggregateListings, createXianyuClient, filterListings, parseXianyuDetail, searchUrl } from './xianyu.js'
import { summarizeListing } from './decision.js'
import { loadState, pruneSeen, saveState } from './state.js'
import { buildMessages, formatWan, Notifier } from './notify.js'
import { generateReport } from './report.js'
import { REPORT_NAME, renderQueryPage, writeHtmlReport } from './html-report.js'
import { addWatchTargets, clearPending, getPending, loadWatchState, removeWatchTarget, setPending } from './runtime-store.js'

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DEFAULT_EXCLUDES = ['租车', '日租', '床垫', '车模', '配件', '订单', '返现', '定金', '事故', '水淹', '残值', '批发']

function localIso(d = new Date()) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d)
  return s.replace(' ', 'T') + '+08:00'
}

export function createService({ config, statePath, reportDir, reportScriptPath, log = console, xianyuClient = null }) {
  const notifier = new Notifier({
    wecomWebhook: config.notify?.wecomWebhook ?? '',
    feishuWebhook: config.notify?.feishuWebhook ?? '',
    feishuSecret: config.notify?.feishuSecret ?? '',
    timeoutMs: config.notify?.timeoutMs ?? 10000,
    log,
  })
  const cityName = config.city || config.cityName || '西安'
  const province = config.province || '陕西'
  const minPriceYuan = config.minPriceYuan ?? 30000
  const excludeKeywords = config.excludeKeywords ?? DEFAULT_EXCLUDES
  const carCategoryId = config.carCategoryId ?? '127302001'
  const pages = Math.max(1, config.xianyu?.pages ?? 1)
  const adaptivePages = config.xianyu?.adaptivePages !== false
  const enrichDetails = config.xianyu?.enrichDetails !== false
  const enrichMax = Math.max(0, config.xianyu?.enrichMax ?? 12)
  const queryEnrichMax = Math.max(0, config.xianyu?.queryEnrichMax ?? 3)
  const xianyu = xianyuClient ?? createXianyuClient({
    cookie: config.xianyu?.cookie ?? '',
    minGapMs: config.xianyu?.minGapMs ?? config.fetch?.minGapMs ?? 3000,
    timeoutMs: config.xianyu?.timeoutMs ?? config.fetch?.timeoutMs ?? 20000,
    userAgent: config.fetch?.userAgent || DEFAULT_UA,
    log,
  })
  let running = false
  let dashboard = { enabled: false }

  /** 原子写文件：先写临时文件再 rename，避免看板/接口读到半截内容。 */
  async function writeAtomic(file, content) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, file)
  }

  function setDashboard(info) {
    dashboard = info ?? { enabled: false }
  }

  async function loadTargets({ includeDisabled = false } = {}) {
    const watch = await loadWatchState(statePath)
    const disabled = new Set(watch.disabledIds)
    const map = new Map((config.targets ?? []).map((t) => [t.id, {
      ...t, enabled: t.enabled !== false && !disabled.has(t.id),
    }]))
    for (const t of watch.targets) {
      if (!map.has(t.id)) map.set(t.id, { ...t, enabled: t.enabled !== false && !disabled.has(t.id) })
    }
    // 兼容旧配置：没有 keyword 的目标用 name 当搜索词
    return [...map.values()]
      .filter((t) => includeDisabled || t.enabled)
      .map((t) => ({ ...t, keyword: t.keyword || t.name }))
  }

  // 详情缓存：同一商品 10 分钟内不重复请求（扫描/查询/看板查询共用）
  const detailCache = new Map()
  const DETAIL_TTL_MS = 10 * 60_000

  async function getDetail(listingId) {
    if (typeof xianyu?.detail !== 'function') return null
    const hit = detailCache.get(String(listingId))
    if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.detail
    try {
      const raw = await xianyu.detail(listingId)
      const detail = parseXianyuDetail(raw)
      if (detail) detailCache.set(String(listingId), { at: Date.now(), detail })
      return detail
    } catch (err) {
      log.warn?.('detail %s failed: %s', listingId, err?.message ?? err)
      return null
    }
  }

  /** 给指定车源补详情 + 决策标签（只用于新上架/降价/查询 Top N，控制请求量）。 */
  async function enrichListings(listings, { median = null, max = 0 } = {}) {
    const picked = (listings ?? []).filter((l) => l?.listingId).slice(0, Math.max(0, max))
    for (const listing of picked) {
      const detail = await getDetail(listing.listingId)
      if (detail) listing.detail = detail
      listing.decision = summarizeListing(listing, { median, cityName })
    }
    return picked.filter((l) => l.detail).length
  }

  /** 抓一个 target 的搜索结果（自适应翻页）：首页过滤后样本多才补第 2 页。 */
  async function fetchTargetListings(target) {
    const collected = []
    let rawCount = 0
    let pageInfo = { page: 1, total: null, hasNextPage: null }

    const fetchPage = async (page) => {
      const res = await xianyu.search(target.keyword, page, { province, city: cityName })
      rawCount += res.rawCount
      collected.push(...res.listings)
      pageInfo = { ...res.pageInfo, page }
      return res
    }
    const dedupFilter = () => {
      const dedup = new Map()
      for (const listing of collected) if (!dedup.has(listing.listingId)) dedup.set(listing.listingId, listing)
      return filterListings([...dedup.values()], {
        keyword: target.keyword, cityName, minPriceYuan, excludeKeywords, carCategoryId,
      })
    }

    await fetchPage(1)
    let filtered = dedupFilter()
    // 默认只扫第 1 页；高供给车型（过滤后 >= 10 台）才补第 2 页，低供给车型不浪费请求
    if (adaptivePages && pages === 1 && filtered.length >= 10 && pageInfo.hasNextPage !== false) {
      await fetchPage(2)
      filtered = dedupFilter()
    } else {
      for (let page = 2; page <= pages; page++) {
        if (pageInfo.hasNextPage === false) break
        await fetchPage(page)
      }
      filtered = dedupFilter()
    }
    return { rawCount, filtered, pageInfo }
  }

  async function scan(trigger = 'timer', { targetId = null, suppressNotify = false } = {}) {
    if (running) return { ok: false, busy: true, message: '上一轮扫描还没结束' }
    running = true
    const startedAt = localIso()
    try {
      const state = await loadState(statePath)
      const nowMs = Date.now()
      const targets = (await loadTargets()).filter((t) => !targetId || t.id === targetId)
      if (!targets.length) return { ok: false, message: '没有启用的 target', targets: 0 }

      const results = []
      let detailBudget = enrichMax
      for (const target of targets) {
        const prev = state.targets?.[target.id] ?? null
        try {
          const { rawCount, filtered, pageInfo } = await fetchTargetListings(target)
          const agg = aggregateListings({
            target,
            listings: filtered,
            rawCount,
            pageInfo,
            cityName,
            referenceOfficialLow: target.referenceOfficialLow ?? 0,
            previous: prev?.last ?? null,
          })
          if (agg.sampleCount === 0) throw new Error('没有过滤出有效车源（可能触发风控/关键词无结果）')
          if (agg.sampleCount < 10) agg.status = 'partial'

          // 换数据源（瓜子 → 闲鱼）后第一次扫描按“基线”处理，避免把全量当新上架刷屏
          const firstRun = !prev?.initialized || prev?.last?.source !== 'xianyu'
          const seen = firstRun ? {} : (prev?.seen ?? {})
          const newListings = firstRun ? [] : agg.cityListings.filter((l) => !seen[l.listingId])
          const priceDrops = firstRun ? [] : agg.cityListings
            .filter((l) => seen[l.listingId]?.lastPrice && l.priceYuan != null && seen[l.listingId].lastPrice - l.priceYuan >= (config.priceDropAbs ?? 1000))
            .map((l) => ({ listing: l, oldPrice: seen[l.listingId].lastPrice, newPrice: l.priceYuan }))
          const dropIds = new Set(priceDrops.map((d) => d.listing.listingId))
          const nowIso = localIso()

          // 价格历史：首次价 / 上次价 / 历史最低 / 累计降价次数
          for (const l of agg.cityListings) {
            const old = seen[l.listingId]
            l.history = {
              firstPrice: old?.firstPrice ?? old?.lastPrice ?? l.priceYuan,
              previousPrice: old?.lastPrice ?? null,
              minPrice: Math.min(old?.minPrice ?? l.priceYuan, l.priceYuan),
              dropCount: (old?.dropCount ?? 0) + (dropIds.has(l.listingId) ? 1 : 0),
              firstSeen: old?.firstSeen ?? null,
            }
          }

          // 只对“本轮新上架 / 降价”补详情，控制请求量；详情失败不影响整轮扫描
          const changed = [...newListings, ...priceDrops.map((d) => d.listing)]
          const uniq = [...new Map(changed.map((l) => [l.listingId, l])).values()]
          const take = uniq.slice(0, Math.max(0, detailBudget))
          if (take.length) {
            const enriched = await enrichListings(take, { median: agg.price?.median, max: take.length })
            detailBudget -= take.length
            if (enriched) log.info?.('detail enriched %d/%d for %s', enriched, take.length, target.name)
          }

          // 更新 seen：保留 firstSeen，刷新 lastSeen/firstPrice/minPrice/dropCount
          const nextSeen = { ...seen }
          for (const l of agg.cityListings) {
            const old = seen[l.listingId]
            nextSeen[l.listingId] = {
              firstSeen: old?.firstSeen ?? nowIso,
              lastSeen: nowIso,
              lastPrice: l.priceYuan,
              firstPrice: old?.firstPrice ?? l.priceYuan,
              minPrice: Math.min(old?.minPrice ?? l.priceYuan, l.priceYuan),
              dropCount: (old?.dropCount ?? 0) + (dropIds.has(l.listingId) ? 1 : 0),
            }
          }
          state.targets[target.id] = {
            initialized: true,
            lastScanAt: nowIso,
            last: { ...agg, cityListings: undefined },
            currentIds: agg.cityListings.map((l) => l.listingId),
            seen: pruneSeen(nextSeen, nowMs, 60),
          }
          results.push({ target, agg, newListings, priceDrops, firstRun, status: agg.status })
          log.info?.('scan %s: raw=%d sample=%d new=%d drop=%d', target.name, rawCount, agg.sampleCount, newListings.length, priceDrops.length)
        } catch (err) {
          const message = err?.message ?? String(err)
          log.warn?.('scan %s failed: %s', target.name, message)
          results.push({
            target,
            firstRun: false,
            newListings: [],
            priceDrops: [],
            status: 'failed',
            error: message,
            agg: {
              targetId: target.id, seriesName: target.name, keyword: target.keyword, source: 'xianyu',
              city: cityName, url: searchUrl(target.keyword),
              status: 'failed', sampleCount: 0, rawCount: 0, outOfCityCount: 0,
              price: {}, mileage: {}, licenseYear: {}, discount: {}, reference: {}, topTags: [], compare: {}, cityListings: [],
            },
          })
        }
      }

      const messages = suppressNotify ? [] : buildMessages(results, {
        cityName,
        maxPush: config.maxPushPerRun ?? 8,
        notifyOnFirstRun: config.notifyOnFirstRun !== false,
        dashboardUrl: dashboard?.url || '',
      })
      const notifyResults = []
      for (const msg of messages) notifyResults.push({ targetId: msg.targetId, kind: msg.kind, result: await notifier.send(msg) })

      const scannedIds = new Set(results.map((r) => r.target.id))
      const previous = await readLatest()
      const latestTargets = [
        ...(previous?.targets ?? []).filter((t) => !scannedIds.has(t.targetId)),
        ...results.map((r) => ({
          ...r.agg,
          cityListings: undefined,
          newListings: r.newListings,
          priceDrops: r.priceDrops,
          firstRun: r.firstRun,
          status: r.status,
          error: r.error,
        })),
      ]
      const allListings = [
        ...(previous?.listings ?? []).filter((l) => !scannedIds.has(l.targetId)),
        ...results.flatMap((r) => r.agg.cityListings ?? []),
      ]
      const changes = results.flatMap((r) => [
        ...r.newListings.map((listing) => ({ at: startedAt, type: 'new', targetId: r.target.id, seriesName: r.target.name, listing })),
        ...r.priceDrops.map((drop) => ({ at: startedAt, type: 'drop', targetId: r.target.id, seriesName: r.target.name, oldPrice: drop.oldPrice, listing: drop.listing })),
      ])
      const historyFloor = Date.now() - 7 * 24 * 3600_000
      const latest = {
        generatedAt: startedAt,
        trigger,
        source: 'xianyu',
        city: cityName,
        targets: latestTargets,
        listings: allListings,
        changes: [...(previous?.changes ?? []), ...changes].filter((c) => Date.parse(c.at) >= historyFloor).slice(-500),
      }

      await mkdir(reportDir, { recursive: true })
      const latestPath = path.join(reportDir, 'latest.json')
      const okTargets = results.filter((r) => r.status !== 'failed').length
      const summary = {
        ok: okTargets > 0,
        trigger,
        scannedAt: startedAt,
        targets: results.length,
        okTargets,
        failedTargets: results.length - okTargets,
        newListings: results.reduce((n, r) => n + r.newListings.length, 0),
        priceDrops: results.reduce((n, r) => n + r.priceDrops.length, 0),
        messages: messages.length,
        notify: notifyResults,
        errors: results.filter((r) => r.status === 'failed').map((r) => ({ targetId: r.target.id, name: r.target.name, error: r.error })),
        report: null,
      }

      // 全部车型失败：保留上一份看板/报表，避免一次网络波动把页面清空；同时发一条运维告警
      if (okTargets === 0) {
        summary.skippedOutput = true
        const reasons = results.map((r) => `${r.target.name}：${r.error || '扫描失败'}`).join('\n')
        if (!suppressNotify) {
          summary.alerted = await notifier.send({
            text: `【闲鱼监控】本轮 ${results.length} 个车型全部扫描失败\n${reasons}\n\n上一份看板/报表保持不变；请检查网络、闲鱼风控或 Cookie 配置。`,
          })
          summary.messages += 1
        }
        await appendFile(path.join(reportDir, 'scan-log.jsonl'), JSON.stringify(summary) + '\n', 'utf8')
        state.lastRun = summary
        await saveState(statePath, state)
        log.warn?.('scan aborted: all %d targets failed, previous report kept', results.length)
        return summary
      }

      await writeAtomic(latestPath, JSON.stringify(latest, null, 2))
      await writeAtomic(path.join(reportDir, 'latest.csv'), '\ufeff' + toAggCsv(latestTargets))
      await writeAtomic(path.join(reportDir, 'listings-latest.csv'), '\ufeff' + toListingCsv(allListings))

      // 先写扫描日志，再生成报表，保证报表的「扫描日志」sheet 含本次运行
      await appendFile(path.join(reportDir, 'scan-log.jsonl'), JSON.stringify(summary) + '\n', 'utf8')

      // HTML 看板：不依赖 Python，扫描后直接重写（每 2 小时刷新一次）
      if (config.report?.html !== false) {
        try {
          summary.html = await writeHtmlReport({
            latestPath,
            scanLogPath: path.join(reportDir, 'scan-log.jsonl'),
            outPath: path.join(reportDir, REPORT_NAME),
            intervalHours: config.scanIntervalHours ?? 2,
          })
          log.info?.('dashboard written: %s', summary.html)
        } catch (err) {
          log.warn?.('dashboard failed: %s', err.message)
        }
      }

      if (config.report?.enabled !== false) {
        try {
          const report = generateReport({
            pythonPath: config.report?.pythonPath || 'python3',
            scriptPath: reportScriptPath,
            latestPath,
            outDir: reportDir,
          })
          summary.report = report.path
        } catch (err) {
          log.warn?.('report failed: %s', err.message)
        }
      }
      state.lastRun = summary
      await saveState(statePath, state)
      log.info?.('scan done: ok=%d failed=%d new=%d drop=%d msg=%d', summary.okTargets, summary.failedTargets, summary.newListings, summary.priceDrops, summary.messages)
      return summary
    } finally {
      running = false
    }
  }

  const queryCache = new Map()
  const QUERY_TTL_MS = 5 * 60_000

  /** 同一关键词 5 分钟复用结果；并发查询共享 Promise，刷新可显式绕过缓存。 */
  // 独立 HTML 文件把缩略图内嵌成 data URI：在企微文件/本地打开时也能显示
  const inlineImageCache = new Map()
  async function inlineImages(html, listings) {
    const urls = [...new Set((listings ?? []).map((l) => l?.pictureUrl).filter((u) => /^https?:\/\//.test(String(u))))].slice(0, 20)
    if (!urls.length) return html
    const fetchOne = async (url) => {
      const hit = inlineImageCache.get(url)
      if (hit && Date.now() - hit.at < 60 * 60_000) return hit.uri
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': DEFAULT_UA } })
        if (!res.ok) return null
        const type = res.headers.get('content-type') || 'image/jpeg'
        const buf = Buffer.from(await res.arrayBuffer())
        const uri = `data:${type};base64,${buf.toString('base64')}`
        inlineImageCache.set(url, { at: Date.now(), uri })
        return uri
      } catch { return null }
    }
    for (let i = 0; i < urls.length; i += 3) {
      const batch = urls.slice(i, i + 3)
      const uris = await Promise.all(batch.map(fetchOne))
      for (let j = 0; j < batch.length; j++) {
        if (uris[j]) html = html.split(`src="${batch[j]}"`).join(`src="${uris[j]}"`)
      }
    }
    return html
  }

  /** 生成单次查询的独立 HTML 文件（不依赖看板/隧道，可直接发企微文件）。 */
  async function writeQueryFile({ keyword, agg = {}, listings = [] } = {}) {
    const dir = path.join(reportDir, 'queries')
    await mkdir(dir, { recursive: true })
    const safe = String(keyword).replace(/[^\w\u4e00-\u9fa5-]+/g, '').slice(0, 30) || 'query'
    const stamp = localIso().slice(0, 19).replace('T', '-').replace(/:/g, '')
    const file = path.join(dir, `${safe}-西安在售-${stamp}.html`)
    const html = await inlineImages(renderQueryPage({ keyword, agg, listings, standalone: true }), listings)
    await writeAtomic(file, html)
    return file
  }

  async function sendFile(filePath) {
    return notifier.sendFile(filePath, path.basename(filePath))
  }

  async function lookup(keyword, { name = keyword, enrich = true, force = false } = {}) {
    const cleanKeyword = String(keyword ?? '').trim()
    if (!cleanKeyword || cleanKeyword.length > 40) throw new Error('车型关键词不能为空且不能超过 40 字')
    const key = cleanKeyword.toLowerCase()
    const hit = queryCache.get(key)
    if (!force && hit && Date.now() - hit.at < QUERY_TTL_MS) return hit.promise
    const promise = (async () => {
      const res = await xianyu.search(cleanKeyword, 1, { province, city: cityName })
      const listings = filterListings(res.listings, { keyword: cleanKeyword, cityName, minPriceYuan, excludeKeywords, carCategoryId })
      const agg = aggregateListings({
        target: { id: cleanKeyword, name, keyword: cleanKeyword },
        listings,
        rawCount: res.rawCount,
        pageInfo: res.pageInfo,
        cityName,
      })
      if (enrich && enrichDetails && queryEnrichMax > 0) {
        const cheapest = [...agg.cityListings].sort((a, b) => Number(a.priceYuan) - Number(b.priceYuan))
        await enrichListings(cheapest, { median: agg.price?.median, max: queryEnrichMax })
      }
      return { agg, listings: agg.cityListings, keyword: cleanKeyword, cachedAt: new Date().toISOString() }
    })()
    queryCache.set(key, { at: Date.now(), promise })
    try {
      return await promise
    } catch (err) {
      if (queryCache.get(key)?.promise === promise) queryCache.delete(key)
      throw err
    }
  }

  async function status() {
    const state = await loadState(statePath)
    const allTargets = (await loadTargets({ includeDisabled: true })).map((t) => {
      const s = state.targets?.[t.id]
      const last = s?.last
      return {
        id: t.id,
        name: t.name,
        keyword: t.keyword,
        url: searchUrl(t.keyword),
        enabled: t.enabled !== false,
        initialized: Boolean(s?.initialized),
        lastScanAt: s?.lastScanAt ?? null,
        sampleCount: last?.sampleCount ?? null,
        medianPrice: last?.price?.median ?? null,
        medianPriceWan: last?.price?.median != null ? (last.price.median / 10000).toFixed(2) : null,
        seenCount: s?.seen ? Object.keys(s.seen).length : 0,
      }
    })
    return {
      source: 'xianyu',
      dashboard,
      statePath,
      reportDir,
      htmlPath: path.join(reportDir, REPORT_NAME),
      htmlEnabled: config.report?.html !== false,
      webhooks: { wecom: Boolean(config.notify?.wecomWebhook), feishu: Boolean(config.notify?.feishuWebhook) },
      targets: allTargets.filter((t) => t.enabled),
      allTargets,
      lastRun: state.lastRun ?? null,
    }
  }

  async function generateNow() {
    const latestPath = path.join(reportDir, 'latest.json')
    let html = null
    if (config.report?.html !== false) {
      try {
        html = await writeHtmlReport({
          latestPath,
          scanLogPath: path.join(reportDir, 'scan-log.jsonl'),
          outPath: path.join(reportDir, REPORT_NAME),
          intervalHours: config.scanIntervalHours ?? 2,
        })
      } catch (err) {
        log.warn?.('dashboard failed: %s', err.message)
      }
    }
    if (config.report?.enabled === false) return { html }
    const report = generateReport({
      pythonPath: config.report?.pythonPath || 'python3',
      scriptPath: reportScriptPath,
      latestPath,
      outDir: reportDir,
    })
    return { ...report, html }
  }

  async function readLatest() {
    try {
      return JSON.parse(await readFile(path.join(reportDir, 'latest.json'), 'utf8'))
    } catch {
      return null
    }
  }

  async function addTargets(candidates) {
    return addWatchTargets(statePath, candidates, config.targets ?? [])
  }

  async function removeTarget(id) {
    return removeWatchTarget(statePath, id, config.targets ?? [])
  }

  async function setTargetEnabled(id, enabled) {
    const target = (await loadTargets({ includeDisabled: true })).find((t) => t.id === id)
    if (!target) return false
    if (enabled) {
      const result = await addWatchTargets(statePath, [{ ...target, enabled: true }], config.targets ?? [])
      return result.added.length > 0 || target.enabled === false
    }
    return removeWatchTarget(statePath, id, config.targets ?? [])
  }

  async function pending(key) {
    return getPending(statePath, key)
  }

  async function setPendingEntry(key, value) {
    return setPending(statePath, key, value)
  }

  async function clearPendingEntry(key) {
    return clearPending(statePath, key)
  }

  async function sendCards(cards) {
    if (!cards.length) return []
    const results = []
    for (const card of cards) results.push(await notifier.send({ text: '', card }))
    return results
  }

  return { scan, lookup, status, generateNow, readLatest, sendCards, writeQueryFile, sendFile, loadTargets, addTargets, removeTarget, setTargetEnabled, pending, setPendingEntry, clearPendingEntry, setDashboard }
}

function toAggCsv(targets) {
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`
  const header = '车型,关键词,样本数,过滤剔除,结果总数,最低(万),P25(万),中位(万),P75(万),最高(万),中位里程(km),准新车占比,参考折价率,本次新增,本次降价,状态'
  const rows = targets.map((t) => [
    t.seriesName, t.keyword, t.sampleCount, t.outOfCityCount, t.pageTotal,
    wan(t.price?.min), wan(t.price?.p25), wan(t.price?.median), wan(t.price?.p75), wan(t.price?.max),
    t.mileage?.medianKm, t.mileage?.nearlyNewRatio,
    t.reference?.discountVsOfficialLow != null ? (t.reference.discountVsOfficialLow * 100).toFixed(2) + '%' : '',
    t.newListings?.length ?? 0, t.priceDrops?.length ?? 0, t.status,
  ].map(esc).join(','))
  return [header, ...rows].join('\n') + '\n'
}

function wan(v) { return v == null ? '' : (v / 10000).toFixed(2) }

function toListingCsv(listings) {
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`
  const header = '车型,listing_id,标题,年款,配置,上牌年,里程(km),地区,报价(万),降幅(万),标签,详情链接'
  const rows = listings.map((l) => [
    l.seriesName, l.listingId, l.title, l.modelYear, l.trim, l.licenseYear, l.mileageKm, l.area || l.cityDesc,
    wan(l.priceYuan), wan(l.priceDropYuan), (l.tags ?? []).join('/'), l.detailUrl,
  ].map(esc).join(','))
  return [header, ...rows].join('\n') + '\n'
}
