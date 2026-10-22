import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function storePaths(statePath) {
  const dir = path.dirname(statePath)
  return {
    dir,
    watchlist: path.join(dir, 'watchlist.json'),
    pending: path.join(dir, 'aibot-pending.json'),
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function loadWatchlist(statePath) {
  const data = await readJson(storePaths(statePath).watchlist, null)
  return Array.isArray(data?.targets) ? data.targets : []
}

/** 动态监控清单：不改 config、不重启插件，下一次扫描立即生效。 */
export async function addWatchTargets(statePath, candidates, configTargets = []) {
  const file = storePaths(statePath).watchlist
  const data = await readJson(file, { version: 1, targets: [] })
  if (!Array.isArray(data.targets)) data.targets = []
  const existing = new Set([...configTargets.map((t) => t.id), ...data.targets.map((t) => t.id)])
  const added = []
  const skipped = []
  const now = new Date().toISOString()
  for (const c of candidates) {
    const keyword = c?.keyword || c?.usedCarUrl || ''
    if (!c?.id || !keyword) { skipped.push(c); continue }
    if (existing.has(c.id)) { skipped.push(c); continue }
    const target = {
      id: c.id,
      name: c.name,
      keyword,
      referenceOfficialLow: c.referenceOfficialLow ?? 0,
      referenceOfficialHigh: c.referenceOfficialHigh ?? 0,
      enabled: true,
      source: 'aibot',
      createdAt: now,
    }
    data.targets.push(target)
    existing.add(target.id)
    added.push(target)
  }
  data.version = 1
  data.updatedAt = now
  await writeJson(file, data)
  return { added, skipped }
}

export async function removeWatchTarget(statePath, id) {
  const file = storePaths(statePath).watchlist
  const data = await readJson(file, { version: 1, targets: [] })
  const before = Array.isArray(data.targets) ? data.targets.length : 0
  data.targets = (data.targets ?? []).filter((t) => t.id !== id)
  data.updatedAt = new Date().toISOString()
  await writeJson(file, data)
  return before !== data.targets.length
}

/** 会话状态：同一个群/用户 15 分钟内有效。 */
export async function getPending(statePath, key) {
  const file = storePaths(statePath).pending
  const data = await readJson(file, { entries: {} })
  const entry = data.entries?.[key]
  if (!entry) return null
  if (Date.now() - Date.parse(entry.createdAt) > 15 * 60 * 1000) {
    delete data.entries[key]
    await writeJson(file, data)
    return { ...entry, expired: true }
  }
  return entry
}

export async function setPending(statePath, key, value) {
  const file = storePaths(statePath).pending
  const data = await readJson(file, { entries: {} })
  if (!data.entries) data.entries = {}
  const now = new Date().toISOString()
  data.entries[key] = { ...value, createdAt: now }
  // 清理超过 24h 的会话
  for (const [k, v] of Object.entries(data.entries)) {
    if (Date.now() - Date.parse(v.createdAt) > 24 * 3600 * 1000) delete data.entries[k]
  }
  await writeJson(file, data)
  return data.entries[key]
}

export async function clearPending(statePath, key) {
  const file = storePaths(statePath).pending
  const data = await readJson(file, { entries: {} })
  if (data.entries?.[key]) {
    delete data.entries[key]
    await writeJson(file, data)
  }
}
