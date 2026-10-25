import { randomUUID } from 'node:crypto'

/** 将已有的文本通知内容转换为智能机器人按钮卡；Webhook 不使用此结构。 */
export function toButtonCard(card, buttons = []) {
  const { jump_list: _jumpList, ...content } = card
  return {
    ...content,
    card_type: 'button_interaction',
    task_id: `vw_${randomUUID()}`,
    button_list: buttons.filter(Boolean).slice(0, 6),
  }
}

export function urlButton(title, url) {
  if (!url) return null
  return { text: String(title).slice(0, 10), type: 1, style: 1, url }
}

export function callbackButton(title, action, payload = {}) {
  return {
    text: String(title).slice(0, 10),
    type: 0,
    style: 1,
    key: encodeAction(action, payload),
  }
}

export function encodeAction(action, payload = {}) {
  const data = Object.keys(payload).length
    ? `:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
    : ''
  return `vw:${action}${data}`.slice(0, 1024)
}

export function decodeAction(key) {
  const raw = String(key ?? '')
  if (!raw.startsWith('vw:')) return null
  const [, action, encoded = ''] = raw.split(':')
  if (!action) return null
  try {
    return { action, payload: encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : {} }
  } catch {
    return null
  }
}
