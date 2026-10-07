import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import WebSocket from 'ws'

const [, , oldEnvArg = '../even-chatgpt/.env', newEnvArg = '.env'] = process.argv

async function check(label, envPath, protocolVersion) {
  const environment = parse(await readFile(resolve(envPath), 'utf8'))
  const port = Number(environment.AGENT_PORT)
  const token = environment.AGENT_PAIRING_TOKEN
  if (!Number.isInteger(port) || !token) throw new Error(`${label}: invalid local configuration`)

  return await new Promise((resolveCheck, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 4000 })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error(`${label}: handshake timed out on ${port}`))
    }, 6000)
    socket.once('open', () => {
      socket.send(JSON.stringify(protocolVersion === 1
        ? { type: 'hello', protocolVersion: 1, clientVersion: 'dual-agent-check', token }
        : { type: 'hello', protocolVersion: 2, conversationId: '', clientName: 'dual-agent-check', token }))
    })
    socket.once('message', (raw) => {
      clearTimeout(timer)
      const message = JSON.parse(raw.toString())
      socket.close(1000, 'check complete')
      resolveCheck({ label, port, protocolVersion, responseType: message.type, ready: message.type === 'ready' })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`${label}: ${error.message}`))
    })
  })
}

const results = []
for (const target of [
  ['Even ChatGPT', oldEnvArg, 1],
  ['Even Qwen', newEnvArg, 2],
]) {
  try {
    results.push(await check(...target))
  } catch (error) {
    results.push({ label: target[0], port: Number(parse(await readFile(resolve(target[1]), 'utf8')).AGENT_PORT), ready: false, error: error.message })
  }
}

console.log(JSON.stringify(results, null, 2))
if (results.some((result) => !result.ready)) process.exitCode = 1
