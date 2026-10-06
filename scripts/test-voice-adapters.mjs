import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { QwenOmniSession } from '../apps/desktop-agent/dist/qwen-omni.js'
import { ParaformerSession } from '../apps/desktop-agent/dist/paraformer-asr.js'
import { createVoiceSession } from '../apps/desktop-agent/dist/voice-provider.js'

async function withServer(onConnection, run) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  server.on('connection', onConnection)
  const address = server.address()
  try {
    await run(`ws://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

await withServer((socket) => {
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString())
    if (event.type === 'session.update') {
      assert.equal(event.session.model, 'qwen3.8-omni-flash-realtime')
      assert.equal(event.session.audio.input.format.sample_rate, 16_000)
      assert.equal(event.session.input_audio_transcription.model, 'qwen3-asr-flash-realtime')
      socket.send(JSON.stringify({ type: 'session.updated' }))
    }
    if (event.type === 'response.create') {
      socket.send(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        text: '检查项目',
        stash: '并运行测试',
      }))
      socket.send(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '检查项目并运行测试',
      }))
      socket.send(JSON.stringify({
        type: 'response.function_call_arguments.done',
        name: 'submit_codex_instruction',
        arguments: JSON.stringify({ prompt: '检查项目并运行测试' }),
      }))
      socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [] } }))
    }
  })
}, async (endpointOverride) => {
  const session = new QwenOmniSession({
    apiKey: 'test', workspaceId: 'test', region: 'cn-beijing', endpointOverride,
  })
  const captions = []
  session.onTranscript((text) => captions.push(text))
  await session.start()
  session.appendAudio(Buffer.alloc(640))
  assert.equal(await session.finish(), '检查项目并运行测试')
  assert.deepEqual(captions, ['检查项目并运行测试', '检查项目并运行测试'])
})

await withServer((socket) => {
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      assert.equal(data.byteLength, 640)
      return
    }
    const event = JSON.parse(data.toString())
    if (event.header.action === 'run-task') {
      assert.equal(event.payload.model, 'paraformer-realtime-v2')
      assert.equal(event.payload.parameters.sample_rate, 16_000)
      socket.send(JSON.stringify({ header: { event: 'task-started' } }))
    }
    if (event.header.action === 'finish-task') {
      socket.send(JSON.stringify({
        header: { event: 'result-generated' },
        payload: { output: { sentence: { text: '检查项目并运行测试', sentence_end: true } } },
      }))
      socket.send(JSON.stringify({ header: { event: 'task-finished' } }))
    }
  })
}, async (endpointOverride) => {
  const session = new ParaformerSession({
    apiKey: 'test', workspaceId: 'test', region: 'cn-beijing', endpointOverride,
  })
  const captions = []
  session.onTranscript((text) => captions.push(text))
  await session.start()
  session.appendAudio(Buffer.alloc(640))
  assert.equal(await session.finish(), '检查项目并运行测试')
  assert.deepEqual(captions, ['检查项目并运行测试'])
})

await withServer((socket) => {
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString())
    if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
    if (event.type === 'response.create') {
      socket.send(JSON.stringify({
        type: 'response.done',
        response: { status: 'failed', status_details: { error: { message: 'mock failure' } } },
      }))
    }
  })
}, async (omniEndpoint) => {
  await withServer((socket) => {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const event = JSON.parse(data.toString())
      if (event.header.action === 'run-task') {
        socket.send(JSON.stringify({ header: { event: 'task-started' } }))
      }
      if (event.header.action === 'finish-task') {
        socket.send(JSON.stringify({
          header: { event: 'result-generated' },
          payload: { output: { sentence: { text: '降级后仍可创建任务', sentence_end: true } } },
        }))
        socket.send(JSON.stringify({ header: { event: 'task-finished' } }))
      }
    })
  }, async (paraformerEndpoint) => {
    const session = createVoiceSession({
      primary: 'qwen-omni',
      fallback: 'paraformer',
      qwenOmni: {
        apiKey: 'test', workspaceId: 'test', region: 'cn-beijing', endpointOverride: omniEndpoint,
      },
      paraformer: {
        apiKey: 'test', workspaceId: 'test', region: 'cn-beijing', endpointOverride: paraformerEndpoint,
      },
    })
    await session.start()
    session.appendAudio(Buffer.alloc(640))
    const result = await session.finish()
    assert.deepEqual(result, {
      prompt: '降级后仍可创建任务', provider: 'paraformer', usedFallback: true,
    })
  })
})

console.log('PASS  Qwen Omni, Paraformer, and buffered fallback protocol tests')
