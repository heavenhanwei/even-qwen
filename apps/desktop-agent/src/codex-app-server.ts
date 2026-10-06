import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

type JsonRpcId = number

type JsonRpcResponse = {
  id?: JsonRpcId
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
  params?: unknown
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

type CodexLaunch = {
  command: string
  args: string[]
  source: string
}

const appServerArgs = ['app-server', '--listen', 'stdio://']

function resolveCodexLaunch(): CodexLaunch {
  const configuredPath = process.env.CODEX_CLI_PATH?.trim()
  if (configuredPath) {
    if (configuredPath.endsWith('.js')) {
      return {
        command: process.execPath,
        args: [configuredPath, ...appServerArgs],
        source: 'CODEX_CLI_PATH JavaScript entrypoint',
      }
    }

    return {
      command: configuredPath,
      args: appServerArgs,
      source: 'CODEX_CLI_PATH executable',
    }
  }

  // A global npm install exposes codex.cmd on Windows. Node's spawn() does not
  // resolve .cmd shims without a shell, so launch the package entrypoint with
  // the current Node executable instead.
  if (process.platform === 'win32' && process.env.APPDATA) {
    const npmEntrypoint = join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    )

    if (existsSync(npmEntrypoint)) {
      return {
        command: process.execPath,
        args: [npmEntrypoint, ...appServerArgs],
        source: 'global npm installation',
      }
    }
  }

  return { command: 'codex', args: appServerArgs, source: 'PATH' }
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<JsonRpcId, PendingRequest>()
  private notificationHandlers = new Set<(method: string, params: unknown) => void>()
  private readyPromise: Promise<void> | null = null

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.startProcess()
    return this.readyPromise
  }

  private async startProcess() {
    const launch = resolveCodexLaunch()
    const child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.process = child
    console.log(`Starting Codex app-server via ${launch.source}`)

    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    child.on('error', (error) => {
      this.failPending(`codex app-server failed to start: ${error.message}`)
      if (this.process === child) this.process = null
      this.readyPromise = null
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message) console.error(`[codex] ${message}`)
    })

    child.once('exit', (code, signal) => {
      const reason = `codex app-server exited (code=${code ?? 'none'}, signal=${signal ?? 'none'})`
      this.failPending(reason)
      if (this.process === child) this.process = null
      this.readyPromise = null
    })

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.handleLine(line))

    await spawned
    await this.request('initialize', {
      clientInfo: {
        name: 'even_chatgpt',
        title: 'Even ChatGPT',
        version: '0.1.0',
      },
    })
    this.notify('initialized', {})
  }

  private failPending(reason: string) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(new Error(reason))
    }
    this.pending.clear()
  }

  onNotification(handler: (method: string, params: unknown) => void) {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.process
    if (!child) return Promise.reject(new Error('codex app-server is not running'))

    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex request timed out: ${method}`))
      }, 15_000)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      child.stdin.write(`${JSON.stringify({ method, id, params: params ?? {} })}\n`)
    })
  }

  notify(method: string, params?: unknown) {
    if (!this.process) throw new Error('codex app-server is not running')
    this.process.stdin.write(`${JSON.stringify({ method, params: params ?? {} })}\n`)
  }

  async accountStatus() {
    return this.request('account/read', { refreshToken: false })
  }

  async listThreads(limit = 10) {
    return this.request<{
      data?: unknown[]
      nextCursor?: string | null
    }>('thread/list', {
      cursor: null,
      limit: Math.min(Math.max(limit, 1), 25),
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: [
        'cli',
        'vscode',
        'exec',
        'appServer',
        'subAgent',
        'subAgentReview',
        'subAgentCompact',
        'subAgentThreadSpawn',
        'subAgentOther',
        'unknown',
      ],
    })
  }

  async readThread(threadId: string) {
    return this.request<{ thread: unknown }>('thread/read', {
      threadId,
      includeTurns: true,
    })
  }

  async startThread(options: {
    cwd: string
    model?: string
    sandbox: 'read-only' | 'workspace-write'
  }) {
    return this.request<{
      thread: { id: string }
      model: string
    }>('thread/start', {
      cwd: options.cwd,
      model: options.model || null,
      sandbox: options.sandbox,
      approvalPolicy: 'never',
      ephemeral: false,
    })
  }

  async resumeThread(threadId: string, sandbox: 'read-only' | 'workspace-write') {
    return this.request<{ thread: { id: string } }>('thread/resume', {
      threadId,
      sandbox,
      approvalPolicy: 'never',
      excludeTurns: true,
    })
  }

  async startTurn(threadId: string, text: string) {
    return this.request<{ turn: { id: string; status: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      turnTrigger: 'even-g2-voice',
    })
  }

  async interruptTurn(threadId: string, turnId: string) {
    return this.request<Record<string, never>>('turn/interrupt', { threadId, turnId })
  }

  async close() {
    const child = this.process
    this.process = null
    this.readyPromise = null
    if (!child || child.killed) return

    child.kill()
  }

  private handleLine(line: string) {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      console.error('[codex] Ignored non-JSON output')
      return
    }

    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id)
      if (!request) return

      clearTimeout(request.timeout)
      this.pending.delete(message.id)

      if (message.error) {
        request.reject(new Error(message.error.message || `Codex error ${message.error.code ?? 'unknown'}`))
      } else {
        request.resolve(message.result)
      }
      return
    }

    if (message.method) {
      for (const handler of this.notificationHandlers) {
        handler(message.method, message.params)
      }
    }
  }
}

