import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { CodexAppServerClient } from './codex-app-server.js'
import { normalizeVoiceProvider } from './voice-provider.js'

loadEnv({ path: resolve(process.cwd(), '.env') })
loadEnv({ path: resolve(process.cwd(), '../../.env'), override: false })

type CommandCheck = {
  label: string
  command: string
  args: string[]
  windowsCmdShim?: boolean
}

const configuredCodexPath = process.env.CODEX_CLI_PATH?.trim()
const codexCommand = configuredCodexPath?.endsWith('.js') ? process.execPath : configuredCodexPath || 'codex'
const codexPrefixArgs = configuredCodexPath?.endsWith('.js') ? [configuredCodexPath] : []
const codexNeedsShim = !configuredCodexPath

const commands: CommandCheck[] = [
  { label: 'Node.js', command: 'node', args: ['--version'] },
  { label: 'EvenHub CLI', command: 'evenhub', args: ['--version'], windowsCmdShim: true },
  { label: 'EvenHub Simulator', command: 'evenhub-simulator', args: ['--version'], windowsCmdShim: true },
  { label: 'Codex CLI', command: codexCommand, args: [...codexPrefixArgs, '--version'], windowsCmdShim: codexNeedsShim },
]

function run(check: CommandCheck) {
  return new Promise<boolean>((resolveCheck) => {
    // npm global tools are .cmd shims on Windows, so resolve the fixed checks via cmd.exe.
    const useWindowsShim = process.platform === 'win32' && check.windowsCmdShim
    const command = useWindowsShim ? process.env.ComSpec || 'cmd.exe' : check.command
    const args = useWindowsShim
      ? ['/d', '/s', '/c', [check.command, ...check.args].join(' ')]
      : check.args
    const child = spawn(command, args, { windowsHide: true })
    let output = ''

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.once('error', () => {
      console.log(`FAIL  ${check.label}: command not found`)
      resolveCheck(false)
    })
    child.once('exit', (code) => {
      const summary = output.trim().split(/\r?\n/).at(-1) || `exit ${code}`
      console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${check.label}: ${summary}`)
      resolveCheck(code === 0)
    })
  })
}

let allPassed = true
for (const command of commands) {
  allPassed = (await run(command)) && allPassed
}

const codex = new CodexAppServerClient()
try {
  await codex.start()
  const status = await codex.accountStatus() as { account?: unknown } | null
  const accountConfigured = Boolean(status?.account)
  console.log(`${accountConfigured ? 'PASS' : 'FAIL'}  Codex app-server account: ${accountConfigured ? 'account/read returned an account' : 'no account returned'}`)
  allPassed = accountConfigured && allPassed
} catch (error) {
  console.log(`FAIL  Codex app-server account: ${error instanceof Error ? error.message : String(error)}`)
  allPassed = false
} finally {
  await codex.close()
}

const voiceProviderValue = process.env.VOICE_PROVIDER?.trim() || 'none'
const voiceProvider = normalizeVoiceProvider(voiceProviderValue)
const fallbackValue = process.env.VOICE_FALLBACK_PROVIDER?.trim() || 'none'
const fallbackProvider = fallbackValue === 'none' ? null : normalizeVoiceProvider(fallbackValue)

if (voiceProviderValue === 'none') {
  console.log('INFO  Voice provider: not configured (allowed for the transport prototype)')
} else if (!voiceProvider) {
  console.log(`FAIL  Voice provider: unsupported value ${voiceProviderValue}`)
  allPassed = false
} else {
  const keyConfigured = Boolean(process.env.DASHSCOPE_API_KEY?.trim())
  const workspaceConfigured = Boolean(process.env.DASHSCOPE_WORKSPACE_ID?.trim())
  console.log(`${keyConfigured ? 'PASS' : 'FAIL'}  Voice provider ${voiceProvider}: ${keyConfigured ? 'DASHSCOPE_API_KEY is set' : 'missing DASHSCOPE_API_KEY'}`)
  console.log(`${workspaceConfigured ? 'PASS' : 'FAIL'}  DashScope workspace: ${workspaceConfigured ? 'DASHSCOPE_WORKSPACE_ID is set' : 'missing DASHSCOPE_WORKSPACE_ID'}`)
  allPassed = keyConfigured && workspaceConfigured && allPassed

  if (fallbackValue !== 'none' && !fallbackProvider) {
    console.log(`FAIL  Voice fallback: unsupported value ${fallbackValue}`)
    allPassed = false
  } else if (fallbackProvider) {
    console.log(`PASS  Voice fallback: ${fallbackProvider}`)
  }

  if ((voiceProvider === 'paraformer' || fallbackProvider === 'paraformer') && process.env.DASHSCOPE_REGION !== 'cn-beijing') {
    console.log('FAIL  Paraformer region: paraformer-realtime-v2 requires DASHSCOPE_REGION=cn-beijing')
    allPassed = false
  }
}

console.log('TODO  Verify the Even Realities phone account, developer portal login, Developer Mode, pairing, and firmware manually.')
process.exitCode = allPassed ? 0 : 1

