import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { QwenOmniSession, isRecoverableQwenTurnError, resolveQwenEndpoint } from '../apps/desktop-agent/dist/qwen-session.js'

test('semantic VAD rejection is classified as a recoverable turn error', () => {
  assert.equal(isRecoverableQwenTurnError('Input speech was not accepted by semantic turn detection'), true)
  assert.equal(isRecoverableQwenTurnError(new Error("Voice 'Chelsie' is not supported")), false)
})

test('Qwen3.8 uses its workspace-specific regional endpoint', () => {
  assert.equal(
    resolveQwenEndpoint({ workspaceId: 'ws-example', region: 'cn-beijing', model: 'qwen3.8-omni-flash-realtime' }),
    'wss://ws-example.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime',
  )
  assert.throws(
    () => resolveQwenEndpoint({ region: 'cn-beijing', model: 'qwen3.8-omni-flash-realtime' }),
    /DASHSCOPE_WORKSPACE_ID is required/,
  )
})

test('Qwen session configures semantic VAD, text modality and disabled search', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const received = []
  let serverSocket
  server.on('connection', (socket) => {
    serverSocket = socket
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      received.push(message)
      if (message.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
    })
  })
  let ready = false
  let transcriptPreview = ''
  let transcriptFinal = ''
  let transcriptFailures = 0
  const session = new QwenOmniSession({
    apiKey: 'test', region: 'cn-beijing', model: 'qwen3.8-omni-flash-realtime',
    endpointOverride: `ws://127.0.0.1:${address.port}`, history: [], tools: [],
    events: {
      onReady: () => { ready = true }, onSpeechStarted() {}, onSpeechStopped() {},
      onTranscriptDelta(_responseId, text) { transcriptPreview = text },
      onTranscriptFinal(_responseId, text) { transcriptFinal = text },
      onTranscriptFailed() { transcriptFailures += 1 },
      onAssistantDelta() {}, onAssistantFinal() {}, onCancelled() {}, onToolCall() {},
      onError(error) { throw error },
    },
  })
  await session.connect()
  assert.equal(ready, true)
  const update = received.find((message) => message.type === 'session.update')
  assert.deepEqual(update.session.modalities, ['text'])
  assert.deepEqual(update.session.turn_detection, { type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 800 })
  assert.equal(update.session.enable_search, false)
  assert.deepEqual(update.session.input_audio_transcription, { model: 'qwen3-asr-flash-realtime' })
  assert.deepEqual(update.session.audio, {
    input: {
      format: {
        type: 'pcm', sample_rate: 16_000, sample_format: 's16le', channels: 1,
        packing: 'interleaved', channel_layout: 'mono',
      },
    },
    output: { voice: 'Tina' },
  })
  serverSocket.send(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.delta', item_id: 'input-1', text: '你好', stash: '，世界',
  }))
  serverSocket.send(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed', item_id: 'input-1', transcript: '你好，世界。',
  }))
  serverSocket.send(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.failed', item_id: 'input-2', error: { message: 'test failure' },
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(transcriptPreview, '你好，世界')
  assert.equal(transcriptFinal, '你好，世界。')
  assert.equal(transcriptFailures, 1)
  session.close()
  await new Promise((resolve) => server.close(resolve))
})
