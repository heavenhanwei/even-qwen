import { randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config as loadEnvironment } from 'dotenv'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type DeviceStatusSnapshot,
  type ServerMessage,
  type ServerMessagePayload,
  type ToolName,
} from '@even-qwen/protocol'
import { ConversationStore } from './conversation-store.js'
import { QwenOmniSession, isRecoverableQwenTurnError, type QwenFunctionCall } from './qwen-session.js'
import {
  QWEN_TOOLS,
  TOOL_CONFIRMATION,
  approvalSummary,
  executeDesktopTool,
  redactedArguments,
  validateToolCall,
} from './tool-registry.js'

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true })

const bindHost = process.env.AGENT_BIND_HOST || '127.0.0.1'
const port = Number(process.env.AGENT_PORT || 8788)
const pairingToken = process.env.AGENT_PAIRING_TOKEN || ''
const qwenApiKey = process.env.DASHSCOPE_API_KEY || ''
const qwenWorkspaceId = process.env.DASHSCOPE_WORKSPACE_ID || undefined
const qwenRegion = process.env.DASHSCOPE_REGION === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing'
const qwenModel = process.env.QWEN_OMNI_MODEL || 'qwen3.8-omni-flash-realtime'
const qwenEndpoint = process.env.QWEN_OMNI_ENDPOINT || undefined

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AGENT_PORT must be a valid TCP port')

const store = new ConversationStore()
await store.initialize()

function tokenMatches(candidate: string | undefined): boolean {
  if (!pairingToken) return true
  if (!candidate) return false
  const expected = Buffer.from(pairingToken)
  const received = Buffer.from(candidate)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

type PendingApproval = { call: QwenFunctionCall; args: Record<string, unknown> }
type PendingClientTool = { call: QwenFunctionCall; timer: NodeJS.Timeout }

class ClientConnection {
  private authenticated = false
  private conversationId = ''
  private voice: QwenOmniSession | null = null
  private pendingApprovals = new Map<string, PendingApproval>()
  private pendingClientTools = new Map<string, PendingClientTool>()
  private silenceTimer: NodeJS.Timeout | null = null
  private rotationTimer: NodeJS.Timeout | null = null
  private starting = false
  private closingVoice = false
  private lastDeviceStatus: DeviceStatusSnapshot = { connected: false }
  private currentResponseId = ''

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data, binary) => void this.onMessage(data, binary))
    socket.on('close', () => this.dispose())
    socket.on('error', (error) => console.error('[client] socket error', error.message))
  }

  private send(message: ServerMessagePayload): void {
    if (this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }))
  }

  private error(code: string, message: string, requestId?: string): void {
    this.send({ type: 'error', conversationId: this.conversationId, code, message, requestId })
  }

  private async onMessage(data: RawData, binary: boolean): Promise<void> {
    if (binary) {
      if (!this.authenticated || !this.voice || this.currentResponseId) return
      const bytes = new Uint8Array(data as Buffer)
      this.voice.appendAudio(bytes)
      return
    }
    let message: ClientMessage
    try {
      message = parseClientMessage(data.toString())
    } catch (error) {
      this.error('invalid_message', error instanceof Error ? error.message : String(error))
      return
    }
    if (!this.authenticated) {
      if (message.type !== 'hello' || !tokenMatches(message.token)) {
        this.error('unauthorized', 'Pairing token is invalid')
        this.socket.close(1008, 'unauthorized')
        return
      }
      this.authenticated = true
      this.conversationId = message.conversationId
      this.send({
        type: 'ready',
        conversationId: this.conversationId,
        qwenReady: Boolean(qwenApiKey),
        conversations: await store.list(),
      })
      return
    }
    if (message.conversationId) this.conversationId = message.conversationId
    try {
      await this.handle(message)
    } catch (error) {
      this.error('request_failed', error instanceof Error ? error.message : String(error), 'requestId' in message ? message.requestId : undefined)
    }
  }

  private async handle(message: ClientMessage): Promise<void> {
    if (message.type === 'hello') return
    if (message.type === 'ping') {
      this.send({ type: 'pong', conversationId: this.conversationId, requestId: message.requestId })
      return
    }
    if (message.type === 'client.log') {
      console[message.level](`[g2] ${message.message}`)
      return
    }
    if (message.type === 'device.status') {
      this.lastDeviceStatus = sanitizeDeviceStatus(message.status)
      this.send({ type: 'device.status', conversationId: this.conversationId, status: this.lastDeviceStatus })
      return
    }
    if (message.type === 'conversation.list') {
      this.send({ type: 'conversation.list.result', conversationId: this.conversationId, requestId: message.requestId, conversations: await store.list() })
      return
    }
    if (message.type === 'conversation.create') {
      const conversation = await store.create()
      this.conversationId = conversation.id
      this.send({ type: 'conversation.created', conversationId: conversation.id, requestId: message.requestId, conversation })
      return
    }
    if (message.type === 'conversation.open') {
      const opened = await store.open(this.conversationId)
      this.send({ type: 'conversation.open.result', conversationId: this.conversationId, requestId: message.requestId, ...opened })
      return
    }
    if (message.type === 'voice.mode.start') {
      await this.startVoice(message.requestId)
      return
    }
    if (message.type === 'voice.mode.stop') {
      this.stopVoice('stopped')
      return
    }
    if (message.type === 'response.cancel') {
      const responseId = this.voice?.cancelResponse() || message.responseId || this.currentResponseId
      this.currentResponseId = ''
      if (responseId) this.send({ type: 'assistant.cancelled', conversationId: this.conversationId, responseId })
      this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'listening' })
      this.resetSilenceTimer()
      return
    }
    if (message.type === 'tool.approval.resolve') {
      const pending = this.pendingApprovals.get(message.toolCallId)
      if (!pending) throw new Error('Approval request has expired')
      this.pendingApprovals.delete(message.toolCallId)
      if (!message.approved) {
        await this.finishTool(pending.call, { ok: false, error: 'User rejected this tool request' })
      } else {
        await this.executeTool(pending.call, pending.args)
      }
      return
    }
    if (message.type === 'client.tool.result') {
      const pending = this.pendingClientTools.get(message.toolCallId)
      if (!pending) throw new Error('Client tool request has expired')
      clearTimeout(pending.timer)
      this.pendingClientTools.delete(message.toolCallId)
      const result = message.ok
        ? { ok: true, result: sanitizeDeviceStatus(message.result as DeviceStatusSnapshot) }
        : { ok: false, error: message.error || 'Device status unavailable' }
      await this.finishTool(pending.call, result)
    }
  }

  private async startVoice(requestId: string): Promise<void> {
    if (!qwenApiKey) throw new Error('DASHSCOPE_API_KEY is not configured')
    if (this.starting) return
    if (!this.conversationId) {
      const created = await store.create()
      this.conversationId = created.id
      this.send({ type: 'conversation.created', conversationId: created.id, requestId, conversation: created })
    } else {
      await store.open(this.conversationId)
    }
    this.starting = true
    this.stopVoiceTimers()
    this.voice?.close()
    this.voice = null
    this.currentResponseId = ''
    this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'connecting' })
    const history = await store.replay(this.conversationId)
    const session = new QwenOmniSession({
      apiKey: qwenApiKey,
      workspaceId: qwenWorkspaceId,
      region: qwenRegion,
      model: qwenModel,
      endpointOverride: qwenEndpoint,
      history,
      tools: QWEN_TOOLS,
      events: {
        onReady: () => {
          this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'listening' })
          this.resetSilenceTimer()
        },
        onSpeechStarted: (responseId) => {
          this.resetSilenceTimer()
          this.send({ type: 'speech.started', conversationId: this.conversationId, responseId })
        },
        onSpeechStopped: (responseId) => {
          this.send({ type: 'speech.stopped', conversationId: this.conversationId, responseId })
          this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'thinking' })
        },
        onTranscriptDelta: (responseId, delta) => this.send({
          type: 'transcript.delta', conversationId: this.conversationId, responseId, delta, snapshot: true,
        }),
        onTranscriptFinal: (responseId, text) => {
          this.send({ type: 'transcript.final', conversationId: this.conversationId, responseId, text })
          if (text.trim()) void store.append(this.conversationId, 'user', text)
        },
        onTranscriptFailed: (error) => console.warn('[qwen] input transcription failed:', error.message),
        onAssistantDelta: (responseId, delta) => {
          this.currentResponseId = responseId
          this.resetSilenceTimer()
          this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'responding' })
          this.send({ type: 'assistant.delta', conversationId: this.conversationId, responseId, delta })
        },
        onAssistantFinal: (responseId, text) => {
          this.currentResponseId = ''
          this.send({ type: 'assistant.final', conversationId: this.conversationId, responseId, text })
          this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'listening' })
          if (text.trim()) void store.append(this.conversationId, 'assistant', text)
          this.resetSilenceTimer()
        },
        onCancelled: (responseId) => {
          this.currentResponseId = ''
          this.send({ type: 'assistant.cancelled', conversationId: this.conversationId, responseId })
          this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'listening' })
          this.resetSilenceTimer()
        },
        onToolCall: (call) => void this.handleToolCall(call),
        onError: (error) => {
          if (isRecoverableQwenTurnError(error)) {
            console.warn('[qwen] semantic VAD rejected a short or unclear utterance; continuing to listen')
            this.currentResponseId = ''
            this.send({
              type: 'voice.mode.status', conversationId: this.conversationId, stage: 'listening',
              detail: '未检测到有效语音，请继续说话',
            })
            this.resetSilenceTimer()
            return
          }
          console.error('[qwen]', error.message)
          this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'error', detail: error.message })
        },
      },
    })
    this.voice = session
    try {
      await session.connect()
      this.rotationTimer = setTimeout(() => void this.rotateVoice(), 110 * 60 * 1000)
    } finally {
      this.starting = false
    }
  }

  private async rotateVoice(): Promise<void> {
    if (!this.voice || this.starting) return
    this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'connecting', detail: '安全轮换 Qwen 会话' })
    await this.startVoice(randomUUID()).catch((error) => this.error('qwen_rotation_failed', error instanceof Error ? error.message : String(error)))
  }

  private async handleToolCall(call: QwenFunctionCall): Promise<void> {
    this.resetSilenceTimer()
    let args: Record<string, unknown>
    try {
      args = validateToolCall(call.name, call.arguments)
    } catch (error) {
      await this.finishTool(call, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (TOOL_CONFIRMATION[call.name]) {
      this.pendingApprovals.set(call.callId, { call, args })
      this.send({
        type: 'tool.approval.request', conversationId: this.conversationId, requestId: randomUUID(),
        responseId: call.responseId, toolCallId: call.callId, toolName: call.name,
        summary: approvalSummary(call.name, args), parameters: redactedArguments(call.name, args),
      })
      return
    }
    if (call.name === 'even_get_device_status') {
      const timer = setTimeout(() => {
        this.pendingClientTools.delete(call.callId)
        void this.finishTool(call, { ok: false, error: 'Even device status request timed out' })
      }, 10_000)
      this.pendingClientTools.set(call.callId, { call, timer })
      this.send({
        type: 'client.tool.request', conversationId: this.conversationId, requestId: randomUUID(),
        responseId: call.responseId, toolCallId: call.callId, toolName: 'even_get_device_status',
      })
      return
    }
    await this.executeTool(call, args)
  }

  private async executeTool(call: QwenFunctionCall, args: Record<string, unknown>): Promise<void> {
    const result = await executeDesktopTool(call.name, args)
    await this.finishTool(call, result)
  }

  private async finishTool(call: QwenFunctionCall, result: { ok: boolean; result?: unknown; error?: string }): Promise<void> {
    this.send({
      type: 'tool.execution.result', conversationId: this.conversationId, requestId: randomUUID(),
      responseId: call.responseId, toolCallId: call.callId, toolName: call.name, ...result,
    })
    await store.append(this.conversationId, 'tool', `${call.name}: ${result.ok ? 'ok' : result.error || 'failed'}`)
    this.voice?.submitToolResult(call.callId, result)
    this.currentResponseId = ''
    this.resetSilenceTimer()
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => this.stopVoice('60 秒静默，语音模式已关闭'), 60_000)
  }

  private stopVoice(detail: string): void {
    if (this.closingVoice) return
    this.closingVoice = true
    this.stopVoiceTimers()
    this.voice?.close()
    this.voice = null
    this.currentResponseId = ''
    for (const pending of this.pendingClientTools.values()) clearTimeout(pending.timer)
    this.pendingClientTools.clear()
    this.pendingApprovals.clear()
    this.send({ type: 'voice.mode.status', conversationId: this.conversationId, stage: 'stopped', detail })
    this.closingVoice = false
  }

  private stopVoiceTimers(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    if (this.rotationTimer) clearTimeout(this.rotationTimer)
    this.silenceTimer = null
    this.rotationTimer = null
  }

  private dispose(): void {
    this.stopVoiceTimers()
    this.voice?.close()
    for (const pending of this.pendingClientTools.values()) clearTimeout(pending.timer)
  }
}

function sanitizeDeviceStatus(value: DeviceStatusSnapshot): DeviceStatusSnapshot {
  return {
    connected: value?.connected === true,
    ...(Number.isFinite(value?.batteryLevel) ? { batteryLevel: Math.max(0, Math.min(100, Number(value.batteryLevel))) } : {}),
    ...(typeof value?.isCharging === 'boolean' ? { isCharging: value.isCharging } : {}),
    ...(typeof value?.isWearing === 'boolean' ? { isWearing: value.isWearing } : {}),
    ...(typeof value?.isInCase === 'boolean' ? { isInCase: value.isInCase } : {}),
  }
}

const server = new WebSocketServer({ host: bindHost, port })
server.on('connection', (socket) => new ClientConnection(socket))
server.on('listening', () => {
  console.log(`Even Qwen Agent listening on ws://${bindHost}:${port}`)
  console.log(`Qwen model: ${qwenModel}; configured: ${Boolean(qwenApiKey)}`)
  console.log(`Sessions: ${store.directory}`)
})
server.on('error', (error) => {
  console.error('Agent server error:', error)
  process.exitCode = 1
})
