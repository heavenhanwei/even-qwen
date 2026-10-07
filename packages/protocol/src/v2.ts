export const PROTOCOL_VERSION = 2 as const

export type ConversationRole = 'user' | 'assistant' | 'tool'

export type ConversationMessage = {
  id: string
  role: ConversationRole
  text: string
  createdAt: string
}

export type ConversationSummary = {
  id: string
  title: string
  preview: string
  createdAt: string
  updatedAt: string
}

export type DeviceStatusSnapshot = {
  connected: boolean
  batteryLevel?: number
  isCharging?: boolean
  isWearing?: boolean
  isInCase?: boolean
}

export type ToolName =
  | 'system_get_status'
  | 'even_get_device_status'
  | 'app_list'
  | 'app_open'
  | 'app_focus'
  | 'browser_open_url'
  | 'clipboard_read'
  | 'clipboard_write'

export type VoiceStage = 'connecting' | 'listening' | 'thinking' | 'responding' | 'idle' | 'stopped' | 'error'

type ClientEnvelope = { protocolVersion: typeof PROTOCOL_VERSION; conversationId: string }

export type ClientMessage =
  | (ClientEnvelope & { type: 'hello'; token?: string; clientName: string })
  | (ClientEnvelope & { type: 'ping'; requestId: string })
  | (ClientEnvelope & { type: 'conversation.list'; requestId: string })
  | (ClientEnvelope & { type: 'conversation.create'; requestId: string })
  | (ClientEnvelope & { type: 'conversation.open'; requestId: string })
  | (ClientEnvelope & { type: 'voice.mode.start'; requestId: string })
  | (ClientEnvelope & { type: 'voice.mode.stop'; requestId: string })
  | (ClientEnvelope & { type: 'response.cancel'; requestId: string; responseId?: string })
  | (ClientEnvelope & { type: 'tool.approval.resolve'; requestId: string; toolCallId: string; approved: boolean })
  | (ClientEnvelope & {
      type: 'client.tool.result'
      requestId: string
      toolCallId: string
      ok: boolean
      result?: unknown
      error?: string
    })
  | (ClientEnvelope & { type: 'device.status'; status: DeviceStatusSnapshot })
  | (ClientEnvelope & { type: 'client.log'; level: 'info' | 'warn' | 'error'; message: string })

export type ClientMessagePayload = ClientMessage extends infer T
  ? T extends ClientMessage ? Omit<T, 'protocolVersion' | 'conversationId'> : never
  : never

type ServerEnvelope = { protocolVersion: typeof PROTOCOL_VERSION; conversationId: string }

export type ServerMessage =
  | (ServerEnvelope & { type: 'ready'; qwenReady: boolean; conversations: ConversationSummary[] })
  | (ServerEnvelope & { type: 'pong'; requestId: string })
  | (ServerEnvelope & { type: 'conversation.list.result'; requestId: string; conversations: ConversationSummary[] })
  | (ServerEnvelope & { type: 'conversation.created'; requestId: string; conversation: ConversationSummary })
  | (ServerEnvelope & {
      type: 'conversation.open.result'
      requestId: string
      conversation: ConversationSummary
      messages: ConversationMessage[]
    })
  | (ServerEnvelope & { type: 'voice.mode.status'; stage: VoiceStage; detail?: string })
  | (ServerEnvelope & { type: 'speech.started'; responseId?: string })
  | (ServerEnvelope & { type: 'speech.stopped'; responseId?: string })
  | (ServerEnvelope & { type: 'transcript.delta'; responseId: string; delta: string })
  | (ServerEnvelope & { type: 'transcript.final'; responseId: string; text: string })
  | (ServerEnvelope & { type: 'assistant.delta'; responseId: string; delta: string })
  | (ServerEnvelope & { type: 'assistant.final'; responseId: string; text: string })
  | (ServerEnvelope & { type: 'assistant.cancelled'; responseId: string })
  | (ServerEnvelope & {
      type: 'tool.approval.request'
      requestId: string
      responseId: string
      toolCallId: string
      toolName: ToolName
      summary: string
      parameters: Record<string, unknown>
    })
  | (ServerEnvelope & {
      type: 'client.tool.request'
      requestId: string
      responseId: string
      toolCallId: string
      toolName: 'even_get_device_status'
    })
  | (ServerEnvelope & {
      type: 'tool.execution.result'
      requestId: string
      responseId: string
      toolCallId: string
      toolName: ToolName
      ok: boolean
      result?: unknown
      error?: string
    })
  | (ServerEnvelope & { type: 'device.status'; status: DeviceStatusSnapshot })
  | (ServerEnvelope & { type: 'audio.ack'; bytes: number })
  | (ServerEnvelope & { type: 'error'; code: string; message: string; requestId?: string })

export type ServerMessagePayload = ServerMessage extends infer T
  ? T extends ServerMessage ? Omit<T, 'protocolVersion'> : never
  : never

const CLIENT_TYPES = new Set([
  'hello', 'ping', 'conversation.list', 'conversation.create', 'conversation.open', 'voice.mode.start',
  'voice.mode.stop', 'response.cancel', 'tool.approval.resolve', 'client.tool.result', 'device.status', 'client.log',
])

export function parseClientMessage(raw: string): ClientMessage {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (parsed.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${String(parsed.protocolVersion)}`)
  if (typeof parsed.type !== 'string' || !CLIENT_TYPES.has(parsed.type)) throw new Error(`Unsupported client message: ${String(parsed.type)}`)
  if (typeof parsed.conversationId !== 'string') throw new Error('conversationId must be a string')
  return parsed as ClientMessage
}

export function makeServerMessage(message: ServerMessagePayload): ServerMessage {
  return { protocolVersion: PROTOCOL_VERSION, ...message } as ServerMessage
}
