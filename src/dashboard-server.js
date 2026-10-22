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

export async function startDashboardServer({ filePath, jsonPath, port = 47800, host = '0.0.0.0', log = console } = {}) {
  let server
  let boundPort = Number.isFinite(Number(port)) ? Number(port) : 47800

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = decodeURIComponent(url.pathname)
      if (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard') {
        const html = await readFile(filePath, 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }
      if (pathname === '/latest.json') {
        const json = await readFile(jsonPath)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(json)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('404')
    } catch (err) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`看板还没生成（下一轮扫描后自动出现）：${err.message}`)
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
