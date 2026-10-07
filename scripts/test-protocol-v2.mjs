import test from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_VERSION, parseClientMessage } from '../packages/protocol/dist/index.js'

test('protocol v2 requires conversationId', () => {
  assert.equal(PROTOCOL_VERSION, 2)
  assert.throws(() => parseClientMessage(JSON.stringify({ protocolVersion: 2, type: 'ping', requestId: '1' })), /conversationId/)
  const parsed = parseClientMessage(JSON.stringify({ protocolVersion: 2, type: 'ping', requestId: '1', conversationId: 'c' }))
  assert.equal(parsed.type, 'ping')
})

test('legacy task messages are rejected', () => {
  assert.throws(() => parseClientMessage(JSON.stringify({ protocolVersion: 2, type: 'tasks.list', conversationId: '' })), /Unsupported/)
})
