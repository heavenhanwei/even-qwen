import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationMessage, ConversationSummary } from '@even-qwen/protocol'

type PersistedConversation = ConversationSummary & { messages: ConversationMessage[] }

const MAX_CONVERSATIONS = 50
const MAX_REPLAY_MESSAGES = 20
const MAX_REPLAY_CHARS = 32_000

function defaultDataDirectory(): string {
  const local = process.env.LOCALAPPDATA
  if (!local) throw new Error('LOCALAPPDATA is required; set EVEN_QWEN_DATA_DIR to override it')
  return join(local, 'EvenQwen', 'sessions')
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 32_000)
}

function titleFrom(text: string): string {
  return cleanText(text).replace(/\s+/g, ' ').slice(0, 42) || '新会话'
}

export class ConversationStore {
  readonly directory: string

  constructor(directory = process.env.EVEN_QWEN_DATA_DIR || defaultDataDirectory()) {
    this.directory = directory
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  private pathFor(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid conversation id')
    return join(this.directory, `${id}.json`)
  }

  private async read(id: string): Promise<PersistedConversation> {
    const parsed = JSON.parse(await readFile(this.pathFor(id), 'utf8')) as PersistedConversation
    if (parsed.id !== id || !Array.isArray(parsed.messages)) throw new Error('Invalid conversation file')
    return parsed
  }

  private async write(value: PersistedConversation): Promise<void> {
    await writeFile(this.pathFor(value.id), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  async list(): Promise<ConversationSummary[]> {
    await this.initialize()
    const entries = (await readdir(this.directory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    const values = await Promise.all(entries.map(async (name) => {
      try {
        const item = await this.read(name.slice(0, -5))
        return this.summary(item)
      } catch {
        return null
      }
    }))
    return values.filter((value): value is ConversationSummary => Boolean(value)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async create(): Promise<ConversationSummary> {
    await this.initialize()
    const now = new Date().toISOString()
    const value: PersistedConversation = {
      id: randomUUID(), title: '新会话', preview: '', createdAt: now, updatedAt: now, messages: [],
    }
    await this.write(value)
    await this.prune()
    return this.summary(value)
  }

  async open(id: string): Promise<{ conversation: ConversationSummary; messages: ConversationMessage[] }> {
    const value = await this.read(id)
    return { conversation: this.summary(value), messages: value.messages }
  }

  async append(id: string, role: ConversationMessage['role'], text: string): Promise<ConversationMessage> {
    const value = await this.read(id)
    const safe = cleanText(text)
    const message: ConversationMessage = { id: randomUUID(), role, text: safe, createdAt: new Date().toISOString() }
    value.messages.push(message)
    value.updatedAt = message.createdAt
    value.preview = safe.replace(/\s+/g, ' ').slice(0, 80)
    if (value.title === '新会话' && role === 'user') value.title = titleFrom(safe)
    await this.write(value)
    return message
  }

  async replay(id: string): Promise<ConversationMessage[]> {
    const messages = (await this.read(id)).messages.slice(-MAX_REPLAY_MESSAGES)
    const result: ConversationMessage[] = []
    let chars = 0
    for (const message of messages.reverse()) {
      if (chars + message.text.length > MAX_REPLAY_CHARS) break
      chars += message.text.length
      result.unshift(message)
    }
    return result
  }

  private summary(value: PersistedConversation): ConversationSummary {
    const { id, title, preview, createdAt, updatedAt } = value
    return { id, title, preview, createdAt, updatedAt }
  }

  private async prune(): Promise<void> {
    const values = await this.list()
    await Promise.all(values.slice(MAX_CONVERSATIONS).map((value) => unlink(this.pathFor(value.id))))
  }
}
