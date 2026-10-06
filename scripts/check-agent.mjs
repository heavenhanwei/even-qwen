import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import WebSocket from 'ws'

loadEnv({ path: resolve(process.cwd(), '.env'), quiet: true })

const url = process.env.AGENT_SMOKE_URL || 'ws://127.0.0.1:8787'
const socket = new WebSocket(url)
const timeout = setTimeout(() => {
  console.error('FAIL  Agent protocol: timed out')
  socket.terminate()
  process.exitCode = 1
}, 15_000)

socket.once('open', () => {
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    clientVersion: 'smoke-test',
    token: process.env.AGENT_PAIRING_TOKEN || undefined,
  }))
})

socket.on('message', (data) => {
  const message = JSON.parse(data.toString())
  if (message.type === 'ready') {
    console.log(`PASS  Agent handshake: codexReady=${Boolean(message.codexReady)}`)
    socket.send(JSON.stringify({ type: 'account.status', requestId: 'account' }))
    return
  }
  if (message.type === 'account.status.result') {
    const account = message.account?.account ?? message.account
    console.log(`PASS  Codex account/read: accountPresent=${Boolean(account)}`)
    socket.send(JSON.stringify({ type: 'tasks.list', requestId: 'tasks', limit: 8 }))
    return
  }
  if (message.type === 'tasks.list.result') {
    const active = message.tasks.filter((task) =>
      task.status?.type === 'active' || (task.status?.activeFlags?.length || 0) > 0,
    ).length
    console.log(`PASS  Codex thread/list: ${message.tasks.length} user-facing task(s), ${active} active`)
    clearTimeout(timeout)
    socket.close(1000, 'Smoke test complete')
    return
  }
  if (message.type === 'error') {
    console.error(`FAIL  Agent protocol: ${message.code}: ${message.message}`)
    clearTimeout(timeout)
    socket.close()
    process.exitCode = 1
  }
})

socket.once('error', (error) => {
  console.error(`FAIL  Agent connection: ${error.message}`)
  clearTimeout(timeout)
  process.exitCode = 1
})
