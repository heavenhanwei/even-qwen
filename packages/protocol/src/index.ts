export const PROTOCOL_VERSION = 1 as const

export type ClientMessage =
  | {
      type: 'hello'
      protocolVersion: typeof PROTOCOL_VERSION
      clientVersion: string
      token?: string
    }
  | { type: 'ping'; requestId: string }
  | { type: 'account.status'; requestId: string }
  | { type: 'tasks.list'; requestId: string; limit?: number }
  | { type: 'tasks.read'; requestId: string; threadId: string }
  | {
      type: 'client.log'
      level: 'info' | 'warn' | 'error'
      message: string
      detail?: string
    }
  | { type: 'voice.start'; requestId: string; targetThreadId?: string }
  | { type: 'voice.stop'; requestId: string }
  | { type: 'voice.cancel'; requestId: string }
  | { type: 'task.stop'; requestId: string; threadId: string; turnId: string }

export type CodexThreadSummary = {
  id: string
  name?: string | null
  preview?: string
  parentThreadId?: string | null
  model?: string
  cwd?: string
  updatedAt?: number
  isPinned?: boolean
  status?: { type?: string; activeFlags?: string[] }
}

export type CodexThreadDetail = CodexThreadSummary & {
  turnCount: number
  latestUserMessage?: string
  latestAssistantMessage?: string
}

export type ServerMessage =
  | {
      type: 'ready'
      protocolVersion: typeof PROTOCOL_VERSION
      agentVersion: string
      codexReady: boolean
      tasks?: CodexThreadSummary[]
    }
  | { type: 'pong'; requestId: string; timestamp: number }
  | { type: 'account.status.result'; requestId: string; account: unknown }
  | {
      type: 'tasks.list.result'
      requestId: string
      tasks: CodexThreadSummary[]
      nextCursor?: string | null
    }
  | {
      type: 'tasks.read.result'
      requestId: string
      task: CodexThreadDetail
    }
  | { type: 'audio.ack'; bytesReceived: number }
  | {
      type: 'voice.caption'
      requestId: string
      text: string
      provider: 'qwen-omni' | 'paraformer'
    }
  | {
      type: 'voice.status'
      requestId: string
      stage:
        | 'connecting'
        | 'listening'
        | 'transcribing'
        | 'starting_task'
        | 'running'
        | 'stopping'
        | 'stopped'
        | 'cancelled'
        | 'completed'
        | 'error'
      message: string
      transcript?: string
      threadId?: string
      turnId?: string
      response?: string
    }
  | { type: 'codex.event'; method: string; params?: unknown }
  | { type: 'error'; requestId?: string; code: string; message: string }

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!value || typeof value !== 'object') return null

  const message = value as Record<string, unknown>
  if (typeof message.type !== 'string') return null

  switch (message.type) {
    case 'hello':
      if (message.protocolVersion !== PROTOCOL_VERSION || typeof message.clientVersion !== 'string') return null
      return {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: message.clientVersion,
        token: typeof message.token === 'string' ? message.token : undefined,
      }
    case 'ping':
    case 'account.status':
      if (typeof message.requestId !== 'string') return null
      return { type: message.type, requestId: message.requestId }
    case 'tasks.list':
      if (typeof message.requestId !== 'string') return null
      return {
        type: 'tasks.list',
        requestId: message.requestId,
        limit: typeof message.limit === 'number' ? message.limit : undefined,
      }
    case 'tasks.read':
      if (typeof message.requestId !== 'string' || typeof message.threadId !== 'string') return null
      return { type: 'tasks.read', requestId: message.requestId, threadId: message.threadId }
    case 'client.log':
      if (
        (message.level !== 'info' && message.level !== 'warn' && message.level !== 'error')
        || typeof message.message !== 'string'
      ) return null
      return {
        type: 'client.log',
        level: message.level,
        message: message.message.slice(0, 200),
        detail: typeof message.detail === 'string' ? message.detail.slice(0, 500) : undefined,
      }
    case 'voice.start':
      if (typeof message.requestId !== 'string') return null
      return {
        type: 'voice.start',
        requestId: message.requestId,
        targetThreadId: typeof message.targetThreadId === 'string' ? message.targetThreadId : undefined,
      }
    case 'voice.stop':
      if (typeof message.requestId !== 'string') return null
      return { type: 'voice.stop', requestId: message.requestId }
    case 'voice.cancel':
      if (typeof message.requestId !== 'string') return null
      return { type: 'voice.cancel', requestId: message.requestId }
    case 'task.stop':
      if (
        typeof message.requestId !== 'string'
        || typeof message.threadId !== 'string'
        || typeof message.turnId !== 'string'
      ) return null
      return {
        type: 'task.stop',
        requestId: message.requestId,
        threadId: message.threadId,
        turnId: message.turnId,
      }
    default:
      return null
  }
}

export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  return typeof message.type === 'string' ? (message as ServerMessage) : null
}

