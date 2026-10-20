import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { aggregateListings, fetchGuaziPage, normalizeListing, parseGuaziHtml } from './guazi.js'
import { loadState, pruneSeen, saveState } from './state.js'
import { buildMessages, formatWan, Notifier } from './notify.js'
import { generateReport } from './report.js'
import { addWatchTargets, clearPending, getPending, loadWatchlist, removeWatchTarget, setPending } from './runtime-store.js'

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function localIso(d = new Date()) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d)
  return s.replace(' ', 'T') + '+08:00'
}

export function createService({ config, statePath, reportDir, reportScriptPath, log = console }) {
  const notifier = new Notifier({
    wecomWebhook: config.notify?.wecomWebhook ?? '',
    feishuWebhook: config.notify?.feishuWebhook ?? '',
    feishuSecret: config.notify?.feishuSecret ?? '',
    timeoutMs: config.notify?.timeoutMs ?? 10000,
    log,
  })
  const minGapMs = config.fetch?.minGapMs ?? 2500
  const timeoutMs = config.fetch?.timeoutMs ?? 30000
  const userAgent = config.fetch?.userAgent || DEFAULT_UA
  let lastRequestAt = 0
  let running = false

  async function throttle() {
    const gap = minGapMs - (Date.now() - lastRequestAt)
    if (gap > 0) await sleep(gap)
    lastRequestAt = Date.now()
  }

  async function fetchHtml(url, retries = 1) {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await throttle()
        const res = await fetch(url, {
          headers: {
            'user-agent': userAgent,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9',
            referer: 'https://www.guazi.com/',
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.text()
      } catch (err) {
        lastErr = err
        if (attempt < retries) await sleep(1200 * 2 ** attempt)
      }
    }
    throw new Error(`GET ${url} failed: ${lastErr?.message ?? lastErr}`)
  }

  async function loadTargets() {
    const base = (config.targets ?? []).filter((t) => t.enabled !== false)
    const dynamic = await loadWatchlist(statePath)
    const map = new Map(base.map((t) => [t.id, t]))
    for (const t of dynamic) {
      if (t.enabled !== false && !map.has(t.id)) map.set(t.id, t)
    }
    return [...map.values()]
  }

  async function scan(trigger = 'timer', { targetId = null } = {}) {
    if (running) return { ok: false, busy: true, message: '上一轮扫描还没结束' }
    running = true
    const startedAt = localIso()
    try {
      const state = await loadState(statePath)
      const nowMs = Date.now()
      const targets = (await loadTargets()).filter((t) => !targetId || t.id === targetId)
      if (!targets.length) return { ok: false, message: '没有启用的 target', targets: 0 }

      const results = []
      for (const target of targets) {
        const prev = state.targets?.[target.id] ?? null
        try {
          await throttle()
          const html = await fetchGuaziPage(target.usedCarUrl, { timeoutMs })
          const { init } = parseGuaziHtml(html)
          const listings = (init.carList ?? []).map(normalizeListing).filter((l) => l.listingId)
          const agg = aggregateListings({
            target,
            init,
            listings,
            html,
            cityName: config.cityName || '西安',
            referenceOfficialLow: target.referenceOfficialLow ?? 0,
            previous: prev?.last ?? null,
          })
          if (agg.sampleCount === 0) throw new Error('样本量为 0（页面可能改版/被风控）')
          if (agg.sampleCount < 10) agg.status = 'partial'

          const firstRun = !prev?.initialized
          const seen = prev?.seen ?? {}
          const newListings = firstRun ? [] : agg.cityListings.filter((l) => !seen[l.listingId])
          const priceDrops = firstRun ? [] : agg.cityListings
            .filter((l) => seen[l.listingId]?.lastPrice && l.priceYuan != null && seen[l.listingId].lastPrice - l.priceYuan >= (config.priceDropAbs ?? 1000))
            .map((l) => ({ listing: l, oldPrice: seen[l.listingId].lastPrice, newPrice: l.priceYuan }))

          // 更新 seen：保留 firstSeen，刷新 lastSeen/lastPrice；清掉长期不出现的
          const nextSeen = { ...seen }
          const nowIso = localIso()
          for (const l of agg.cityListings) {
            nextSeen[l.listingId] = {
              firstSeen: seen[l.listingId]?.firstSeen ?? nowIso,
              lastSeen: nowIso,
              lastPrice: l.priceYuan,
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
          log.info?.('scan %s: sample=%d new=%d drop=%d', target.name, agg.sampleCount, newListings.length, priceDrops.length)
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
              targetId: target.id, seriesName: target.name, city: config.cityName || '西安', url: target.usedCarUrl,
              status: 'failed', sampleCount: 0, rawCount: 0, outOfCityCount: 0,
              price: {}, mileage: {}, licenseYear: {}, discount: {}, reference: {}, topTags: [], compare: {}, cityListings: [],
            },
          })
        }
      }

      const messages = buildMessages(results, {
        cityName: config.cityName || '西安',
        maxPush: config.maxPushPerRun ?? 8,
        notifyOnFirstRun: config.notifyOnFirstRun !== false,
      })
      const notifyResults = []
      for (const msg of messages) notifyResults.push({ targetId: msg.targetId, kind: msg.kind, result: await notifier.send(msg) })

      const latestTargets = results.map((r) => ({
        ...r.agg,
        cityListings: undefined,
        newListings: r.newListings,
        priceDrops: r.priceDrops,
        firstRun: r.firstRun,
        status: r.status,
        error: r.error,
      }))
      const allListings = results.flatMap((r) => r.agg.cityListings ?? [])
      const latest = {
        generatedAt: startedAt,
        trigger,
        city: config.cityName || '西安',
        targets: latestTargets,
        listings: allListings,
      }

      await mkdir(reportDir, { recursive: true })
      const latestPath = path.join(reportDir, 'latest.json')
      await writeFile(latestPath, JSON.stringify(latest, null, 2), 'utf8')
      await writeFile(path.join(reportDir, 'latest.csv'), '\ufeff' + toAggCsv(latestTargets), 'utf8')
      await writeFile(path.join(reportDir, 'listings-latest.csv'), '\ufeff' + toListingCsv(allListings), 'utf8')

      const summary = {
        ok: results.some((r) => r.status !== 'failed'),
        trigger,
        scannedAt: startedAt,
        targets: results.length,
        okTargets: results.filter((r) => r.status !== 'failed').length,
        failedTargets: results.filter((r) => r.status === 'failed').length,
        newListings: results.reduce((n, r) => n + r.newListings.length, 0),
        priceDrops: results.reduce((n, r) => n + r.priceDrops.length, 0),
        messages: messages.length,
        notify: notifyResults,
        report: null,
      }
      // 先写扫描日志，再生成报表，保证报表的「扫描日志」sheet 含本次运行
      await appendFile(path.join(reportDir, 'scan-log.jsonl'), JSON.stringify(summary) + '\n', 'utf8')

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

  async function status() {
    const state = await loadState(statePath)
    return {
      statePath,
      reportDir,
      webhooks: { wecom: Boolean(config.notify?.wecomWebhook), feishu: Boolean(config.notify?.feishuWebhook) },
      targets: (await loadTargets()).map((t) => {
        const s = state.targets?.[t.id]
        const last = s?.last
        return {
          id: t.id,
          name: t.name,
          url: t.usedCarUrl,
          enabled: t.enabled !== false,
          initialized: Boolean(s?.initialized),
          lastScanAt: s?.lastScanAt ?? null,
          sampleCount: last?.sampleCount ?? null,
          medianPrice: last?.price?.median ?? null,
          medianPriceWan: last?.price?.median != null ? (last.price.median / 10000).toFixed(2) : null,
          seenCount: s?.seen ? Object.keys(s.seen).length : 0,
        }
      }),
      lastRun: state.lastRun ?? null,
    }
  }

  async function generateNow() {
    const latestPath = path.join(reportDir, 'latest.json')
    const report = generateReport({
      pythonPath: config.report?.pythonPath || 'python3',
      scriptPath: reportScriptPath,
      latestPath,
      outDir: reportDir,
    })
    return report
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
    return removeWatchTarget(statePath, id)
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

  return { scan, status, generateNow, readLatest, sendCards, loadTargets, addTargets, removeTarget, pending, setPendingEntry, clearPendingEntry }
}

function toAggCsv(targets) {
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`
  const header = '车型,样本数,外市剔除,页面total,共找到,最低(万),P25(万),中位(万),P75(万),最高(万),中位里程(km),准新车占比,参考折价率,本次新增,本次降价,状态'
  const rows = targets.map((t) => [
    t.seriesName, t.sampleCount, t.outOfCityCount, t.pageTotal, t.pageFound,
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
  const header = '车型,listing_id,标题,年款,配置,上牌年,里程(km),城市,挂牌价(万),累计降幅(万),标签,详情链接'
  const rows = listings.map((l) => [
    l.seriesName, l.listingId, l.title, l.modelYear, l.trim, l.licenseYear, l.mileageKm, l.cityDesc,
    wan(l.priceYuan), wan(l.priceDropYuan), (l.tags ?? []).join('/'), l.detailUrl,
  ].map(esc).join(','))
  return [header, ...rows].join('\n') + '\n'
}
