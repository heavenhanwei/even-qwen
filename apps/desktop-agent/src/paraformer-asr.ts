import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

export type ParaformerOptions = {
  apiKey: string
  workspaceId: string
  region: 'cn-beijing' | 'ap-southeast-1'
  model?: string
  languageHints?: string[]
  endpointOverride?: string
}

type ParaformerEvent = {
  header?: {
    event?: string
    error_message?: string
  }
  payload?: {
    output?: {
      sentence?: {
        text?: string
        sentence_end?: boolean
        heartbeat?: boolean
      }
    }
  }
}

const MAX_AUDIO_BYTES = 16_000 * 2 * 60

export class ParaformerSession {
  private readonly socket: WebSocket
  private readonly taskId = randomUUID().replaceAll('-', '')
  private readonly ready: Promise<void>
  private readonly finished: Promise<string>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private resolveFinished!: (transcript: string) => void
  private rejectFinished!: (error: Error) => void
  private finalSentences: string[] = []
  private interimSentence = ''
  private readonly transcriptHandlers = new Set<(text: string) => void>()
  private bytesReceived = 0
  private isReady = false
  private isFinishing = false
  private isFinished = false
  private connectTimer: NodeJS.Timeout | null = null
  private finishTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: ParaformerOptions) {
    if (options.region !== 'cn-beijing' && !options.endpointOverride) {
      throw new Error('Paraformer realtime is only available in the cn-beijing DashScope region')
    }
    const url = options.endpointOverride
      || `wss://${options.workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`

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
      headers: { Authorization: `Bearer ${options.apiKey}` },
    })
    this.connectTimer = setTimeout(() => this.fail(new Error('Paraformer connection timed out')), 10_000)
    this.bindSocket()
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
    this.socket.send(chunk)
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
    this.socket.send(JSON.stringify({
      header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
      payload: { input: {} },
    }))
    this.finishTimer = setTimeout(() => this.fail(new Error('Paraformer transcription timed out')), 20_000)
    return this.finished
  }

  close() {
    this.clearTimers()
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, 'Client closed')
    }
  }

  private bindSocket() {
    this.socket.once('open', () => {
      this.socket.send(JSON.stringify({
        header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: this.options.model || 'paraformer-realtime-v2',
          parameters: {
            format: 'pcm',
            sample_rate: 16_000,
            language_hints: this.options.languageHints?.length ? this.options.languageHints : ['zh'],
            disfluency_removal_enabled: false,
            semantic_punctuation_enabled: false,
            punctuation_prediction_enabled: true,
            inverse_text_normalization_enabled: true,
          },
          input: {},
        },
      }))
    })

    this.socket.on('message', (data, isBinary) => {
      if (isBinary) return
      let event: ParaformerEvent
      try {
        event = JSON.parse(data.toString()) as ParaformerEvent
      } catch {
        return
      }

      const eventName = event.header?.event
      if (eventName === 'task-started') {
        this.isReady = true
        if (this.connectTimer) clearTimeout(this.connectTimer)
        this.resolveReady()
        return
      }

      if (eventName === 'result-generated') {
        const sentence = event.payload?.output?.sentence
        const text = sentence?.text?.trim()
        if (!text || sentence?.heartbeat) return
        if (sentence?.sentence_end) {
          this.finalSentences.push(text)
          this.interimSentence = ''
        } else {
          this.interimSentence = text
        }
        this.emitTranscript()
        return
      }

      if (eventName === 'task-finished') {
        this.complete()
        return
      }

      if (eventName === 'task-failed') {
        this.fail(new Error(event.header?.error_message || 'Paraformer task failed'))
      }
    })

    this.socket.once('error', (error) => this.fail(error))
    this.socket.once('close', (code, reason) => {
      if (!this.isFinished) this.fail(new Error(`Paraformer connection closed (${code}): ${reason.toString()}`))
    })
  }

  private complete() {
    if (this.isFinished) return
    this.isFinished = true
    this.clearTimers()
    const transcript = [...this.finalSentences, this.interimSentence].filter(Boolean).join(' ').trim()
    if (transcript) this.resolveFinished(transcript)
    else this.rejectFinished(new Error('Paraformer did not return a transcript'))
    this.socket.close(1000, 'ASR finished')
  }

  private emitTranscript() {
    const transcript = [...this.finalSentences, this.interimSentence].filter(Boolean).join(' ').trim()
    if (!transcript) return
    for (const handler of this.transcriptHandlers) handler(transcript)
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
