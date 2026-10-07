import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { ConversationMessage, ToolName } from '@even-qwen/protocol'

export type QwenFunctionCall = {
  callId: string
  responseId: string
  name: ToolName
  arguments: Record<string, unknown>
}

export type QwenSessionEvents = {
  onReady(): void
  onSpeechStarted(responseId: string): void
  onSpeechStopped(responseId: string): void
  onTranscriptDelta(responseId: string, delta: string): void
  onTranscriptFinal(responseId: string, text: string): void
  onTranscriptFailed(error: Error): void
  onAssistantDelta(responseId: string, delta: string): void
  onAssistantFinal(responseId: string, text: string): void
  onCancelled(responseId: string): void
  onToolCall(call: QwenFunctionCall): void
  onError(error: Error): void
}

export type QwenSessionOptions = {
  apiKey: string
  workspaceId?: string
  region: 'cn-beijing' | 'ap-southeast-1'
  model: string
  endpointOverride?: string
  history: ConversationMessage[]
  tools: unknown[]
  events: QwenSessionEvents
}

type JsonObject = Record<string, unknown>

export function resolveQwenEndpoint(options: Pick<QwenSessionOptions, 'endpointOverride' | 'model' | 'region' | 'workspaceId'>): string {
  if (options.endpointOverride) return options.endpointOverride
  if (options.model.startsWith('qwen3.8-')) {
    if (!options.workspaceId) throw new Error('DASHSCOPE_WORKSPACE_ID is required for Qwen3.8 Realtime')
    if (!/^[a-zA-Z0-9-]+$/.test(options.workspaceId)) throw new Error('DASHSCOPE_WORKSPACE_ID contains invalid characters')
    return `wss://${options.workspaceId}.${options.region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(options.model)}`
  }
  const host = options.region === 'ap-southeast-1' ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com'
  return `wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(options.model)}`
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function isRecoverableQwenTurnError(error: Error | string): boolean {
  const message = typeof error === 'string' ? error : error.message
  return /input speech was not accepted by semantic turn detection/i.test(message)
}

export class QwenOmniSession {
  private socket: WebSocket | null = null
  private ready = false
  private closed = false
  private activeResponseId = ''
  private assistantText = new Map<string, string>()
  private functionArguments = new Map<string, string>()
  private finalizedResponses = new Set<string>()

  constructor(private readonly options: QwenSessionOptions) {}

  async connect(): Promise<void> {
    if (this.socket) throw new Error('Qwen session already connected')
    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.options.apiKey}` }
      if (this.options.workspaceId) headers['X-DashScope-WorkSpace'] = this.options.workspaceId
      const socket = new WebSocket(resolveQwenEndpoint(this.options), { headers, handshakeTimeout: 15_000 })
      this.socket = socket
      let settled = false
      let initTimeout: NodeJS.Timeout | undefined
      const fail = (error: Error) => {
        if (initTimeout) clearTimeout(initTimeout)
        if (!settled) { settled = true; reject(error) }
        this.options.events.onError(error)
      }
      socket.once('open', () => {
        this.send({
          type: 'session.update',
          session: {
            modalities: ['text'],
            audio: {
              input: {
                format: {
                  type: 'pcm', sample_rate: 16_000, sample_format: 's16le', channels: 1,
                  packing: 'interleaved', channel_layout: 'mono',
                },
              },
              output: { voice: 'Tina' },
            },
            turn_detection: { type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 800 },
            input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
            enable_search: false,
            instructions: [
              '你是 Even Qwen，是运行在 Even G2 智能眼镜上的中文语音助手。',
              '回答应简洁、适合窄屏阅读。需要操作设备或电脑时必须使用提供的工具。',
              '不得请求或猜测可执行文件路径、Shell 命令、程序参数，也不得声称能读取 Codex 内容。',
              'Codex 只允许作为普通桌面应用列出、打开或切换。',
            ].join(''),
            tools: this.options.tools,
            tool_choice: 'auto',
          },
        })
      })
      socket.on('message', (data) => {
        this.handleMessage(data.toString())
        if (this.ready && !settled) {
          if (initTimeout) clearTimeout(initTimeout)
          settled = true
          resolve()
        }
      })
      socket.once('error', fail)
      socket.once('close', (code, reason) => {
        this.ready = false
        if (!this.closed) fail(new Error(`Qwen connection closed (${code}): ${reason.toString()}`))
      })
      initTimeout = setTimeout(() => {
        if (!settled) fail(new Error('Qwen session initialization timed out'))
      }, 20_000)
    })
  }

  appendAudio(pcm: Uint8Array): void {
    if (!this.ready || !pcm.byteLength) return
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') })
  }

  cancelResponse(): string {
    const responseId = this.activeResponseId
    if (this.ready && responseId) this.send({ type: 'response.cancel', response_id: responseId })
    return responseId
  }

  submitToolResult(callId: string, result: unknown): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    })
    this.send({ type: 'response.create', response: { modalities: ['text'] } })
  }

  close(): void {
    this.closed = true
    this.ready = false
    this.socket?.close(1000, 'voice mode stopped')
    this.socket = null
  }

  private send(value: JsonObject): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Qwen socket is not open')
    this.socket.send(JSON.stringify(value))
  }

  private replayHistory(): void {
    for (const message of this.options.history) {
      if (message.role === 'tool') continue
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: message.role,
          content: [{ type: message.role === 'user' ? 'input_text' : 'text', text: message.text }],
        },
      })
    }
  }

  private handleMessage(raw: string): void {
    try {
      const event = asObject(JSON.parse(raw))
      const type = stringValue(event.type)
      const response = asObject(event.response)
      const item = asObject(event.item)
      const responseId = stringValue(event.response_id) || stringValue(response.id) || this.activeResponseId || stringValue(event.item_id)
      if (type === 'session.updated' || type === 'session.created') {
        if (!this.ready && type === 'session.updated') {
          this.replayHistory()
          this.ready = true
          this.options.events.onReady()
        }
        return
      }
      if (type === 'input_audio_buffer.speech_started') {
        this.options.events.onSpeechStarted(responseId || randomUUID())
        return
      }
      if (type === 'input_audio_buffer.speech_stopped') {
        this.options.events.onSpeechStopped(responseId || randomUUID())
        return
      }
      if (type.endsWith('input_audio_transcription.delta')) {
        const preview = `${stringValue(event.text)}${stringValue(event.stash)}` || stringValue(event.delta)
        this.options.events.onTranscriptDelta(stringValue(event.item_id) || responseId, preview)
        return
      }
      if (type.endsWith('input_audio_transcription.completed')) {
        this.options.events.onTranscriptFinal(stringValue(event.item_id) || responseId, stringValue(event.transcript))
        return
      }
      if (type.endsWith('input_audio_transcription.failed')) {
        const error = asObject(event.error)
        this.options.events.onTranscriptFailed(new Error(stringValue(error.message) || 'Input audio transcription failed'))
        return
      }
      if (type === 'response.created') {
        this.activeResponseId = stringValue(response.id)
        return
      }
      if (type === 'response.output_text.delta' || type === 'response.text.delta') {
        const id = responseId || 'response'
        const delta = stringValue(event.delta)
        this.activeResponseId = id
        this.assistantText.set(id, (this.assistantText.get(id) || '') + delta)
        this.options.events.onAssistantDelta(id, delta)
        return
      }
      if (type === 'response.function_call_arguments.delta') {
        const callId = stringValue(event.call_id) || stringValue(item.call_id)
        this.functionArguments.set(callId, (this.functionArguments.get(callId) || '') + stringValue(event.delta))
        return
      }
      if (type === 'response.function_call_arguments.done') {
        const callId = stringValue(event.call_id) || stringValue(item.call_id)
        const rawArgs = stringValue(event.arguments) || this.functionArguments.get(callId) || '{}'
        this.functionArguments.delete(callId)
        this.options.events.onToolCall({
          callId,
          responseId: responseId || this.activeResponseId || 'response',
          name: (stringValue(event.name) || stringValue(item.name)) as ToolName,
          arguments: asObject(JSON.parse(rawArgs)),
        })
        return
      }
      if (type === 'response.cancelled') {
        const id = responseId || this.activeResponseId
        if (id) this.options.events.onCancelled(id)
        return
      }
      if (type === 'response.done') {
        const id = responseId || this.activeResponseId
        if (!id || this.finalizedResponses.has(id)) return
        const status = stringValue(response.status)
        if (status === 'cancelled') this.options.events.onCancelled(id)
        else {
          const text = this.assistantText.get(id) || this.extractResponseText(response)
          if (text) this.options.events.onAssistantFinal(id, text)
        }
        this.finalizedResponses.add(id)
        this.assistantText.delete(id)
        if (this.activeResponseId === id) this.activeResponseId = ''
        return
      }
      if (type === 'error') {
        const error = asObject(event.error)
        this.options.events.onError(new Error(stringValue(error.message) || stringValue(event.message) || 'Qwen realtime error'))
      }
    } catch (error) {
      this.options.events.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private extractResponseText(response: JsonObject): string {
    const output = Array.isArray(response.output) ? response.output : []
    return output.flatMap((entry) => {
      const content = Array.isArray(asObject(entry).content) ? asObject(entry).content as unknown[] : []
      return content.map((part) => stringValue(asObject(part).text))
    }).join('')
  }
}
