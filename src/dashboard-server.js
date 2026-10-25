/**
 * 看板的本地 HTTP 服务：让手机在同一 Wi-Fi 下直接打开「本轮新上架/降价」页面。
 *
 * - 默认监听 0.0.0.0:<dashboard.port>，端口被占用时依次 +1 重试；
 * - `/` 返回 reportDir/二手车监控-最新.html，`/latest.json` 返回本轮数据；
 * - 只读、无鉴权：同一个局域网可访问，不要在公网暴露。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { renderQueryErrorPage, renderQueryPage } from './html-report.js'
import { targetIdForKeyword, validDashboardToken } from './dashboard-auth.js'

/** 当前机器的局域网 IPv4 地址（优先 en0/Ethernet，跳过回环与自分配地址）。 */
export function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (item.address.startsWith('169.254.')) continue
      out.push({ name, address: item.address })
    }
  }
  const score = (name) => (name === 'en0' ? 0 : /^en\d+$/.test(name) ? 1 : /^(eth|Ethernet)/i.test(name) ? 2 : 3)
  return out.sort((a, b) => score(a.name) - score(b.name))
}

/** 看板的可用地址；手机用 lan，本机用 local。 */
export function dashboardUrls(port) {
  const lan = lanAddresses()[0]
  return {
    local: `http://127.0.0.1:${port}/`,
    lan: lan ? `http://${lan.address}:${port}/` : null,
    lanAddress: lan?.address ?? null,
    interface: lan?.name ?? null,
  }
}


/** 商品跳转落地页：在系统浏览器里尝试唤起闲鱼 App，在企微内提示切浏览器。 */
function landingPage(id, webUrl) {
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '')
  const appIos = `fleamarket://item?id=${safeId}`
  const appAndroid = `intent://item?id=${safeId}#Intent;scheme=fleamarket;package=com.taobao.idlefish;end`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>打开闲鱼 App</title>
<style>
body{margin:0;background:#f5f6f8;color:#111827;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:480px;margin:0 auto;padding:40px 20px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px}
h1{margin:0 0 8px;font-size:20px}
p{color:#4b5563;font-size:14px;margin:8px 0}
.tip{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:10px;padding:10px 12px;font-size:13px;margin:12px 0}
.btn{display:inline-block;margin:6px 8px 0 0;border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:8px;padding:8px 14px;font-size:14px;text-decoration:none;cursor:pointer}
.btn.secondary{background:#fff;color:#2563eb}
.hint{color:#9ca3af;font-size:12px;margin-top:14px;word-break:break-all}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <h1>打开闲鱼 App</h1>
  <p>正在尝试打开闲鱼 App 查看这件商品…</p>
  <div id="tip" class="tip" hidden></div>
  <a class="btn" id="app" href="${appIos}">打开闲鱼 App</a>
  <a class="btn secondary" href="${webUrl}">打开网页版</a>
  <p class="hint">商品编号：${safeId}<br><span id="ua-tip"></span></p>
</div></div>
<script>
(function(){
  var id = ${JSON.stringify(safeId)};
  var web = ${JSON.stringify(webUrl)};
  var ios = ${JSON.stringify(appIos)};
  var android = ${JSON.stringify(appAndroid)};
  var ua = navigator.userAgent || '';
  var isWeCom = /wxwork|WeCom|MicroMessenger/i.test(ua);
  var tip = document.getElementById('tip');
  if (isWeCom) {
    if (tip) { tip.hidden = false; tip.textContent = '当前在微信/企业微信内，无法直接打开闲鱼 App。请点右上角「…」→「在浏览器打开」，再点「打开闲鱼 App」。'; }
  } else {
    var scheme = /Android/i.test(ua) ? android : ios;
    var hidden = false;
    function mark(){ hidden = true }
    document.addEventListener('visibilitychange', mark, {once:true});
    window.addEventListener('pagehide', mark, {once:true});
    setTimeout(function(){ if (!hidden && !document.hidden) window.location.href = web }, 1600);
    window.location.href = scheme;
  }
})();
</script>
</body></html>`
}

export async function startDashboardServer({
  filePath, jsonPath, port = 47800, host = '0.0.0.0', log = console,
  queryHandler = null, monitorHandler = null, token = '',
} = {}) {
  let server
  let boundPort = Number.isFinite(Number(port)) ? Number(port) : 47800

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body)
  }

  async function readJson(req) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 8192) throw new Error('请求内容过大')
    }
    return JSON.parse(raw || '{}')
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = decodeURIComponent(url.pathname)
      const supplied = url.searchParams.get('token') || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (!validDashboardToken(supplied, token)) {
        send(res, 401, { error: '看板链接已失效，请在企业微信重新发送“看板”' })
        return
      }
      if (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard') {
        send(res, 200, await readFile(filePath, 'utf8'), 'text/html; charset=utf-8')
        return
      }
      if (pathname === '/go') {
        const id = String(url.searchParams.get('id') ?? '')
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return send(res, 400, { error: 'missing/invalid id' })
        send(res, 200, landingPage(id, `https://www.goofish.com/item?id=${encodeURIComponent(id)}`), 'text/html; charset=utf-8')
        return
      }
      if (pathname === '/query') {
        const q = String(url.searchParams.get('q') ?? '').trim()
        if (!q || q.length > 40) return send(res, 400, { error: 'missing/invalid q' })
        if (typeof queryHandler !== 'function') return send(res, 503, { error: '查询服务未启动' })
        try {
          const result = await queryHandler(q)
          send(res, 200, renderQueryPage({ keyword: q, agg: result?.agg ?? {}, listings: result?.listings ?? [], now: Date.now() }), 'text/html; charset=utf-8')
        } catch (err) {
          send(res, 502, renderQueryErrorPage({ keyword: q, message: err?.message ?? String(err) }), 'text/html; charset=utf-8')
        }
        return
      }
      if (pathname === '/latest.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(await readFile(jsonPath))
        return
      }
      if (pathname === '/api/dashboard' && req.method === 'GET') {
        let latest = null
        try { latest = JSON.parse(await readFile(jsonPath, 'utf8')) } catch { /* 尚未首扫 */ }
        send(res, 200, { latest, monitors: monitorHandler ? await monitorHandler.status() : [] })
        return
      }
      if (pathname === '/api/monitor' && req.method === 'POST') {
        if (!monitorHandler) return send(res, 503, { error: '监控服务未启动' })
        let body
        try { body = await readJson(req) } catch { return send(res, 400, { error: '请求 JSON 无效' }) }
        const action = body?.action
        if (!['add', 'remove', 'toggle'].includes(action)) return send(res, 400, { error: 'action 仅支持 add/remove/toggle' })
        if (action === 'add') {
          const name = String(body.name ?? '').trim()
          const keyword = String(body.keyword ?? '').trim()
          if (!name || !keyword || name.length > 40 || keyword.length > 40) return send(res, 400, { error: '车型名和关键词必填，且不能超过 40 字' })
          const result = await monitorHandler.addTargets([{ id: targetIdForKeyword(keyword), name, keyword, enabled: true }])
          return send(res, 200, { ok: true, result, monitors: await monitorHandler.status() })
        }
        const id = String(body.id ?? '')
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return send(res, 400, { error: '车型 ID 无效' })
        if (action === 'toggle') {
          const targets = await monitorHandler.status()
          const target = targets.find((t) => t.id === id)
          if (!target) return send(res, 404, { error: '车型不存在' })
          const enabled = typeof body.enabled === 'boolean' ? body.enabled : target.enabled === false
          if (body.enabled != null && typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled 必须是布尔值' })
          const changed = await monitorHandler.setTargetEnabled(id, enabled)
          return send(res, changed ? 200 : 409, changed ? { ok: true, monitors: await monitorHandler.status() } : { error: '状态未改变' })
        }
        const removed = await monitorHandler.removeTarget(id)
        return send(res, removed ? 200 : 404, removed ? { ok: true, monitors: await monitorHandler.status() } : { error: '车型不存在或已移除' })
      }
      send(res, 404, { error: '404' })
    } catch (err) {
      send(res, 503, { error: `看板暂不可用：${err.message}` })
    }
  }

  await new Promise((resolve, reject) => {
    let attempts = 0
    const listen = () => {
      server = createServer(handler)
      server.on('clientError', (_err, socket) => {
        try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch { /* ignore */ }
      })
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < 5) {
          attempts += 1
          boundPort += 1
          listen()
          return
        }
        reject(err)
      })
      server.listen(boundPort, host, () => {
        boundPort = server.address()?.port ?? boundPort
        resolve()
      })
    }
    listen()
  })

  log.info?.('dashboard server listening on %s:%d', host, boundPort)
  return {
    port: boundPort,
    close: () => new Promise((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
    }),
  }
}
