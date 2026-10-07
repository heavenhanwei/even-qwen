import test from 'node:test'
import assert from 'node:assert/strict'
import { QWEN_TOOLS, TOOL_CONFIRMATION, redactedArguments, validateToolCall } from '../apps/desktop-agent/dist/tool-registry.js'

test('tool schema contains only the allowlist', () => {
  const names = QWEN_TOOLS.map((tool) => tool.function.name).sort()
  assert.deepEqual(names, [
    'app_focus', 'app_list', 'app_open', 'browser_open_url', 'clipboard_read', 'clipboard_write',
    'even_get_device_status', 'system_get_status',
  ])
  assert.equal(TOOL_CONFIRMATION.app_open, true)
  assert.equal(TOOL_CONFIRMATION.app_list, false)
})

test('unknown apps, executable paths, non-http URLs and oversized clipboard are rejected', () => {
  assert.throws(() => validateToolCall('app_open', { appId: 'calc', path: 'C:\\Windows\\calc.exe' }), /(Unknown|Unexpected)/)
  assert.throws(() => validateToolCall('browser_open_url', { url: 'file:///C:/secret.txt' }), /HTTP/)
  assert.throws(() => validateToolCall('clipboard_write', { text: 'x'.repeat(4097) }), /4096/)
  assert.deepEqual(redactedArguments('clipboard_write', { text: 'secret text' }), { length: 11 })
})

test('Codex accepts only the fixed application id', () => {
  assert.deepEqual(validateToolCall('app_open', { appId: 'codex' }), { appId: 'codex' })
})
