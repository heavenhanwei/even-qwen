import 'dotenv/config'

const checks = {
  DASHSCOPE_API_KEY: Boolean(process.env.DASHSCOPE_API_KEY),
  QWEN_OMNI_MODEL: process.env.QWEN_OMNI_MODEL || 'qwen3.8-omni-flash-realtime',
  AGENT_PAIRING_TOKEN: Boolean(process.env.AGENT_PAIRING_TOKEN),
  AGENT_PORT: process.env.AGENT_PORT || '8787',
}

console.log(JSON.stringify(checks, null, 2))
if (!checks.DASHSCOPE_API_KEY) process.exitCode = 1
