import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { QwenOmniSession } from '../apps/desktop-agent/dist/qwen-omni.js'
import { ParaformerSession } from '../apps/desktop-agent/dist/paraformer-asr.js'

loadEnv({ path: resolve(process.cwd(), '.env'), quiet: true })

const apiKey = process.env.DASHSCOPE_API_KEY?.trim()
const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID?.trim()
const region = process.env.DASHSCOPE_REGION === 'ap-southeast-1'
  ? 'ap-southeast-1'
  : 'cn-beijing'

if (!apiKey || !workspaceId) {
  throw new Error('DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID are required')
}

const checks = [
  {
    name: 'Qwen Omni realtime',
    create: () => new QwenOmniSession({
      apiKey,
      workspaceId,
      region,
      model: process.env.QWEN_OMNI_MODEL?.trim() || undefined,
    }),
  },
  {
    name: 'Paraformer realtime',
    create: () => new ParaformerSession({
      apiKey,
      workspaceId,
      region,
      model: process.env.PARAFORMER_MODEL?.trim() || undefined,
      languageHints: process.env.PARAFORMER_LANGUAGE_HINTS
        ?.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    }),
  },
]

let passed = true
for (const check of checks) {
  let session
  try {
    session = check.create()
    await session.start()
    console.log(`PASS  ${check.name}: authenticated and session ready`)
  } catch (error) {
    passed = false
    console.error(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    session?.close()
  }
}

process.exitCode = passed ? 0 : 1
