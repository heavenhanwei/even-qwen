import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { hostname, platform, release } from 'node:os'
import { join } from 'node:path'
import type { ToolName } from '@even-qwen/protocol'

export type ToolCall = { callId: string; responseId: string; name: ToolName; arguments: Record<string, unknown> }
export type ToolResult = { ok: boolean; result?: unknown; error?: string }

type AppId = 'chrome' | 'edge' | 'vscode' | 'terminal' | 'explorer' | 'codex'
type AppSpec = { id: AppId; name: string; executable?: string; processName: string; codex?: true }

const APPS: AppSpec[] = [
  { id: 'chrome', name: 'Chrome', executable: 'chrome.exe', processName: 'chrome' },
  { id: 'edge', name: 'Edge', executable: 'msedge.exe', processName: 'msedge' },
  { id: 'vscode', name: 'VS Code', executable: 'code.exe', processName: 'Code' },
  { id: 'terminal', name: 'Windows Terminal', executable: 'wt.exe', processName: 'WindowsTerminal' },
  { id: 'explorer', name: '文件资源管理器', executable: 'explorer.exe', processName: 'explorer' },
  { id: 'codex', name: 'Codex', processName: 'Codex', codex: true },
]

export const TOOL_CONFIRMATION: Record<ToolName, boolean> = {
  system_get_status: false,
  even_get_device_status: false,
  app_list: false,
  app_open: true,
  app_focus: true,
  browser_open_url: true,
  clipboard_read: true,
  clipboard_write: true,
}

export const QWEN_TOOLS = [
  definition('system_get_status', '读取 Even Qwen Agent 和当前电脑的基础状态。', {}),
  definition('even_get_device_status', '读取脱敏后的 Even G2 连接、电量、充电、佩戴和入盒状态。', {}),
  definition('app_list', '列出允许控制的应用及安装状态。', {}),
  definition('app_open', '打开允许列表中的应用。', { appId: enumString(APPS.map((app) => app.id)) }, ['appId']),
  definition('app_focus', '切换到已运行的允许列表应用。', { appId: enumString(APPS.map((app) => app.id)) }, ['appId']),
  definition('browser_open_url', '用默认浏览器打开 HTTP 或 HTTPS 地址。', { url: { type: 'string', maxLength: 2048 } }, ['url']),
  definition('clipboard_read', '读取剪贴板文本，最多 4096 字符。', {}),
  definition('clipboard_write', '写入剪贴板文本，最多 4096 字符。', { text: { type: 'string', maxLength: 4096 } }, ['text']),
]

function definition(name: ToolName, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}

function enumString(values: string[]) {
  return { type: 'string', enum: values }
}

function appSpec(value: unknown): AppSpec {
  const app = APPS.find((entry) => entry.id === value)
  if (!app) throw new Error('Unknown or disallowed appId')
  return app
}

function resolveExecutable(app: AppSpec): string | null {
  if (!app.executable) return null
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA || ''
  const candidates: Partial<Record<AppId, string[]>> = {
    chrome: [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    edge: [
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    vscode: [
      join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      join(programFiles, 'Microsoft VS Code', 'Code.exe'),
    ],
  }
  const fixed = (candidates[app.id] || []).find((candidate) => candidate && existsSync(candidate))
  if (fixed) return fixed
  const found = spawnSync('where.exe', [app.executable], { encoding: 'utf8', windowsHide: true })
  return found.status === 0 ? found.stdout.split(/\r?\n/).find(Boolean)?.trim() || null : null
}

function codexAppId(): string | null {
  if (process.platform !== 'win32') return null
  const script = "$app=Get-StartApps | Where-Object { $_.Name -eq 'Codex' -or $_.AppID -like 'OpenAI.Codex_*' } | Select-Object -First 1; if($app){$app.AppID}"
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 4000,
  })
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

export function listApps() {
  return APPS.map((app) => {
    const running = app.codex
      ? spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "if(Get-Process -Name codex -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0}){exit 0}else{exit 1}"], { windowsHide: true }).status === 0
      : spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${app.processName}.exe`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout?.toLowerCase().includes(`${app.processName.toLowerCase()}.exe`) ?? false
    return { appId: app.id, name: app.name, installed: app.codex ? Boolean(codexAppId()) : Boolean(resolveExecutable(app)), running }
  })
}

function run(command: string, args: string[], input?: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => resolve({ ok: false, error: error.message }))
    child.once('close', (code) => resolve(code === 0 ? { ok: true, result: stdout.trim() || { launched: true } } : { ok: false, error: stderr.trim() || `Process exited ${code}` }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

export function validateToolCall(name: string, args: unknown): ToolCall['arguments'] {
  if (!(name in TOOL_CONFIRMATION)) throw new Error('Unknown tool')
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object')
  const value = args as Record<string, unknown>
  const allowedKeys: Record<ToolName, string[]> = {
    system_get_status: [], even_get_device_status: [], app_list: [], app_open: ['appId'], app_focus: ['appId'],
    browser_open_url: ['url'], clipboard_read: [], clipboard_write: ['text'],
  }
  const unexpected = Object.keys(value).find((key) => !allowedKeys[name as ToolName].includes(key))
  if (unexpected) throw new Error(`Unexpected tool argument: ${unexpected}`)
  if (name === 'app_open' || name === 'app_focus') appSpec(value.appId)
  if (name === 'browser_open_url') {
    if (typeof value.url !== 'string' || value.url.length > 2048) throw new Error('Invalid URL')
    const url = new URL(value.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP/HTTPS URLs are allowed')
    if (url.username || url.password) throw new Error('URLs containing credentials are not allowed')
  }
  if (name === 'clipboard_write' && (typeof value.text !== 'string' || value.text.length > 4096)) throw new Error('Clipboard text must be at most 4096 characters')
  return value
}

export function approvalSummary(name: ToolName, args: Record<string, unknown>): string {
  if (name === 'app_open') return `打开 ${appSpec(args.appId).name}`
  if (name === 'app_focus') return `切换到 ${appSpec(args.appId).name}`
  if (name === 'browser_open_url') return `打开网址 ${new URL(String(args.url)).host}`
  if (name === 'clipboard_read') return '读取剪贴板（最多 4096 字符）'
  if (name === 'clipboard_write') return `写入剪贴板（${String(args.text).length} 字符）`
  return name
}

export function redactedArguments(name: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'clipboard_write') return { length: String(args.text).length }
  return args
}

export async function executeDesktopTool(name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'system_get_status') return { ok: true, result: { agent: 'ready', host: hostname(), platform: platform(), release: release() } }
  if (name === 'app_list') return { ok: true, result: listApps() }
  if (name === 'even_get_device_status') return { ok: false, error: 'This tool must execute on the Even client' }
  if (name === 'app_open') {
    const app = appSpec(args.appId)
    if (app.codex) {
      const id = codexAppId()
      if (!id) return { ok: false, error: 'Codex desktop app is not installed' }
      return run('explorer.exe', [`shell:AppsFolder\\${id}`])
    }
    const executable = resolveExecutable(app)
    if (!executable) return { ok: false, error: `${app.name} is not installed` }
    return run(executable, [])
  }
  if (name === 'app_focus') {
    const app = appSpec(args.appId)
    const script = `$ws=New-Object -ComObject WScript.Shell; if($ws.AppActivate('${app.processName}')){exit 0}else{exit 2}`
    return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script])
  }
  if (name === 'browser_open_url') return run('rundll32.exe', ['url.dll,FileProtocolHandler', String(args.url)])
  if (name === 'clipboard_read') {
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'])
    if (result.ok && typeof result.result === 'string') result.result = result.result.slice(0, 4096)
    return result
  }
  if (name === 'clipboard_write') {
    return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'], String(args.text))
  }
  return { ok: false, error: 'Unknown tool' }
}
