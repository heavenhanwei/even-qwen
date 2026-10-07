import { randomBytes } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'dotenv'

const [, , sourceArg, destinationArg = '.env'] = process.argv
if (!sourceArg) throw new Error('Usage: node scripts/migrate-local-env.mjs <source.env> [destination.env]')

const source = resolve(sourceArg)
const destination = resolve(destinationArg)

try {
  await access(destination)
  throw new Error(`Refusing to overwrite existing file: ${destination}`)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const oldEnvironment = parse(await readFile(source, 'utf8'))
if (!oldEnvironment.DASHSCOPE_API_KEY) throw new Error('Source does not contain DASHSCOPE_API_KEY')

const values = {
  AGENT_BIND_HOST: '127.0.0.1',
  AGENT_PORT: '8788',
  AGENT_PAIRING_TOKEN: randomBytes(32).toString('hex'),
  DASHSCOPE_API_KEY: oldEnvironment.DASHSCOPE_API_KEY,
  DASHSCOPE_WORKSPACE_ID: oldEnvironment.DASHSCOPE_WORKSPACE_ID || '',
  DASHSCOPE_REGION: oldEnvironment.DASHSCOPE_REGION || 'cn-beijing',
  QWEN_OMNI_MODEL: oldEnvironment.QWEN_OMNI_MODEL || 'qwen3.8-omni-flash-realtime',
  QWEN_OMNI_ENDPOINT: oldEnvironment.QWEN_OMNI_ENDPOINT || '',
  EVEN_QWEN_DATA_DIR: oldEnvironment.EVEN_QWEN_DATA_DIR || '',
}

const content = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')
await writeFile(destination, `${content}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
console.log(`Created ${destination}`)
console.log(`Migrated fields: ${Object.keys(values).join(', ')}`)
console.log('Secret values were not printed.')
