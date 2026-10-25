/**
 * 意图理解层：把自然语言先交给模型，输出「意图 + 归一化车型 + 置信度 + 候选」。
 *
 * 这是主路由，不是补丁：
 * - 能确认（confidence 高、keyword 明确）→ 直接执行查询/加监控；
 * - 不能确认（低置信度/多候选/口语太泛）→ 返回 needs_confirmation + alternatives，交给命令层向用户确认。
 *
 * 模型不可用/超时/返回不合法时返回 null，命令层再走确定性兜底。
 */
const INTENTS = new Set(['query', 'watch_add', 'watch_remove', 'latest', 'status', 'dashboard', 'scan', 'help', 'unknown'])

const PROMPT_TEMPLATE = `你是「西安二手车监控」助手的意图解析器。只输出一个 JSON 对象，不要 markdown、不要解释。

当前已监控车型（仅作上下文）：{TARGETS}

用户输入：{TEXT}

任务：判断用户意图，并把车型说法归一化成「闲鱼标题常用的官方品牌+车系」。
字段：
- intent: query（查车/看车源）/ watch_add（加入监控）/ watch_remove（取消监控）/ latest（最新上架/降价）/ status（行情/状态）/ dashboard（看板）/ scan（立即扫描）/ help / unknown
- brand: 品牌中文名，如 小米、理想、比亚迪、蔚来；不确定填空字符串
- model: 车系，如 YU7、SU7、L9、宋L
- keyword: 用于闲鱼搜索的关键词，只保留“品牌+车系”，如 “小米YU7”“理想L9”“比亚迪宋L”；不要颜色/配置/年份/价格
- name: 展示给用户看的车型名，一般同 keyword
- confidence: 0~1，表示你对 keyword 的确定程度
- needs_confirmation: true/false；无法唯一确定时必须 true
- question: needs_confirmation 为 true 时，用来问用户的一句话
- alternatives: 最多 3 个候选，每项 {"name":"","keyword":"","reason":""}

规则（很重要）：
1. 按汽车常识归一化口语/音译/简称。例如“小米御7/御7”应归一为“小米YU7”，不要按字面搜“小米御7”；“宋L”归一为“比亚迪宋L”；“大六座”不是车型名。
2. 宁可让用户确认，也不要瞎猜：出现多个可能车系、只给了需求（座位/预算/能源类型）、或你不确定时，needs_confirmation=true，并在 alternatives 给出真实候选。
3. confidence < 0.7 时默认 needs_confirmation=true。
4. 纯管理指令不需要车型：看板→dashboard，扫描→scan，最近新上架→latest，现在行情→status，帮助→help。
5. 如果用户说“把某车加监控”，intent=watch_add；说“取消/删除某车监控”，intent=watch_remove。
6. 完全无法理解→intent=unknown，needs_confirmation=true，question 请用户换个说法或补充品牌+车系。

示例：
输入：“查个小米御7？”
输出：{"intent":"query","brand":"小米","model":"YU7","keyword":"小米YU7","name":"小米YU7","confidence":0.96,"needs_confirmation":false,"question":"","alternatives":[]}

输入：“想买个六座SUV，有什么推荐”
输出：{"intent":"query","brand":"","model":"","keyword":"","name":"","confidence":0.3,"needs_confirmation":true,"question":"你想看哪款六座SUV？","alternatives":[{"name":"理想L9","keyword":"理想L9","reason":"六座增程SUV"},{"name":"问界M9","keyword":"问界M9","reason":"六座增程SUV"},{"name":"理想L8","keyword":"理想L8","reason":"六座增程SUV"}]}

输入：“把YU7加入监控”
输出：{"intent":"watch_add","brand":"小米","model":"YU7","keyword":"小米YU7","name":"小米YU7","confidence":0.95,"needs_confirmation":false,"question":"","alternatives":[]}

输入：“最近有啥新上的”
输出：{"intent":"latest","brand":"","model":"","keyword":"","name":"","confidence":0.9,"needs_confirmation":false,"question":"","alternatives":[]}

输入：“现在行情怎么样”
输出：{"intent":"status","brand":"","model":"","keyword":"","name":"","confidence":0.9,"needs_confirmation":false,"question":"","alternatives":[]}`

function parseJson(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(raw.slice(start, end + 1)) } catch { return null }
}

function normalizeIntent(data) {
  if (!data || typeof data !== 'object') return null
  let intent = String(data.intent ?? '').trim()
  // 兼容旧版只返回 { brand, model, confidence } 的输出
  if (!INTENTS.has(intent)) {
    if (data.brand || data.model) intent = 'query'
    else return null
  }
  const brand = String(data.brand ?? '').trim().slice(0, 20)
  const model = String(data.model ?? '').trim().slice(0, 30)
  const keyword = String(data.keyword ?? '').trim().slice(0, 40) || (brand && model ? `${brand}${model}` : '')
  const name = String(data.name ?? '').trim().slice(0, 40) || keyword
  const confidence = Math.max(0, Math.min(1, Number(data.confidence ?? 0) || 0))
  const alternatives = (Array.isArray(data.alternatives) ? data.alternatives : [])
    .filter((x) => x && (x.keyword || (x.brand && x.model) || x.name))
    .slice(0, 3)
    .map((x) => {
      const k = String(x.keyword ?? '').trim() || `${x.brand ?? ''}${x.model ?? ''}`.trim() || String(x.name ?? '').trim()
      return { name: String(x.name ?? k).trim().slice(0, 40), keyword: k.slice(0, 40), reason: String(x.reason ?? '').trim().slice(0, 60) }
    })
    .filter((x) => x.keyword)
  const needsConfirmation = Boolean(data.needs_confirmation) || confidence < 0.7 || (intent === 'query' && !keyword)
  return {
    intent,
    brand,
    model,
    keyword,
    name,
    confidence,
    needs_confirmation: needsConfirmation,
    question: String(data.question ?? '').trim().slice(0, 120),
    alternatives,
  }
}

export function createLlmAnalyzer({ getLlm, provider = 'deepseek-account', model = 'deepseek-flash', timeoutMs = 15000, log = console } = {}) {
  return async function analyze(text, context = {}) {
    let llm
    try { llm = getLlm?.() } catch { llm = null }
    if (!llm?.stream) return null

    const targets = Array.isArray(context.targets) ? context.targets.slice(0, 10).join('、') : ''
    const prompt = PROMPT_TEMPLATE
      .replace('{TARGETS}', targets || '无')
      .replace('{TEXT}', JSON.stringify(String(text).slice(0, 300)))

    let output = ''
    try {
      const stream = llm.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: AbortSignal.timeout(timeoutMs),
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
      }
    } catch (err) {
      log.warn?.('llm intent analyze failed: %s', err.message)
      return null
    }

    return normalizeIntent(parseJson(output))
  }
}

export { normalizeIntent }
