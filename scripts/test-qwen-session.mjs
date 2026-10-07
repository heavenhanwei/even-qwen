import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { QwenOmniSession } from '../apps/desktop-agent/dist/qwen-session.js'

test('Qwen session configures semantic VAD, text modality and disabled search', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const received = []
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    received.push(message)
    if (message.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
  }))
  let ready = false
  const session = new QwenOmniSession({
    apiKey: 'test', region: 'cn-beijing', model: 'qwen3.8-omni-flash-realtime',
    endpointOverride: `ws://127.0.0.1:${address.port}`, history: [], tools: [],
    events: {
      onReady: () => { ready = true }, onSpeechStarted() {}, onSpeechStopped() {}, onTranscriptDelta() {},
      onTranscriptFinal() {}, onAssistantDelta() {}, onAssistantFinal() {}, onCancelled() {}, onToolCall() {},
      onError(error) { throw error },
    },
  })
  await session.connect()
  assert.equal(ready, true)
  const update = received.find((message) => message.type === 'session.update')
  assert.deepEqual(update.session.modalities, ['text'])
  assert.deepEqual(update.session.turn_detection, { type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 800 })
  assert.equal(update.session.enable_search, false)
  session.close()
  await new Promise((resolve) => server.close(resolve))
})
