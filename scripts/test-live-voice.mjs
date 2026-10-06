import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { config as loadEnv } from 'dotenv'
import { QwenOmniSession } from '../apps/desktop-agent/dist/qwen-omni.js'
import { ParaformerSession } from '../apps/desktop-agent/dist/paraformer-asr.js'

loadEnv({ path: resolve(process.cwd(), '.env'), quiet: true })

const audioPath = process.argv[2]
if (!audioPath) throw new Error('Usage: node scripts/test-live-voice.mjs <16-kHz-mono-PCM.wav>')

const apiKey = process.env.DASHSCOPE_API_KEY?.trim()
const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID?.trim()
const region = process.env.DASHSCOPE_REGION === 'ap-southeast-1'
  ? 'ap-southeast-1'
  : 'cn-beijing'
if (!apiKey || !workspaceId) throw new Error('DashScope credentials are missing')

function readPcmData(wave) {
  if (wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Input is not a RIFF/WAVE file')
  }
  let offset = 12
  let format
  let pcm
  while (offset + 8 <= wave.length) {
    const id = wave.toString('ascii', offset, offset + 4)
    const size = wave.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        encoding: wave.readUInt16LE(body),
        channels: wave.readUInt16LE(body + 2),
        sampleRate: wave.readUInt32LE(body + 4),
        bits: wave.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      pcm = wave.subarray(body, body + size)
    }
    offset = body + size + (size % 2)
  }
  if (!format || !pcm) throw new Error('WAVE file is missing fmt or data chunks')
  if (format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 16_000 || format.bits !== 16) {
    throw new Error(`Expected PCM s16le mono 16 kHz, received ${JSON.stringify(format)}`)
  }
  return pcm
}

async function runSession(name, session, pcm) {
  await session.start()
  const chunkBytes = 3_200
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    session.appendAudio(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)))
    await delay(100)
  }
  const result = await session.finish()
  console.log(`PASS  ${name}: ${result}`)
}

const pcm = readPcmData(await readFile(audioPath))

await runSession('Qwen Omni live inference', new QwenOmniSession({
  apiKey,
  workspaceId,
  region,
  model: process.env.QWEN_OMNI_MODEL?.trim() || undefined,
}), pcm)

await runSession('Paraformer live inference', new ParaformerSession({
  apiKey,
  workspaceId,
  region,
  model: process.env.PARAFORMER_MODEL?.trim() || undefined,
  languageHints: process.env.PARAFORMER_LANGUAGE_HINTS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean),
}), pcm)
