import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import WebSocket from 'ws'

const environment = parse(await readFile(resolve(process.argv[2] || '.env'), 'utf8'))
const socket = new WebSocket(`ws://127.0.0.1:${environment.AGENT_PORT}`, { handshakeTimeout: 4000 })
const requestId = () => crypto.randomUUID()
let conversationId = ''

const timeout = setTimeout(() => {
  console.error('Qwen realtime check timed out')
  socket.terminate()
  process.exitCode = 1
}, 25_000)

socket.once('open', () => socket.send(JSON.stringify({
  type: 'hello', protocolVersion: 2, conversationId: '', clientName: 'qwen-live-check', token: environment.AGENT_PAIRING_TOKEN,
})))

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString())
  if (message.type === 'ready') {
    socket.send(JSON.stringify({ type: 'conversation.create', protocolVersion: 2, conversationId: '', requestId: requestId() }))
    return
  }
  if (message.type === 'conversation.created') {
    conversationId = message.conversationId
    socket.send(JSON.stringify({ type: 'voice.mode.start', protocolVersion: 2, conversationId, requestId: requestId() }))
    return
  }
  if (message.type === 'voice.mode.status' && message.stage === 'listening') {
    console.log(JSON.stringify({ qwenRealtime: 'ready', model: environment.QWEN_OMNI_MODEL, port: Number(environment.AGENT_PORT) }))
    socket.send(JSON.stringify({ type: 'voice.mode.stop', protocolVersion: 2, conversationId, requestId: requestId() }))
    clearTimeout(timeout)
    socket.close(1000, 'check complete')
  }
  if (message.type === 'error') {
    clearTimeout(timeout)
    console.error(`Agent error: ${message.message}`)
    socket.close(1011, 'check failed')
    process.exitCode = 1
  }
})

socket.once('error', (error) => {
  clearTimeout(timeout)
  console.error(error.message)
  process.exitCode = 1
})
