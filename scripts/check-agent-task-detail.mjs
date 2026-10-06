import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import WebSocket from 'ws'

loadEnv({ path: resolve(process.cwd(), '.env'), quiet: true })

const url = process.env.AGENT_SMOKE_URL || 'ws://127.0.0.1:8787'
const socket = new WebSocket(url)
const timeout = setTimeout(() => {
  console.error('FAIL  Agent task detail timed out')
  socket.terminate()
  process.exitCode = 1
}, 20_000)

socket.once('open', () => {
  socket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    clientVersion: 'task-detail-check',
    token: process.env.AGENT_PAIRING_TOKEN || undefined,
  }))
})

socket.on('message', (data) => {
  const message = JSON.parse(data.toString())
  if (message.type === 'ready') {
    socket.send(JSON.stringify({ type: 'tasks.list', requestId: 'tasks', limit: 8 }))
    return
  }
  if (message.type === 'tasks.list.result') {
    const task = message.tasks[0]
    if (!task) throw new Error('No Codex history task is available')
    socket.send(JSON.stringify({ type: 'tasks.read', requestId: 'detail', threadId: task.id }))
    return
  }
  if (message.type === 'tasks.read.result') {
    const task = message.task
    console.log(`PASS  Task detail: turns=${task.turnCount}, user=${Boolean(task.latestUserMessage)}, assistant=${Boolean(task.latestAssistantMessage)}`)
    clearTimeout(timeout)
    socket.close(1000, 'Task detail check complete')
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
