import { spawnSync } from 'node:child_process'
import path from 'node:path'

/** 调用插件自带的 Python 报表脚本（openpyxl），避免给 DSH 装原生/第三方 Node 依赖。 */
export function generateReport({ pythonPath = 'python3', scriptPath, latestPath, outDir, timeoutMs = 120000 }) {
  const res = spawnSync(pythonPath, [scriptPath, latestPath, outDir], { encoding: 'utf8', timeout: timeoutMs })
  if (res.error) throw new Error(`report spawn failed: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`report failed (${res.status}): ${(res.stderr || res.stdout || '').slice(0, 500)}`)
  const out = path.join(outDir, '二手车监控-最新.xlsx')
  return { path: out, stdout: (res.stdout || '').trim() }
}
