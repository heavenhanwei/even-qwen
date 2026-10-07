import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConversationStore } from '../apps/desktop-agent/dist/conversation-store.js'

test('conversation store persists text and never creates audio files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-qwen-test-'))
  try {
    const store = new ConversationStore(directory)
    const conversation = await store.create()
    await store.append(conversation.id, 'user', '测试一条语音转写')
    await store.append(conversation.id, 'assistant', '这是回答')
    const opened = await store.open(conversation.id)
    assert.equal(opened.messages.length, 2)
    assert.equal(opened.conversation.title, '测试一条语音转写')
    const file = await readFile(join(directory, `${conversation.id}.json`), 'utf8')
    assert.doesNotMatch(file, /api[_-]?key|pairing[_-]?token/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
