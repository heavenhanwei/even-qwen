import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import WebSocket from 'ws'

const targets = [
  { label: 'Even ChatGPT', url: 'wss://even-chatgpt.ifelse.work', envPath: process.argv[2] || '../even-chatgpt/.env', protocolVersion: 1 },
  { label: 'Even Qwen', url: 'wss://even-qwen.ifelse.work', envPath: process.argv[3] || '.env', protocolVersion: 2 },
]

async function check(target) {
  const environment = parse(await readFile(resolve(target.envPath), 'utf8'))
  return await new Promise((resolveCheck, reject) => {
    const socket = new WebSocket(target.url, { handshakeTimeout: 10_000 })
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('timeout')) }, 12_000)
    socket.once('open', () => socket.send(JSON.stringify(target.protocolVersion === 1
      ? { type: 'hello', protocolVersion: 1, clientVersion: 'public-agent-check', token: environment.AGENT_PAIRING_TOKEN }
      : { type: 'hello', protocolVersion: 2, conversationId: '', clientName: 'public-agent-check', token: environment.AGENT_PAIRING_TOKEN })))
    socket.once('message', (raw) => {
      clearTimeout(timeout)
      const message = JSON.parse(raw.toString())
      socket.close(1000, 'check complete')
      resolveCheck({ label: target.label, url: target.url, protocolVersion: target.protocolVersion, responseType: message.type, ready: message.type === 'ready' })
    })
    socket.once('error', (error) => { clearTimeout(timeout); reject(error) })
  })
}

const results = []
for (const target of targets) {
  try { results.push(await check(target)) }
  catch (error) { results.push({ label: target.label, url: target.url, ready: false, error: error.message }) }
}
console.log(JSON.stringify(results, null, 2))
if (results.some((result) => !result.ready)) process.exitCode = 1
