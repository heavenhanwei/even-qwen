import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

export type QwenOmniOptions = {
  apiKey: string
  workspaceId: string
  region: 'cn-beijing' | 'ap-southeast-1'
  model?: string
  endpointOverride?: string
}

type QwenEvent = {
  type?: string
  name?: string
  arguments?: string
  text?: string
  stash?: string
  transcript?: string
  error?: { message?: string }
  message?: string
  response?: {
    status?: string
    status_details?: { error?: { message?: string } }
    output?: Array<{
      type?: string
      name?: string
      arguments?: string
      content?: Array<{ type?: string; text?: string }>
    }>
  }
}

const MAX_AUDIO_BYTES = 16_000 * 2 * 60
const TOOL_NAME = 'submit_codex_instruction'

export class QwenOmniSession {
  private readonly socket: WebSocket
  private readonly ready: Promise<void>
  private readonly finished: Promise<string>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private resolveFinished!: (prompt: string) => void
  private rejectFinished!: (error: Error) => void
  private bytesReceived = 0
  private isReady = false
  private isFinishing = false
  private isFinished = false
  private routedPrompt = ''
  private textResponse = ''
  private inputTranscript = ''
  private readonly transcriptHandlers = new Set<(text: string) => void>()
  private connectTimer: NodeJS.Timeout | null = null
  private finishTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: QwenOmniOptions) {
    const model = options.model || 'qwen3.8-omni-flash-realtime'
    const url = options.endpointOverride
      || `wss://${options.workspaceId}.${options.region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.finished = new Promise<string>((resolve, reject) => {
      this.resolveFinished = resolve
      this.rejectFinished = reject
    })
    void this.finished.catch(() => undefined)

    this.socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    })
    this.connectTimer = setTimeout(() => this.fail(new Error('Qwen Omni connection timed out')), 10_000)
    this.bindSocket(model)
  }

  async start() {
    await this.ready
  }

  appendAudio(chunk: Buffer) {
    if (!this.isReady || this.isFinishing || this.isFinished) return
    this.bytesReceived += chunk.byteLength
    if (this.bytesReceived > MAX_AUDIO_BYTES) {
      this.fail(new Error('Voice input exceeded the 60 second limit'))
      return
    }
    this.send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') })
  }

  onTranscript(handler: (text: string) => void) {
    this.transcriptHandlers.add(handler)
    return () => this.transcriptHandlers.delete(handler)
  }

  async finish() {
    await this.ready
    if (this.isFinished) return this.finished
    if (this.bytesReceived < 640) {
      this.fail(new Error('No usable microphone audio was received'))
      return this.finished
    }

    this.isFinishing = true
    this.send({ type: 'input_audio_buffer.commit' })
    this.send({ type: 'response.create' })
    this.finishTimer = setTimeout(() => this.fail(new Error('Qwen Omni response timed out')), 30_000)
    return this.finished
  }

  close() {
    this.clearTimers()
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, 'Client closed')
    }
  }

  private bindSocket(model: string) {
    this.socket.once('open', () => {
      this.send({
        type: 'session.update',
        session: {
          modalities: ['text'],
          model,
          audio: {
            input: {
              format: { type: 'pcm', sample_rate: 16_000 },
            },
          },
          instructions: [
            '你是 Even G2 的 Codex 语音任务路由器。',
            '理解用户口述的完整任务意图，保留路径、文件名、参数和约束。',
            `必须调用 ${TOOL_NAME}，不要直接回答用户。`,
          ].join(''),
          input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
          turn_detection: null,
          tools: [{
            type: 'function',
            function: {
              name: TOOL_NAME,
              description: '提交整理后的 Codex 执行指令。',
              parameters: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: '可直接交给 Codex 执行的完整任务指令。',
                  },
                },
                required: ['prompt'],
              },
            },
          }],
          temperature: 0.1,
          max_tokens: 1024,
        },
      })
    })

    this.socket.on('message', (data) => {
      let event: QwenEvent
      try {
        event = JSON.parse(data.toString()) as QwenEvent
      } catch {
        return
      }

      if (event.type === 'session.updated') {
        this.isReady = true
        if (this.connectTimer) clearTimeout(this.connectTimer)
        this.resolveReady()
        return
      }

      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        const transcript = `${event.text || ''}${event.stash || ''}`.trim()
        if (transcript) this.emitTranscript(transcript)
        return
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const transcript = event.transcript?.trim()
        if (transcript) {
          this.inputTranscript = transcript
          this.emitTranscript(transcript)
        }
        return
      }

      if (event.type === 'conversation.item.input_audio_transcription.failed') {
        return
      }

      if (event.type === 'response.function_call_arguments.done' && event.name === TOOL_NAME) {
        this.captureToolArguments(event.arguments)
        return
      }

      if (event.type === 'response.text.done' && event.text) {
        this.textResponse = event.text.trim()
        return
      }

      if (event.type === 'response.done') {
        for (const output of event.response?.output || []) {
          if (output.type === 'function_call' && output.name === TOOL_NAME) {
            this.captureToolArguments(output.arguments)
          }
          if (output.type === 'message') {
            this.textResponse = output.content
              ?.map((part) => part.text || '')
              .join(' ')
              .trim() || this.textResponse
          }
        }

        if (event.response?.status === 'failed') {
          this.fail(new Error(event.response.status_details?.error?.message || 'Qwen Omni response failed'))
        } else {
          this.complete()
        }
        return
      }

      if (event.type === 'error' || event.type?.endsWith('.failed')) {
        this.fail(new Error(event.error?.message || event.message || `Qwen Omni failed: ${event.type}`))
      }
    })

    this.socket.once('error', (error) => this.fail(error))
    this.socket.once('close', (code, reason) => {
      if (!this.isFinished) this.fail(new Error(`Qwen Omni connection closed (${code}): ${reason.toString()}`))
    })
  }

  private send(event: Record<string, unknown>) {
    this.socket.send(JSON.stringify({ event_id: randomUUID(), ...event }))
  }

  private captureToolArguments(value: string | undefined) {
    if (!value) return
    try {
      const parsed = JSON.parse(value) as { prompt?: unknown }
      if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) this.routedPrompt = parsed.prompt.trim()
    } catch {
      // A malformed tool call is handled as an empty result when response.done arrives.
    }
  }

  private emitTranscript(text: string) {
    for (const handler of this.transcriptHandlers) handler(text)
  }

  private complete() {
    if (this.isFinished) return
    this.isFinished = true
    this.clearTimers()
    const prompt = this.routedPrompt || this.textResponse || this.inputTranscript
    if (prompt) this.resolveFinished(prompt)
    else this.rejectFinished(new Error('Qwen Omni did not return a Codex instruction'))
    this.socket.close(1000, 'Omni response finished')
  }

  private fail(error: Error) {
    if (this.isFinished) return
    this.isFinished = true
    this.clearTimers()
    if (!this.isReady) this.rejectReady(error)
    this.rejectFinished(error)
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close()
    }
  }

  private clearTimers() {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    if (this.finishTimer) clearTimeout(this.finishTimer)
  }
}
