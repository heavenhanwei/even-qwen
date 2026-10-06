import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { WebSocket, WebSocketServer } from 'ws'
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type CodexThreadDetail,
  type CodexThreadSummary,
  type ServerMessage,
} from '@even-chatgpt/protocol'
import { CodexAppServerClient } from './codex-app-server.js'
import {
  createVoiceSession,
  normalizeVoiceProvider,
  type VoiceSession,
} from './voice-provider.js'

loadEnv({ path: resolve(process.cwd(), '.env') })
loadEnv({ path: resolve(process.cwd(), '../../.env'), override: false })

const host = process.env.AGENT_BIND_HOST || '127.0.0.1'
const port = Number(process.env.AGENT_PORT || 8787)
const pairingToken = process.env.AGENT_PAIRING_TOKEN || ''
const voiceProvider = normalizeVoiceProvider(process.env.VOICE_PROVIDER)
const voiceFallbackProvider = process.env.VOICE_FALLBACK_PROVIDER?.trim().toLowerCase() === 'none'
  ? null
  : normalizeVoiceProvider(process.env.VOICE_FALLBACK_PROVIDER)
const codexWorkspace = resolve(process.env.CODEX_WORKSPACE || process.cwd())
const codexSandbox = process.env.CODEX_SANDBOX_MODE === 'workspace-write'
  ? 'workspace-write'
  : 'read-only'
const codexModel = process.env.CODEX_MODEL?.trim() || undefined

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid AGENT_PORT: ${process.env.AGENT_PORT}`)
}

const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
if (!isLoopback && pairingToken.length < 24) {
  throw new Error('AGENT_PAIRING_TOKEN must contain at least 24 characters before binding to a non-loopback address')
}

const codex = new CodexAppServerClient()
let codexReady = false

try {
  await codex.start()
  codexReady = true
  console.log('Codex app-server initialized')
} catch (error) {
  console.error('Codex app-server unavailable:', error)
}

const server = new WebSocketServer({ host, port })

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

function broadcast(message: ServerMessage) {
  for (const client of server.clients) {
    send(client, message)
  }
}

async function listUserTasks(limit: number) {
  const requestedLimit = Math.min(Math.max(limit, 1), 8)
  const result = await codex.listThreads(Math.min(requestedLimit * 3, 25))
  return {
    tasks: ((result.data || []) as CodexThreadSummary[])
      .filter((task) => !task.parentThreadId && task.model !== 'codex-auto-review')
      .slice(0, requestedLimit),
    nextCursor: result.nextCursor,
  }
}

type ActiveTurn = {
  socket: WebSocket
  requestId: string
  threadId: string
  turnId: string
  transcript: string
  response: string
  lastProgressAt: number
}

const activeTurns = new Map<string, ActiveTurn>()

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function summarizeThreadDetail(value: unknown): CodexThreadDetail {
  const thread = asRecord(value)
  if (!thread || typeof thread.id !== 'string') throw new Error('Codex returned an invalid thread')

  const turns = Array.isArray(thread.turns) ? thread.turns : []
  let latestUserMessage: string | undefined
  let latestAssistantMessage: string | undefined

  for (const turnValue of turns) {
    const turn = asRecord(turnValue)
    const items = Array.isArray(turn?.items) ? turn.items : []
    for (const itemValue of items) {
      const item = asRecord(itemValue)
      if (item?.type === 'userMessage' && Array.isArray(item.content)) {
        const text = item.content
          .map((part) => optionalString(asRecord(part)?.text))
          .filter((part): part is string => Boolean(part))
          .join('\n')
          .trim()
        if (text) latestUserMessage = text.slice(0, 600)
      }
      if (item?.type === 'agentMessage') {
        const text = optionalString(item.text)?.trim()
        if (text) latestAssistantMessage = text.slice(0, 600)
      }
    }
  }

  return {
    id: thread.id,
    name: typeof thread.name === 'string' || thread.name === null ? thread.name : undefined,
    preview: optionalString(thread.preview),
    parentThreadId: typeof thread.parentThreadId === 'string' || thread.parentThreadId === null
      ? thread.parentThreadId
      : undefined,
    model: optionalString(thread.model),
    cwd: optionalString(thread.cwd),
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined,
    isPinned: typeof thread.isPinned === 'boolean' ? thread.isPinned : undefined,
    status: asRecord(thread.status) as CodexThreadSummary['status'] || undefined,
    turnCount: turns.length,
    latestUserMessage,
    latestAssistantMessage,
  }
}

codex.onNotification((method, params) => {
  broadcast({ type: 'codex.event', method, params })

  const value = asRecord(params)
  const turnId = typeof value?.turnId === 'string'
    ? value.turnId
    : typeof asRecord(value?.turn)?.id === 'string'
      ? asRecord(value?.turn)?.id as string
      : undefined
  if (!turnId) return

  const active = activeTurns.get(turnId)
  if (!active) return

  if (method === 'item/agentMessage/delta' && typeof value?.delta === 'string') {
    active.response = `${active.response}${value.delta}`.slice(-8_000)
    const now = Date.now()
    if (now - active.lastProgressAt >= 500) {
      active.lastProgressAt = now
      send(active.socket, {
        type: 'voice.status',
        requestId: active.requestId,
        stage: 'running',
        message: 'Codex 正在执行任务',
        transcript: active.transcript,
        threadId: active.threadId,
        turnId: active.turnId,
        response: active.response,
      })
    }
    return
  }

  if (method === 'turn/completed') {
    const status = asRecord(value?.turn)?.status
    const completed = status === 'completed'
    const interrupted = status === 'interrupted'
    send(active.socket, {
      type: 'voice.status',
      requestId: active.requestId,
      stage: completed ? 'completed' : interrupted ? 'stopped' : 'error',
      message: completed
        ? 'Codex 任务已完成'
        : interrupted
          ? 'Codex 任务已停止'
          : `Codex 任务未完成：${String(status || 'unknown')}`,
      transcript: active.transcript,
      threadId: active.threadId,
      turnId: active.turnId,
      response: active.response,
    })
    activeTurns.delete(turnId)
  }
})

server.on('connection', (socket) => {
  let authenticated = false
  let bytesReceived = 0
  let voiceSession: {
    requestId: string
    targetThreadId?: string
    voice: VoiceSession
    disposeTranscript: () => void
  } | null = null

  socket.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (!authenticated) {
        socket.close(1008, 'Authenticate first')
        return
      }

      const audio = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data)
      bytesReceived += audio.byteLength
      try {
        voiceSession?.voice.appendAudio(audio)
      } catch (error) {
        voiceSession?.disposeTranscript()
        voiceSession?.voice.close()
        const requestId = voiceSession?.requestId || 'voice'
        voiceSession = null
        send(socket, {
          type: 'voice.status',
          requestId,
          stage: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      send(socket, { type: 'audio.ack', bytesReceived })
      return
    }

    let rawMessage: unknown
    try {
      rawMessage = JSON.parse(data.toString())
    } catch {
      send(socket, { type: 'error', code: 'invalid_json', message: 'Message is not valid JSON' })
      return
    }

    const message = parseClientMessage(rawMessage)
    if (!message) {
      send(socket, { type: 'error', code: 'invalid_message', message: 'Unsupported protocol message' })
      return
    }

    if (message.type === 'hello') {
      if (pairingToken && message.token !== pairingToken) {
        socket.close(1008, 'Invalid pairing token')
        return
      }

      authenticated = true
      console.log(`Authenticated G2 client ${message.clientVersion}`)
      let initialTasks: CodexThreadSummary[] | undefined
      if (codexReady) {
        try {
          initialTasks = (await listUserTasks(8)).tasks
          console.log(`Included ${initialTasks.length} Codex tasks in ready handshake`)
        } catch (error) {
          console.error('Unable to include initial Codex tasks:', error)
        }
      }
      send(socket, {
        type: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        agentVersion: '0.1.0',
        codexReady,
        tasks: initialTasks,
      })
      return
    }

    if (!authenticated) {
      socket.close(1008, 'Authenticate first')
      return
    }

    try {
      switch (message.type) {
        case 'client.log': {
          const detail = message.detail ? ` | ${message.detail}` : ''
          const line = `[g2:${message.level}] ${message.message}${detail}`
          if (message.level === 'error') console.error(line)
          else if (message.level === 'warn') console.warn(line)
          else console.log(line)
          break
        }
        case 'ping':
          send(socket, { type: 'pong', requestId: message.requestId, timestamp: Date.now() })
          break
        case 'account.status': {
          const account = await codex.accountStatus()
          send(socket, { type: 'account.status.result', requestId: message.requestId, account })
          break
        }
        case 'tasks.list': {
          const result = await listUserTasks(message.limit ?? 8)
          const tasks = result.tasks
          console.log(`Returned ${tasks.length} user-facing Codex tasks`)
          send(socket, {
            type: 'tasks.list.result',
            requestId: message.requestId,
            tasks,
            nextCursor: result.nextCursor,
          })
          break
        }
        case 'tasks.read': {
          const result = await codex.readThread(message.threadId)
          const task = summarizeThreadDetail(result.thread)
          console.log(`Returned Codex task detail ${task.id} (${task.turnCount} turns)`)
          send(socket, {
            type: 'tasks.read.result',
            requestId: message.requestId,
            task,
          })
          break
        }
        case 'voice.start': {
          console.log(`Received voice.start ${message.requestId}`)
          if (voiceSession) {
            send(socket, {
              type: 'voice.status',
              requestId: message.requestId,
              stage: 'error',
              message: '已有语音会话正在进行',
            })
            break
          }

          const apiKey = process.env.DASHSCOPE_API_KEY?.trim()
          const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID?.trim()
          const region = process.env.DASHSCOPE_REGION === 'ap-southeast-1'
            ? 'ap-southeast-1'
            : 'cn-beijing'
          if (!voiceProvider || !apiKey || !workspaceId) {
            send(socket, {
              type: 'voice.status',
              requestId: message.requestId,
              stage: 'error',
              message: '请在桌面 Agent 的 .env 配置 VOICE_PROVIDER、DASHSCOPE_API_KEY 和 DASHSCOPE_WORKSPACE_ID',
            })
            break
          }

          const voice = createVoiceSession({
            primary: voiceProvider,
            fallback: voiceFallbackProvider || undefined,
            qwenOmni: {
              apiKey,
              workspaceId,
              region,
              model: process.env.QWEN_OMNI_MODEL?.trim() || undefined,
            },
            paraformer: {
              apiKey,
              workspaceId,
              region,
              model: process.env.PARAFORMER_MODEL?.trim() || undefined,
              languageHints: process.env.PARAFORMER_LANGUAGE_HINTS
                ?.split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            },
          })
          const disposeTranscript = voice.onTranscript((text) => {
            const normalized = text.trim()
            if (!normalized || voiceSession?.requestId !== message.requestId) return
            send(socket, {
              type: 'voice.caption',
              requestId: message.requestId,
              text: normalized.slice(-1200),
              provider: voice.activeProvider,
            })
          })
          voiceSession = {
            requestId: message.requestId,
            targetThreadId: message.targetThreadId,
            voice,
            disposeTranscript,
          }
          send(socket, {
            type: 'voice.status',
            requestId: message.requestId,
            stage: 'connecting',
            message: `正在连接语音服务：${voiceProvider}`,
          })
          try {
            console.log(`Starting voice session ${message.requestId} with ${voiceProvider}`)
            await voice.start()
            if (voiceSession?.requestId !== message.requestId) {
              voice.close()
              console.log(`Voice session ${message.requestId} was cancelled while connecting`)
              break
            }
            console.log(`Voice session ${message.requestId} is listening via ${voice.activeProvider}`)
            send(socket, {
              type: 'voice.status',
              requestId: message.requestId,
              stage: 'listening',
              message: `请开始说话，再次单击结束（${voice.activeProvider}）`,
            })
          } catch (error) {
            disposeTranscript()
            voice.close()
            if (voiceSession?.requestId === message.requestId) voiceSession = null
            send(socket, {
              type: 'voice.status',
              requestId: message.requestId,
              stage: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
          }
          break
        }
        case 'voice.cancel': {
          const session = voiceSession
          if (session?.requestId === message.requestId) {
            voiceSession = null
            session.disposeTranscript()
            session.voice.close()
            console.log(`Cancelled voice session ${message.requestId}`)
          }
          send(socket, {
            type: 'voice.status',
            requestId: message.requestId,
            stage: 'cancelled',
            message: '语音输入已取消',
          })
          break
        }
        case 'voice.stop': {
          const session = voiceSession
          if (!session) {
            send(socket, {
              type: 'voice.status',
              requestId: message.requestId,
              stage: 'error',
              message: '当前没有语音会话',
            })
            break
          }

          voiceSession = null
          send(socket, {
            type: 'voice.status',
            requestId: session.requestId,
            stage: 'transcribing',
            message: `${session.voice.activeProvider} 正在处理语音`,
          })
          try {
            const voiceResult = await session.voice.finish()
            const transcript = voiceResult.prompt
            send(socket, {
              type: 'voice.status',
              requestId: session.requestId,
              stage: 'starting_task',
              message: `${session.targetThreadId ? '正在继续 Codex 任务' : '正在创建 Codex 任务'}（${voiceResult.provider}${voiceResult.usedFallback ? '，已降级' : ''}）`,
              transcript,
            })

            let threadId = session.targetThreadId
            if (threadId) {
              await codex.resumeThread(threadId, codexSandbox)
            } else {
              const created = await codex.startThread({
                cwd: codexWorkspace,
                model: codexModel,
                sandbox: codexSandbox,
              })
              threadId = created.thread.id
            }

            const started = await codex.startTurn(threadId, transcript)
            const active: ActiveTurn = {
              socket,
              requestId: session.requestId,
              threadId,
              turnId: started.turn.id,
              transcript,
              response: '',
              lastProgressAt: 0,
            }
            activeTurns.set(active.turnId, active)
            send(socket, {
              type: 'voice.status',
              requestId: session.requestId,
              stage: 'running',
              message: session.targetThreadId ? 'Codex 正在继续任务' : 'Codex 新任务已创建',
              transcript,
              threadId,
              turnId: active.turnId,
            })
          } catch (error) {
            session.voice.close()
            send(socket, {
              type: 'voice.status',
              requestId: session.requestId,
              stage: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
          } finally {
            session.disposeTranscript()
          }
          break
        }
        case 'task.stop': {
          const active = activeTurns.get(message.turnId)
          if (!active || active.socket !== socket || active.threadId !== message.threadId) {
            send(socket, {
              type: 'error',
              requestId: message.requestId,
              code: 'turn_not_active',
              message: '当前 Codex 任务已结束或不属于此设备会话',
            })
            break
          }

          send(socket, {
            type: 'voice.status',
            requestId: active.requestId,
            stage: 'stopping',
            message: '正在停止 Codex 任务',
            transcript: active.transcript,
            threadId: active.threadId,
            turnId: active.turnId,
            response: active.response,
          })
          console.log(`Interrupting Codex turn ${active.turnId} for G2 client`)
          await codex.interruptTurn(active.threadId, active.turnId)
          break
        }
      }
    } catch (error) {
      send(socket, {
        type: 'error',
        requestId: 'requestId' in message ? message.requestId : undefined,
        code: 'codex_request_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  socket.once('close', () => {
    voiceSession?.disposeTranscript()
    voiceSession?.voice.close()
    voiceSession = null
  })
})

server.on('listening', () => {
  console.log(`Even ChatGPT desktop agent listening on ws://${host}:${port}`)
})

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down`)
  server.close()
  await codex.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

