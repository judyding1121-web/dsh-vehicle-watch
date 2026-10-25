import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 看板访问令牌只保存在本机状态目录，不写配置、不进入消息卡片按钮 key。 */
export async function ensureDashboardToken(statePath) {
  const file = path.join(path.dirname(statePath), 'dashboard-token')
  try {
    const current = (await readFile(file, 'utf8')).trim()
    if (/^[a-f0-9]{48}$/.test(current)) return current
  } catch { /* 首次启动 */ }
  const token = randomBytes(24).toString('hex')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, token + '\n', { mode: 0o600 })
  return token
}

export function withDashboardToken(value, token) {
  if (!value || !token) return value || null
  try {
    const url = new URL(value)
    url.searchParams.set('token', token)
    return url.href
  } catch { return value }
}

export function validDashboardToken(supplied, expected) {
  if (!expected) return true
  const a = Buffer.from(String(supplied ?? ''))
  const b = Buffer.from(String(expected))
  return a.length === b.length && timingSafeEqual(a, b)
}

export function targetIdForKeyword(keyword) {
  return `custom-${createHash('sha256').update(String(keyword)).digest('hex').slice(0, 16)}`
}
