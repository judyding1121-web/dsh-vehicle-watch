/**
 * Cloudflare 快速隧道：把本地看板临时映射到一个公网 HTTPS 地址，
 * 让手机在户外（不在同一 Wi-Fi）也能打开「本轮新上架/降价」页面。
 *
 * - 使用 cloudflared 的免账号 quick tunnel（URL 形如 https://xxx.trycloudflare.com）；
 * - 地址随机、只读、无鉴权：不要转发给无关的人；Cloudflare 不保证长期可用；
 * - 找不到 cloudflared / 启动失败时返回 null，插件自动退回局域网地址。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

function binaryCandidates(custom) {
  const home = homedir()
  return [
    custom,
    process.env.CLOUDFLARED_PATH,
    // 优先用 npm 包里的原生二进制：它不依赖 PATH 里的 node（Electron 主进程的 PATH 通常没有 node）
    path.join(home, '.npm-global/lib/node_modules/cloudflared/bin/cloudflared'),
    '/opt/homebrew/lib/node_modules/cloudflared/bin/cloudflared',
    '/usr/local/lib/node_modules/cloudflared/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    // 最后才是 PATH 里的 wrapper（npm 全局 bin 是 #!/usr/bin/env node 脚本）
    path.join(home, '.npm-global/bin/cloudflared'),
    'cloudflared',
  ].filter(Boolean)
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 从 cloudflared 日志里提取 quick tunnel 地址（排除 api/www/developers 等固定域名）。 */
export function extractQuickTunnelUrl(text) {
  // quick tunnel 域名形如 xxx-yyy-zzz.trycloudflare.com
  const match = String(text ?? '').match(/https:\/\/(?!api\.|www\.|developers\.)[a-z0-9]+(?:-[a-z0-9]+){2,6}\.trycloudflare\.com/i)
  return match ? match[0] : null
}

function spawnOnce(bin, port) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      })
    } catch (err) {
      reject(err)
      return
    }
    let buffer = ''
    let done = false
    let exitHook = null
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGTERM')
      reject(new Error('cloudflared 启动超时（60s 内未拿到公网地址）'))
    }, 60_000)

    const onData = (chunk) => {
      if (done) return
      buffer += chunk.toString()
      const found = extractQuickTunnelUrl(buffer)
      if (found) {
        done = true
        clearTimeout(timer)
        resolve({
          child,
          url: found,
          onExit(cb) { exitHook = cb },
        })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(new Error(`cloudflared 退出（code ${code}）`))
        return
      }
      try { exitHook?.(code) } catch { /* ignore */ }
    })
  })
}

/**
 * 启动 quick tunnel；返回 { url, close }。
 * @param {{ port:number, command?:string, log?:object }} options
 */
export async function startQuickTunnel({ port, command = '', log = console } = {}) {
  let lastError = null
  for (const bin of binaryCandidates(command)) {
    if (bin !== 'cloudflared' && !isExecutable(bin)) continue
    try {
      const { child, url, onExit } = await spawnOnce(bin, port)
      log.info?.('public tunnel ready: %s', url)
      return {
        url,
        bin,
        onExit,
        close: () => new Promise((resolve) => {
          let settled = false
          const finish = () => { if (!settled) { settled = true; resolve() } }
          child.once('exit', finish)
          try { child.kill('SIGTERM') } catch { /* ignore */ }
          setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* ignore */ }
            finish()
          }, 3000)
        }),
      }
    } catch (err) {
      lastError = err
      log.warn?.('cloudflared candidate failed (%s): %s', bin, err.message)
      // 继续尝试下一个候选（例如 npm wrapper 依赖 node，失败后改用原生二进制）
    }
  }
  throw lastError ?? new Error('未找到 cloudflared（可 brew install cloudflared，或在 dashboard.tunnelCommand 指定路径）')
}
