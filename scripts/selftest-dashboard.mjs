#!/usr/bin/env node
/** 缓存、历史、看板鉴权/管理与三视图离线验收。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

import { createService } from '../src/service.js'
import { startDashboardServer } from '../src/dashboard-server.js'
import { ensureDashboardToken, withDashboardToken } from '../src/dashboard-auth.js'
import { renderHtmlReport, renderQueryErrorPage } from '../src/html-report.js'

const silent = { info() {}, warn() {}, error() {} }
const cases = []
async function test(name, fn) {
  try { await fn(); cases.push({ name, ok: true }); console.log(`✓ ${name}`) }
  catch (err) { cases.push({ name, ok: false }); console.error(`✗ ${name}\n  ${err.stack ?? err}`) }
}
function listing(keyword, id, price = 180000) {
  return { listingId: id, targetId: keyword === '小米SU7' ? 'su7' : 'i6', seriesName: keyword, title: `${keyword} 2024款 测试车 ${id}`, priceYuan: price, area: '雁塔区', cityDesc: '西安', publishTime: Date.now(), categoryId: '127302001', modelYear: 2024, licenseYear: 2025, mileageKm: 12000, detailUrl: `https://www.goofish.com/item?id=${id}`, tags: [] }
}
function config(overrides = {}) {
  return {
    city: '西安', province: '陕西', minPriceYuan: 30000, carCategoryId: '127302001', excludeKeywords: [],
    targets: [{ id: 'su7', name: '小米SU7', keyword: '小米SU7', enabled: true }, { id: 'i6', name: '理想i6', keyword: '理想i6', enabled: true }],
    xianyu: { pages: 1, adaptivePages: false, enrichDetails: false, minGapMs: 0 },
    notify: {}, report: { enabled: false, html: true }, notifyOnFirstRun: false,
    ...overrides,
  }
}
function service(dir, client, overrides = {}) {
  return createService({ config: config(overrides), statePath: path.join(dir, 'state.json'), reportDir: path.join(dir, 'reports'), reportScriptPath: path.join(dir, 'unused.py'), log: silent, xianyuClient: client })
}

await test('同关键词 5 分钟缓存并合并并发，强制刷新才重新抓取', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-cache-'))
  let calls = 0
  const client = { async search() { calls += 1; await new Promise((r) => setTimeout(r, 15)); return { listings: [listing('小米SU7', 'cache-1')], rawCount: 1, pageInfo: { hasNextPage: false } } } }
  const svc = service(dir, client)
  const [a, b] = await Promise.all([svc.lookup('小米SU7'), svc.lookup('小米SU7')])
  assert.equal(a, b)
  await svc.lookup('小米SU7')
  assert.equal(calls, 1)
  await svc.lookup('小米SU7', { force: true })
  assert.equal(calls, 2)
  await assert.rejects(() => svc.lookup(''), /关键词/)
})

await test('变化历史跨轮保留 7 天，单车型扫描不清空其他车源', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-history-'))
  const map = new Map([['小米SU7', [listing('小米SU7', 'a1', 200000)]], ['理想i6', [listing('理想i6', 'b1')]]])
  const client = { async search(keyword) { return { listings: map.get(keyword), rawCount: 1, pageInfo: { hasNextPage: false } } } }
  const svc = service(dir, client)
  await svc.scan('baseline')
  map.get('小米SU7')[0].priceYuan = 198000
  map.get('小米SU7').push(listing('小米SU7', 'a2'))
  await svc.scan('second')
  let latest = await svc.readLatest()
  assert.equal(latest.changes.length, 2)
  latest.changes.push({ at: new Date(Date.now() - 8 * 86400000).toISOString(), type: 'new', listing: listing('小米SU7', 'expired') })
  await writeFile(path.join(dir, 'reports', 'latest.json'), JSON.stringify(latest))
  map.get('小米SU7').push(listing('小米SU7', 'a3'))
  await svc.scan('partial', { targetId: 'su7' })
  latest = await svc.readLatest()
  assert.equal(latest.targets.length, 2)
  assert.ok(latest.listings.some((l) => l.listingId === 'b1'), '单车型扫描必须保留另一车型')
  assert.ok(latest.changes.some((c) => c.listing.listingId === 'a2'))
  assert.ok(!latest.changes.some((c) => c.listing.listingId === 'expired'))
  assert.ok(latest.changes.every((c) => Date.parse(c.at) >= Date.now() - 7 * 86400000))
})

await test('手动扫描 suppressNotify 跳过固定 Webhook 和失败告警', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-notify-'))
  const map = new Map([['小米SU7', [listing('小米SU7', 'n1', 200000)]], ['理想i6', [listing('理想i6', 'n2')]]])
  const client = { fail: false, async search(keyword) { if (this.fail) throw new Error('offline'); return { listings: map.get(keyword), rawCount: 1, pageInfo: { hasNextPage: false } } } }
  const svc = service(dir, client, { notify: { wecomWebhook: 'https://example.invalid/webhook', timeoutMs: 100 } })
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('{"errcode":0}') }
  try {
    await svc.scan('baseline')
    map.get('小米SU7')[0].priceYuan = 198000
    const changed = await svc.scan('aibot', { suppressNotify: true })
    assert.equal(changed.priceDrops, 1)
    assert.equal(changed.messages, 0)
    client.fail = true
    const failed = await svc.scan('aibot', { suppressNotify: true })
    assert.equal(failed.ok, false)
    assert.equal(failed.messages, 0)
    assert.equal(calls, 0)
  } finally { globalThis.fetch = realFetch }
})

await test('看板令牌持久化并安全追加到现有 URL', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-token-'))
  const statePath = path.join(dir, 'nested', 'state.json')
  const token = await ensureDashboardToken(statePath)
  assert.match(token, /^[a-f0-9]{48}$/)
  assert.equal(await ensureDashboardToken(statePath), token)
  const url = new URL(withDashboardToken('https://cars.example.com/query?q=x', token))
  assert.equal(url.searchParams.get('q'), 'x')
  assert.equal(url.searchParams.get('token'), token)
})

await test('看板 API 全链路鉴权，新增/停用/恢复/删除真实监控', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-api-'))
  const client = { async search(keyword) { return { listings: [listing(keyword, `${keyword}-1`)], rawCount: 1, pageInfo: { hasNextPage: false } } } }
  const svc = service(dir, client)
  const htmlPath = path.join(dir, 'dash.html')
  await writeFile(htmlPath, '<!doctype html><title>看板</title>')
  const server = await startDashboardServer({
    filePath: htmlPath, jsonPath: path.join(dir, 'reports', 'latest.json'), port: 0, log: silent, token: 'test-token',
    queryHandler: (q) => svc.lookup(q),
    monitorHandler: {
      status: async () => (await svc.status()).allTargets,
      addTargets: (targets) => svc.addTargets(targets), removeTarget: (id) => svc.removeTarget(id),
      setTargetEnabled: (id, enabled) => svc.setTargetEnabled(id, enabled),
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  const post = (body, token = 'test-token') => fetch(`${base}/api/monitor?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await fetch(`${base}/`)).status, 401)
    assert.equal((await fetch(`${base}/latest.json`)).status, 401)
    assert.equal((await fetch(`${base}/query?q=x`)).status, 401)
    assert.equal((await post({ action: 'add', name: 'x', keyword: 'x' }, 'bad')).status, 401)
    const auth = await fetch(`${base}/api/dashboard`, { headers: { authorization: 'Bearer test-token' } })
    assert.equal(auth.status, 200)
    assert.equal((await auth.json()).monitors.length, 2)
    const added = await post({ action: 'add', name: '蔚来ES8', keyword: '蔚来ES8' })
    assert.equal(added.status, 200)
    assert.equal((await added.json()).monitors.length, 3)
    const disabled = await post({ action: 'toggle', id: 'su7', enabled: false })
    assert.equal(disabled.status, 200)
    assert.equal((await disabled.json()).monitors.find((t) => t.id === 'su7').enabled, false)
    assert.equal((await svc.loadTargets()).some((t) => t.id === 'su7'), false)
    const enabled = await post({ action: 'toggle', id: 'su7', enabled: true })
    assert.equal(enabled.status, 200)
    assert.equal((await svc.loadTargets()).some((t) => t.id === 'su7'), true)
    assert.equal((await post({ action: 'hack', id: 'su7' })).status, 400)
    assert.equal((await post({ action: 'add', name: '', keyword: 'x' })).status, 400)
    assert.equal((await post({ action: 'toggle', id: 'su7', enabled: 'yes' })).status, 400)
    const dynamic = (await svc.status()).allTargets.find((t) => t.keyword === '蔚来ES8')
    assert.equal((await post({ action: 'remove', id: dynamic.id })).status, 200)
    assert.equal((await svc.status()).allTargets.some((t) => t.id === dynamic.id), false)
  } finally { await server.close() }
})

await test('三视图包含真实筛选/历史/监控动作，内嵌 JS 语法有效', async () => {
  const latest = { generatedAt: new Date().toISOString(), city: '西安', targets: [{ targetId: 'su7', seriesName: '小米SU7', sampleCount: 1, price: { median: 180000 }, newListings: [listing('小米SU7', 'v1')], priceDrops: [] }], listings: [listing('小米SU7', 'v1')], changes: [] }
  const html = renderHtmlReport({ latest })
  for (const text of ['动态', '全部车源', '监控', '24 小时', '7 天', 'filter-model', 'filter-price', 'filter-km', 'filter-sort', '/api/monitor', '/api/dashboard', 'add-monitor']) assert.ok(html.includes(text), `缺少 ${text}`)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 2)
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]))
  assert.ok(!html.includes('</script><script>alert'))
  const error = renderQueryErrorPage({ keyword: '理想L9', message: '网络失败' })
  assert.ok(error.includes('重新查询'))
  assert.ok(error.includes('闲鱼搜索'))
  assert.ok(error.includes('网络失败'))
})

const failed = cases.filter((c) => !c.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
if (failed.length) process.exitCode = 1
