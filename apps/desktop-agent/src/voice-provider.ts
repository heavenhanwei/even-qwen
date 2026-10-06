import { ParaformerSession, type ParaformerOptions } from './paraformer-asr.js'
import { QwenOmniSession, type QwenOmniOptions } from './qwen-omni.js'

export type VoiceProviderName = 'qwen-omni' | 'paraformer'

export type VoiceResult = {
  prompt: string
  provider: VoiceProviderName
  usedFallback: boolean
}

export interface VoiceSession {
  readonly activeProvider: VoiceProviderName
  start(): Promise<void>
  appendAudio(chunk: Buffer): void
  onTranscript(handler: (text: string) => void): () => void
  finish(): Promise<VoiceResult>
  close(): void
}

export type VoiceProviderConfig = {
  primary: VoiceProviderName
  fallback?: VoiceProviderName
  qwenOmni: QwenOmniOptions
  paraformer: ParaformerOptions
}

const MAX_BUFFERED_AUDIO_BYTES = 16_000 * 2 * 60

export function normalizeVoiceProvider(value: string | undefined): VoiceProviderName | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'qwen' || normalized === 'qwen-omni') return 'qwen-omni'
  if (normalized === 'paraformer') return 'paraformer'
  return null
}

export function createVoiceSession(config: VoiceProviderConfig): VoiceSession {
  return new FallbackVoiceSession(config)
}

class FallbackVoiceSession implements VoiceSession {
  private active: QwenOmniSession | ParaformerSession | null = null
  private provider: VoiceProviderName
  private readonly audioChunks: Buffer[] = []
  private audioBytes = 0
  private fallbackWasUsed = false
  private providerTranscriptCleanup: (() => void) | null = null
  private readonly transcriptHandlers = new Set<(text: string) => void>()

  constructor(private readonly config: VoiceProviderConfig) {
    this.provider = config.primary
  }

  get activeProvider() {
    return this.provider
  }

  async start() {
    try {
      this.active = this.createProvider(this.config.primary)
      this.attachTranscriptHandler()
      await this.active.start()
    } catch (primaryError) {
      this.active?.close()
      if (!this.config.fallback || this.config.fallback === this.config.primary) throw primaryError

      this.provider = this.config.fallback
      this.fallbackWasUsed = true
      this.active = this.createProvider(this.provider)
      this.attachTranscriptHandler()
      try {
        await this.active.start()
      } catch (fallbackError) {
        this.active.close()
        throw new AggregateError(
          [primaryError, fallbackError],
          `Voice providers failed: ${this.config.primary} and ${this.provider}`,
        )
      }
    }
  }

  appendAudio(chunk: Buffer) {
    if (!this.active) return
    this.audioBytes += chunk.byteLength
    if (this.audioBytes > MAX_BUFFERED_AUDIO_BYTES) {
      this.active.close()
      throw new Error('Voice input exceeded the 60 second limit')
    }

    const copy = Buffer.from(chunk)
    this.audioChunks.push(copy)
    this.active.appendAudio(copy)
  }

  onTranscript(handler: (text: string) => void) {
    this.transcriptHandlers.add(handler)
    return () => this.transcriptHandlers.delete(handler)
  }

  async finish(): Promise<VoiceResult> {
    if (!this.active) throw new Error('Voice session has not started')

    try {
      const prompt = await this.active.finish()
      return { prompt, provider: this.provider, usedFallback: this.fallbackWasUsed }
    } catch (primaryError) {
      this.active.close()
      if (
        this.fallbackWasUsed
        || !this.config.fallback
        || this.config.fallback === this.config.primary
      ) {
        throw primaryError
      }

      this.provider = this.config.fallback
      this.fallbackWasUsed = true
      this.active = this.createProvider(this.provider)
      this.attachTranscriptHandler()
      try {
        await this.active.start()
        for (const chunk of this.audioChunks) this.active.appendAudio(chunk)
        const prompt = await this.active.finish()
        return { prompt, provider: this.provider, usedFallback: true }
      } catch (fallbackError) {
        this.active.close()
        throw new AggregateError(
          [primaryError, fallbackError],
          `Voice providers failed: ${this.config.primary} and ${this.provider}`,
        )
      }
    }
  }

  close() {
    this.providerTranscriptCleanup?.()
    this.providerTranscriptCleanup = null
    this.active?.close()
  }

  private attachTranscriptHandler() {
    this.providerTranscriptCleanup?.()
    this.providerTranscriptCleanup = this.active?.onTranscript((text) => {
      for (const handler of this.transcriptHandlers) handler(text)
    }) || null
  }

  private createProvider(provider: VoiceProviderName) {
    return provider === 'qwen-omni'
      ? new QwenOmniSession(this.config.qwenOmni)
      : new ParaformerSession(this.config.paraformer)
  }
}
