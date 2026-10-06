import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { config as loadEnv } from 'dotenv'
import WebSocket from 'ws'

loadEnv({ path: resolve(process.cwd(), '.env'), quiet: true })

const audioPath = process.argv[2]
const url = process.env.AGENT_SMOKE_URL || 'ws://127.0.0.1:8787'
if (!audioPath) throw new Error('Usage: node scripts/test-agent-live.mjs <16-kHz-mono-PCM.wav>')

function readPcmData(wave) {
  let offset = 12
  while (offset + 8 <= wave.length) {
    const id = wave.toString('ascii', offset, offset + 4)
    const size = wave.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'data') return wave.subarray(body, body + size)
    offset = body + size + (size % 2)
  }
  throw new Error('WAVE data chunk not found')
}

const pcm = readPcmData(await readFile(audioPath))
const socket = new WebSocket(url)
let streaming = false
let completed = false

const timeout = setTimeout(() => {
  console.error('FAIL  End-to-end voice task timed out')
  socket.terminate()
  process.exitCode = 1
}, 180_000)

socket.once('open', () => {
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    clientVersion: 'live-voice-test',
    token: process.env.AGENT_PAIRING_TOKEN || undefined,
  }))
})

socket.on('message', async (data) => {
  const message = JSON.parse(data.toString())
  if (message.type === 'ready') {
    socket.send(JSON.stringify({ type: 'voice.start', requestId: 'live-voice-test' }))
    return
  }
  if (message.type === 'voice.status') {
    console.log(`INFO  ${message.stage}: ${message.message}`)
    if (message.stage === 'listening' && !streaming) {
      streaming = true
      for (let offset = 0; offset < pcm.length; offset += 3_200) {
        socket.send(pcm.subarray(offset, Math.min(offset + 3_200, pcm.length)))
        await delay(100)
      }
      socket.send(JSON.stringify({ type: 'voice.stop', requestId: 'live-voice-stop' }))
      return
    }
    if (message.stage === 'completed') {
      completed = true
      console.log(`PASS  Voice-to-Codex task completed: thread=${message.threadId}, turn=${message.turnId}`)
      clearTimeout(timeout)
      socket.close(1000, 'End-to-end test complete')
      return
    }
    if (message.stage === 'error') {
      console.error(`FAIL  Voice-to-Codex task: ${message.message}`)
      clearTimeout(timeout)
      socket.close()
      process.exitCode = 1
    }
  }
  if (message.type === 'error') {
    console.error(`FAIL  Agent protocol: ${message.code}: ${message.message}`)
    clearTimeout(timeout)
    socket.close()
    process.exitCode = 1
  }
})

socket.once('close', () => {
  if (!completed && process.exitCode !== 1) process.exitCode = 1
})

socket.once('error', (error) => {
  console.error(`FAIL  Agent connection: ${error.message}`)
  clearTimeout(timeout)
  process.exitCode = 1
})
