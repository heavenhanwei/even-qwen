import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import WebSocket from 'ws'

loadEnv({ path: resolve(process.cwd(), '.env'), quiet: true })

const url = process.env.AGENT_SMOKE_URL || 'ws://127.0.0.1:8787'
const requestId = `voice-start-check-${Date.now()}`
const socket = new WebSocket(url)
let receivedConnecting = false

const timeout = setTimeout(() => {
  console.error(`FAIL  Agent voice start timed out; connectingReceived=${receivedConnecting}`)
  socket.terminate()
  process.exitCode = 1
}, 20_000)

socket.once('open', () => {
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    clientVersion: 'voice-start-check',
    token: process.env.AGENT_PAIRING_TOKEN || undefined,
  }))
})

socket.on('message', (data) => {
  const message = JSON.parse(data.toString())
  if (message.type === 'ready') {
    socket.send(JSON.stringify({ type: 'voice.start', requestId }))
    return
  }
  if (message.type === 'voice.status' && message.requestId === requestId) {
    console.log(`INFO  ${message.stage}: ${message.message}`)
    if (message.stage === 'connecting') receivedConnecting = true
    if (message.stage === 'listening') {
      console.log('PASS  Agent voice session reached listening')
      clearTimeout(timeout)
      socket.close(1000, 'Voice start check complete')
    }
    if (message.stage === 'error') {
      console.error(`FAIL  Agent voice start: ${message.message}`)
      clearTimeout(timeout)
      socket.close()
      process.exitCode = 1
    }
  }
})

socket.once('error', (error) => {
  console.error(`FAIL  Agent connection: ${error.message}`)
  clearTimeout(timeout)
  process.exitCode = 1
})
