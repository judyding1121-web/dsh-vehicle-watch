#!/usr/bin/env node
/**
 * 服务层/看板服务的离线自测（不访问外网）：
 *  1) 正常扫描：写 latest.json / HTML / CSV，目标全部成功
 *  2) 第二轮：新增车源 / 降价检测
 *  3) 全部失败：保留上一份看板与 latest.json（不被清空），发运维告警
 *  4) 部分失败：成功车型照常出数据，失败车型在最新数据里标记 failed
 *  5) 看板 HTTP 服务：/、/latest.json、404、端口 0 自动分配
 *  6) 闲鱼客户端请求队列：并发调用被串行化（避免风控/令牌竞争）
 *
 * 运行：node scripts/selftest-service.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createService } from '../src/service.js'
import { createXianyuClient } from '../src/xianyu.js'
import { dashboardUrls, startDashboardServer } from '../src/dashboard-server.js'
import { extractQuickTunnelUrl } from '../src/dashboard-tunnel.js'

const silent = { info() {}, warn() {}, error() {} }
const cases = []
async function test(name, fn) {
  try {
    await fn()
    cases.push({ name, ok: true })
    console.log(`✓ ${name}`)
  } catch (err) {
    cases.push({ name, ok: false, err })
    console.error(`✗ ${name}\n  ${err.err ?? err.message}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function listing(keyword, id, price, extra = {}) {
  return {
    listingId: id,
    title: `${keyword} 2024款 测试车 ${id}`,
    priceYuan: price,
    area: '雁塔区',
    cityDesc: '西安',
    publishTime: Date.now() - 3600_000,
    seller: '测试卖家',
    categoryId: '127302001',
    wantCount: 1,
    tags: ['1天内上新'],
    modelYear: 2024,
    trim: 'Pro',
    licenseYear: 2025,
    mileageKm: 5000,
    detailUrl: `https://www.goofish.com/item?id=${id}`,
    priceDropYuan: null,
    ...extra,
  }
}

function makeFakeClient(map) {
  return {
    failAll: false,
    failKeywords: new Set(),
    calls: [],
    map,
    async search(keyword) {
      this.calls.push(keyword)
      if (this.failAll) throw new Error('RGV587_ERROR::SM::被挤爆啦')
      if (this.failKeywords.has(keyword)) throw new Error('RGV587_ERROR::SM::被挤爆啦')
      return { listings: this.map.get(keyword) ?? [], rawCount: 30, pageInfo: { page: 1, total: 100, hasNextPage: false } }
    },
  }
}

function baseConfig(overrides = {}) {
  return {
    city: '西安',
    province: '陕西',
    minPriceYuan: 30000,
    carCategoryId: '127302001',
    excludeKeywords: [],
    scanIntervalHours: 2,
    startupDelaySec: 30,
    maxPushPerRun: 8,
    priceDropAbs: 1000,
    notifyOnFirstRun: true,
    targets: [
      { id: 'xiaomi-su7', name: '小米SU7', keyword: '小米SU7', enabled: true },
      { id: 'lixiang-i6', name: '理想i6', keyword: '理想i6', enabled: true },
    ],
    xianyu: { cookie: '', pages: 1, minGapMs: 0, timeoutMs: 2000 },
    notify: {},
    report: { enabled: false, html: true, dir: '' },
    ...overrides,
  }
}

async function makeService(dir, client) {
  return createService({
    config: baseConfig(),
    statePath: path.join(dir, 'state.json'),
    reportDir: path.join(dir, 'reports'),
    reportScriptPath: path.join(dir, 'make_report.py'),
    log: silent,
    xianyuClient: client,
  })
}

await test('正常扫描：写 latest.json / HTML / CSV，目标全部成功', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-svc-'))
  const client = makeFakeClient(new Map([
    ['小米SU7', [listing('小米SU7', 'a1', 200000), listing('小米SU7', 'a2', 205000), listing('小米SU7', 'a3', 210000)]],
    ['理想i6', [listing('理想i6', 'b1', 230000), listing('理想i6', 'b2', 235000), listing('理想i6', 'b3', 240000)]],
  ]))
  const svc = await makeService(dir, client)
  const summary = await svc.scan('test')
  assert.equal(summary.ok, true)
  assert.equal(summary.okTargets, 2)
  assert.equal(summary.failedTargets, 0)
  assert.ok(summary.html && summary.html.endsWith('二手车监控-最新.html'))

  const reportDir = path.join(dir, 'reports')
  const latest = JSON.parse(await readFile(path.join(reportDir, 'latest.json'), 'utf8'))
  assert.equal(latest.targets.length, 2)
  assert.equal(latest.listings.length, 6)
  const html = await readFile(summary.html, 'utf8')
  assert.ok(html.includes('本轮新上架'))
  assert.ok(html.includes('小米SU7'))
  assert.ok(html.includes('https://www.goofish.com/item?id='))
  assert.ok(!html.includes('undefined</'))

  const files = await readdir(reportDir)
  assert.ok(!files.some((f) => f.includes('.tmp-')), '不应残留临时文件')

  const looked = await svc.lookup('小米SU7', { name: '小米SU7' })
  assert.equal(looked.agg.sampleCount, 3)
})

await test('第二轮：新增车源 / 降价检测', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-svc-'))
  const client = makeFakeClient(new Map([
    ['小米SU7', [listing('小米SU7', 'a1', 200000), listing('小米SU7', 'a2', 205000)]],
    ['理想i6', [listing('理想i6', 'b1', 230000)]],
  ]))
  const svc = await makeService(dir, client)
  await svc.scan('baseline')

  client.map.get('小米SU7')[0].priceYuan = 198000
  client.map.get('小米SU7').push(listing('小米SU7', 'a4', 180000))
  const second = await svc.scan('test')
  assert.equal(second.newListings, 1)
  assert.equal(second.priceDrops, 1)

  const latest = JSON.parse(await readFile(path.join(dir, 'reports', 'latest.json'), 'utf8'))
  const su7 = latest.targets.find((t) => t.targetId === 'xiaomi-su7')
  assert.equal(su7.newListings.length, 1)
  assert.equal(su7.newListings[0].listingId, 'a4')
  assert.equal(su7.priceDrops.length, 1)
  assert.equal(su7.priceDrops[0].oldPrice, 200000)
  assert.equal(su7.priceDrops[0].newPrice, 198000)
})

await test('全部失败：保留上一份看板与 latest.json，不写空数据', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-svc-'))
  const client = makeFakeClient(new Map([
    ['小米SU7', [listing('小米SU7', 'a1', 200000)]],
    ['理想i6', [listing('理想i6', 'b1', 230000)]],
  ]))
  const svc = await makeService(dir, client)
  const first = await svc.scan('baseline')
  const reportDir = path.join(dir, 'reports')
  const latestBefore = await readFile(path.join(reportDir, 'latest.json'), 'utf8')
  const htmlBefore = await readFile(first.html, 'utf8')

  client.failAll = true
  const summary = await svc.scan('timer')
  assert.equal(summary.ok, false)
  assert.equal(summary.skippedOutput, true)
  assert.equal(summary.okTargets, 0)
  assert.equal(summary.messages, 1, '全部失败时应发一条运维告警')
  assert.equal(summary.errors?.length, 2, '应记录每个失败车型的原因')
  assert.ok(summary.errors.every((e) => e.error.includes('RGV587')))

  assert.equal(await readFile(path.join(reportDir, 'latest.json'), 'utf8'), latestBefore)
  assert.equal(await readFile(first.html, 'utf8'), htmlBefore)
})

await test('部分失败：成功车型照常出数据，失败车型标记 failed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-svc-'))
  const client = makeFakeClient(new Map([
    ['小米SU7', [listing('小米SU7', 'a1', 200000), listing('小米SU7', 'a2', 205000)]],
    ['理想i6', [listing('理想i6', 'b1', 230000)]],
  ]))
  const svc = await makeService(dir, client)
  await svc.scan('baseline')

  client.failKeywords.add('理想i6')
  const summary = await svc.scan('timer')
  assert.equal(summary.ok, true)
  assert.equal(summary.failedTargets, 1)

  const latest = JSON.parse(await readFile(path.join(dir, 'reports', 'latest.json'), 'utf8'))
  assert.equal(latest.targets.find((t) => t.targetId === 'lixiang-i6').status, 'failed')
  assert.ok(latest.targets.find((t) => t.targetId === 'xiaomi-su7').sampleCount >= 1)

  const html = await readFile(summary.html, 'utf8')
  assert.ok(html.includes('扫描失败'))
})

await test('看板 HTTP 服务：HTML/JSON/404，端口 0 自动分配', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vw-srv-'))
  const htmlPath = path.join(dir, 'dash.html')
  const jsonPath = path.join(dir, 'latest.json')
  await writeFile(htmlPath, '<!doctype html><title>dash</title><h1>看板</h1>', 'utf8')
  await writeFile(jsonPath, '{"ok":true}', 'utf8')

  const server = await startDashboardServer({ filePath: htmlPath, jsonPath, port: 0, log: silent })
  assert.ok(server.port > 0)
  const urls = dashboardUrls(server.port)
  assert.ok(urls.local.startsWith('http://127.0.0.1:'))
  try {
    const home = await fetch(`http://127.0.0.1:${server.port}/`)
    assert.equal(home.status, 200)
    assert.ok((home.headers.get('content-type') ?? '').includes('text/html'))
    assert.equal(await home.text(), '<!doctype html><title>dash</title><h1>看板</h1>')

    const data = await fetch(`http://127.0.0.1:${server.port}/latest.json`)
    assert.equal(data.status, 200)
    assert.deepEqual(await data.json(), { ok: true })

    const missing = await fetch(`http://127.0.0.1:${server.port}/nope`)
    assert.equal(missing.status, 404)
  } finally {
    await server.close()
  }
})

await test('闲鱼客户端请求队列：并发 search 被串行化', async () => {
  const realFetch = globalThis.fetch
  let active = 0
  let maxActive = 0
  const jsonResponse = (body, extraHeaders = {}) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
  globalThis.fetch = async (url) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await sleep(15)
    try {
      const target = String(url)
      if (!target.includes('/h5/')) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      if (target.includes('mtop.gaia')) {
        return jsonResponse({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }, { 'set-cookie': '_m_h5_tk=token123_1700000000; Path=/' })
      }
      return jsonResponse({ ret: ['SUCCESS::调用成功'], data: { resultList: [], resultInfo: { hasNextPage: false } } })
    } finally {
      active -= 1
    }
  }
  try {
    const client = createXianyuClient({ minGapMs: 0, timeoutMs: 2000, log: silent })
    const [a, b] = await Promise.all([client.search('A'), client.search('B')])
    assert.equal(a.rawCount, 0)
    assert.equal(b.rawCount, 0)
    assert.equal(maxActive, 1, `最大并发应为 1，实际 ${maxActive}`)
  } finally {
    globalThis.fetch = realFetch
  }
})

await test('隧道 URL 解析：命中 quick tunnel，忽略 api.trycloudflare.com', async () => {
  assert.equal(extractQuickTunnelUrl('api endpoint: https://api.trycloudflare.com'), null)
  assert.equal(extractQuickTunnelUrl('Visit it at https://self-film-jerry-liverpool.trycloudflare.com'), 'https://self-film-jerry-liverpool.trycloudflare.com')
  assert.equal(extractQuickTunnelUrl('https://before-crossing-exclusive-human.trycloudflare.com/'), 'https://before-crossing-exclusive-human.trycloudflare.com')
})

const failed = cases.filter((c) => !c.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
if (failed.length) process.exit(1)
