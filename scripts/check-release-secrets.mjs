import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'dotenv'

const root = process.cwd()
const envPath = resolve(root, '.env')
const distPath = resolve(root, 'apps/g2-client/dist')

async function filesUnder(directory) {
  const entries = await readdir(directory)
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry)
    if ((await stat(path)).isDirectory()) files.push(...await filesUnder(path))
    else files.push(path)
  }
  return files
}

let environment = {}
try {
  environment = parse(await readFile(envPath))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const sensitiveEntries = Object.entries(environment).filter(([name, value]) =>
  /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && value.trim().length >= 8,
)
const outputFiles = await filesUnder(distPath)
const leakedNames = new Set()

for (const file of outputFiles) {
  const content = await readFile(file)
  for (const [name, value] of sensitiveEntries) {
    if (content.includes(Buffer.from(value))) leakedNames.add(name)
  }
}

if (leakedNames.size) {
  throw new Error(`Production G2 bundle contains secret values from: ${[...leakedNames].join(', ')}`)
}

console.log(`PASS  Release bundle secret scan (${outputFiles.length} files, ${sensitiveEntries.length} local secrets checked)`)
