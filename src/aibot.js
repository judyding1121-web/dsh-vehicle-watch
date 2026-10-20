import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com'

function reqId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 企业微信「智能机器人」长连接客户端（双向）。
 * 只实现本插件需要的：认证、心跳、接收文本消息、回复一条 Markdown。
 * 协议参考 @wecom/aibot-node-sdk（aibot_subscribe / aibot_msg_callback / aibot_respond_msg）。
 */
export class AibotClient {
  constructor({ botId, secret, wsUrl = DEFAULT_WS_URL, heartbeatMs = 25000, log = console, onText = null, onEvent = null } = {}) {
    this.botId = botId
    this.secret = secret
    this.wsUrl = wsUrl || DEFAULT_WS_URL
    this.heartbeatMs = heartbeatMs
    this.log = log
    this.onText = onText
    this.onEvent = onEvent

    this.ws = null
    this.authenticated = false
    this.manualClose = false
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.authFailures = 0
    this.received = 0
    this.replied = 0
    this.lastMessageAt = null
    this.lastText = null
    this.lastReply = null
    this.lastError = null
    this.seenMsgIds = new Set()
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated
  }

  getStatus() {
    return {
      enabled: Boolean(this.botId && this.secret),
      connected: this.connected,
      authenticated: this.authenticated,
      received: this.received,
      replied: this.replied,
      lastMessageAt: this.lastMessageAt,
      lastText: this.lastText,
      lastReply: this.lastReply,
      lastError: this.lastError,
    }
  }

  connect() {
    if (!this.botId || !this.secret) {
      this.log.info?.('aibot not configured, skip')
      return
    }
    this.manualClose = false
    this.clearReconnect()
    this.open()
  }

  open() {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate() } catch { /* ignore */ }
      this.ws = null
    }
    this.authenticated = false
    this.log.info?.('aibot connecting: %s', this.wsUrl)
    const ws = new WebSocket(this.wsUrl, { headers: { 'User-Agent': 'dsh-vehicle-watch/0.1' } })
    this.ws = ws

    ws.on('open', () => {
      this.log.info?.('aibot socket open, subscribing')
      this.send({
        cmd: 'aibot_subscribe',
        headers: { req_id: reqId('subscribe') },
        body: { bot_id: this.botId, secret: this.secret },
      })
    })

    ws.on('message', (data) => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      this.handleFrame(frame)
    })

    ws.on('error', (err) => {
      this.lastError = err?.message ?? String(err)
      this.log.warn?.('aibot socket error: %s', this.lastError)
    })

    ws.on('close', (code, reason) => {
      const why = reason?.toString?.() || String(code)
      this.authenticated = false
      this.stopHeartbeat()
      this.log.warn?.('aibot socket closed: %s', why)
      if (!this.manualClose) this.scheduleReconnect()
    })
  }

  handleFrame(frame) {
    const cmd = frame?.cmd
    const req = frame?.headers?.req_id ?? ''

    // 认证/心跳回执：{ headers: { req_id }, errcode, errmsg }
    if (frame?.errcode != null) {
      if (req.startsWith('subscribe_')) {
        if (frame.errcode === 0) {
          this.authenticated = true
          this.authFailures = 0
          this.reconnectAttempts = 0
          this.startHeartbeat()
          this.log.info?.('aibot authenticated')
        } else {
          this.authFailures += 1
          this.lastError = `auth errcode=${frame.errcode} ${frame.errmsg ?? ''}`
          this.log.warn?.('aibot auth failed: %s', this.lastError)
          if (this.authFailures >= 3) {
            this.manualClose = true
            this.log.error?.('aibot auth failed 3 times, stop reconnecting')
          }
          try { this.ws?.close() } catch { /* ignore */ }
        }
      }
      return
    }

    if (cmd === 'aibot_msg_callback') {
      this.received += 1
      this.lastMessageAt = new Date().toISOString()
      const body = frame.body ?? {}
      const msgId = body.msgid ?? req
      if (this.seenMsgIds.has(msgId)) return
      this.seenMsgIds.add(msgId)
      if (this.seenMsgIds.size > 500) {
        const first = this.seenMsgIds.values().next().value
        this.seenMsgIds.delete(first)
      }
      this.handleMessage(frame, body)
      return
    }

    if (cmd === 'aibot_event_callback') {
      this.onEvent?.(frame)
    }
  }

  async handleMessage(frame, body) {
    const text = body?.text?.content ?? body?.voice?.content ?? ''
    this.lastText = String(text).slice(0, 500)
    const from = body?.from?.userid ?? ''
    const chatid = body?.chatid ?? ''
    try {
      const reply = this.onText ? await this.onText({ text: String(text).trim(), body, frame, from, chatid }) : null
      if (reply) {
        if (typeof reply === 'object' && reply.card) {
          this.lastReply = '[card] ' + String(reply.text ?? '').slice(0, 1800)
          const ok = this.replyCard(frame, reply.card)
          if (!ok) await this.reply(frame, reply.text ?? '查询完成')
        } else {
          const content = typeof reply === 'string' ? reply : (reply.text ?? '')
          this.lastReply = String(content).slice(0, 2000)
          await this.reply(frame, content)
        }
        this.replied += 1
      }
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      this.log.error?.('aibot handle message failed: %s', this.lastError)
      try { await this.reply(frame, `处理失败：${this.lastError}`) } catch { /* ignore */ }
    }
  }

  /** 回复一条模板卡片（与主动推送卡片同一套企业微信结构）。 */
  replyCard(frame, card) {
    const req = frame?.headers?.req_id
    if (!req) return false
    return this.send({
      cmd: 'aibot_respond_msg',
      headers: { req_id: req },
      body: { msgtype: 'template_card', template_card: card },
    })
  }

  /** 回复一条消息（stream 模式，finish=true，content 支持 Markdown）。 */
  async reply(frame, content) {
    const req = frame?.headers?.req_id
    if (!req) throw new Error('missing req_id')
    this.send({
      cmd: 'aibot_respond_msg',
      headers: { req_id: req },
      body: {
        msgtype: 'stream',
        stream: {
          id: reqId('stream'),
          finish: true,
          content: String(content).slice(0, 20000),
        },
      },
    })
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.send({ cmd: 'ping', headers: { req_id: reqId('ping') } })
    }, this.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect() {
    this.clearReconnect()
    const attempt = this.reconnectAttempts++
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
    this.log.info?.('aibot reconnecting in %dms', delay)
    this.reconnectTimer = setTimeout(() => this.open(), delay)
    this.reconnectTimer.unref?.()
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  send(frame) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(frame))
      return true
    } catch (err) {
      this.lastError = err?.message ?? String(err)
      return false
    }
  }

  close() {
    this.manualClose = true
    this.clearReconnect()
    this.stopHeartbeat()
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    this.authenticated = false
  }
}
