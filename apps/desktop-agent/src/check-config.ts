import { fileURLToPath } from 'node:url'
import { config as loadEnvironment } from 'dotenv'

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true })

const checks = {
  DASHSCOPE_API_KEY: Boolean(process.env.DASHSCOPE_API_KEY),
  DASHSCOPE_WORKSPACE_ID: Boolean(process.env.DASHSCOPE_WORKSPACE_ID),
  QWEN_OMNI_MODEL: process.env.QWEN_OMNI_MODEL || 'qwen3.8-omni-flash-realtime',
  AGENT_PAIRING_TOKEN: Boolean(process.env.AGENT_PAIRING_TOKEN),
  AGENT_PORT: process.env.AGENT_PORT || '8788',
}

console.log(JSON.stringify(checks, null, 2))
if (!checks.DASHSCOPE_API_KEY || (checks.QWEN_OMNI_MODEL.startsWith('qwen3.8-') && !checks.DASHSCOPE_WORKSPACE_ID)) process.exitCode = 1
