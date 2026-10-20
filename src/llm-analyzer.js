/**
 * 可选：用 DSH 的模型服务把非标准说法解析成「品牌 + 车型」。
 * 只在确定性解析失败时调用，失败/超时不影响主流程。
 */
export function createLlmAnalyzer({ getLlm, provider = 'deepseek-account', model = 'deepseek-flash', timeoutMs = 15000, log = console } = {}) {
  return async function analyze(text) {
    let llm
    try { llm = getLlm?.() } catch { llm = null }
    if (!llm?.stream) return null

    const prompt = [
      '你是汽车车型解析器。把用户输入解析为“品牌 + 车系”。',
      `用户输入：${JSON.stringify(String(text).slice(0, 300))}`,
      '要求：',
      '1. 只输出一个 JSON 对象，不要 markdown、不要解释。',
      '2. 字段：brand（品牌中文名，如 理想/蔚来/小米）、model（车系名，如 L9/ES8/SU7）、confidence（0-1）。',
      '3. 如果用户只说了模糊需求或无法确定具体车系，confidence 设为 0，并在 alternatives 里给出最多 3 个候选：{"brand":"","model":""}。',
      '4. 示例：{"brand":"理想","model":"L9","confidence":0.95,"alternatives":[]}',
    ].join('\n')

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
      log.warn?.('llm analyze failed: %s', err.message)
      return null
    }

    const raw = output.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      const data = JSON.parse(raw.slice(start, end + 1))
      if (!data || typeof data.brand !== 'string' || typeof data.model !== 'string') return null
      return {
        brand: data.brand.trim(),
        model: data.model.trim(),
        confidence: Number(data.confidence) || 0,
        alternatives: Array.isArray(data.alternatives) ? data.alternatives.filter((x) => x?.brand && x?.model).slice(0, 3) : [],
      }
    } catch {
      return null
    }
  }
}
