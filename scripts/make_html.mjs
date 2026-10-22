#!/usr/bin/env node
/**
 * 手动生成 HTML 看板（插件扫描时会自动生成，这里用于本地预览/重生成）
 *
 * 用法：
 *   node scripts/make_html.mjs <latest.json> [out.html] [intervalHours]
 *
 * 例：
 *   node scripts/make_html.mjs ../data/vehicle-watch/latest.json ../data/vehicle-watch/二手车监控-最新.html 2
 */
import path from 'node:path'

import { writeHtmlReport } from '../src/html-report.js'

const latestPath = process.argv[2]
if (!latestPath) {
  console.error('用法: node scripts/make_html.mjs <latest.json> [out.html] [intervalHours]')
  process.exit(1)
}
const outPath = process.argv[3] || path.join(path.dirname(latestPath), '二手车监控-最新.html')
const intervalHours = Number(process.argv[4]) || 2
const scanLogPath = path.join(path.dirname(latestPath), 'scan-log.jsonl')

const out = await writeHtmlReport({ latestPath, scanLogPath, outPath, intervalHours })
console.log('html:', out)
