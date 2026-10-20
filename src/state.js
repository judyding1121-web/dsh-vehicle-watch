import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function emptyState() {
  return { schemaVersion: 1, updatedAt: null, targets: {}, lastRun: null }
}

export async function loadState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (!state.targets) state.targets = {}
    return state
  } catch {
    return emptyState()
  }
}

export async function saveState(statePath, state) {
  state.updatedAt = new Date().toISOString()
  await mkdir(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, statePath)
}

/** 清理长期未出现的车源，避免 seen 无限增长。 */
export function pruneSeen(seen, nowMs, maxAgeDays = 60) {
  const cutoff = nowMs - maxAgeDays * 86400_000
  const out = {}
  for (const [id, info] of Object.entries(seen ?? {})) {
    const last = Date.parse(info?.lastSeen ?? 0)
    if (!Number.isFinite(last) || last >= cutoff) out[id] = info
  }
  return out
}
