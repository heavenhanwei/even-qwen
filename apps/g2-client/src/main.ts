import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type CodexThreadDetail,
  type CodexThreadSummary,
  type ServerMessage,
} from '@even-chatgpt/protocol'
import './style.css'

const statusElement = document.querySelector<HTMLParagraphElement>('#status')
const detailsElement = document.querySelector<HTMLPreElement>('#details')
const connectionForm = document.querySelector<HTMLFormElement>('#connection-form')
const agentUrlInput = document.querySelector<HTMLInputElement>('#agent-url')
const pairingTokenInput = document.querySelector<HTMLInputElement>('#pairing-token')

const AGENT_URL_STORAGE_KEY = 'even-chatgpt.agent-url'
const PAIRING_TOKEN_STORAGE_KEY = 'even-chatgpt.pairing-token'
const developmentUrl = import.meta.env.DEV
  ? import.meta.env.VITE_AGENT_WS_URL as string | undefined
  : undefined
const developmentToken = import.meta.env.DEV
  ? import.meta.env.VITE_AGENT_PAIRING_TOKEN as string | undefined
  : undefined

function readLocalSetting(key: string) {
  try {
    return window.localStorage.getItem(key) || undefined
  } catch {
    return undefined
  }
}

function writeLocalSetting(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // The glasses UI remains usable if this WebView disables local storage.
  }
}

let agentUrl = readLocalSetting(AGENT_URL_STORAGE_KEY)
  || developmentUrl
  || `ws://${location.hostname}:8787`
let pairingToken = readLocalSetting(PAIRING_TOKEN_STORAGE_KEY) || developmentToken || ''
const textEncoder = new TextEncoder()
const CLIENT_BUILD = '0.1.8-webview-request-id'
const TAP_DEBOUNCE_MS = 220
const DISPLAY_ECHO_GUARD_MS = 80
const CAPTION_RENDER_INTERVAL_MS = 180
const VOICE_CONNECT_TIMEOUT_MS = 15_000

let displayText = 'Connecting to desktop agent…'
let micEnabled = false
let socket: WebSocket | null = null
let reconnectTimer: number | null = null
let lastAudioAckAt = 0
let tasks: CodexThreadSummary[] = []
let selectedListIndex = 0
let latestTaskRequestId: string | null = null
let latestDetailRequestId: string | null = null
let taskLoadTimer: number | null = null
let detailLoadTimer: number | null = null
let pageMode: 'status' | 'tasks' | 'detail' = 'status'
let voiceStage: 'idle' | 'connecting' | 'listening' | 'transcribing' | 'running' | 'stopping' = 'idle'
let activeThreadId: string | null = null
let activeTurnId: string | null = null
let currentTaskDetail: CodexThreadDetail | null = null
let taskDetailPage = 0
let activeVoiceRequestId: string | null = null
let latestVoiceCaption = ''
let captionProvider: 'qwen-omni' | 'paraformer' = 'qwen-omni'
let captionRenderTimer: number | null = null
let voiceConnectTimer: number | null = null
let lastCaptionRenderedAt = 0
let audioFrameCount = 0
let bridgeQueue: Promise<void> = Promise.resolve()
let lastHandledTapAt = 0
let displayUpdateDepth = 0
let displayEchoIgnoreUntil = 0
let requestSequence = 0

function createRequestId(prefix: string) {
  requestSequence = (requestSequence + 1) % 1_000_000
  return `${prefix}-${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function updateBrowserUi(status: string, details = '') {
  if (statusElement) statusElement.textContent = status
  if (detailsElement) detailsElement.textContent = details
}

if (agentUrlInput) agentUrlInput.value = agentUrl
if (pairingTokenInput) pairingTokenInput.value = pairingToken

function clientLog(level: 'info' | 'warn' | 'error', message: string, detail?: unknown) {
  const normalizedDetail = detail instanceof Error
    ? detail.message
    : detail === undefined
      ? undefined
      : typeof detail === 'string'
        ? detail
        : JSON.stringify(detail)
  console[level](`[g2] ${message}`, normalizedDetail || '')
  send({ type: 'client.log', level, message, detail: normalizedDetail })
}

function runBridge<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const pending = bridgeQueue.then(operation, operation)
  bridgeQueue = pending.then(() => undefined, () => undefined)
  return pending.then(
    (result) => {
      clientLog('info', `${label} completed`, String(result))
      return result
    },
    (error) => {
      clientLog('error', `${label} failed`, error)
      throw error
    },
  )
}

async function runDisplayBridge<T>(label: string, operation: () => Promise<T>) {
  displayUpdateDepth += 1
  try {
    return await runBridge(label, operation)
  } finally {
    displayUpdateDepth = Math.max(0, displayUpdateDepth - 1)
    displayEchoIgnoreUntil = Date.now() + DISPLAY_ECHO_GUARD_MS
  }
}

const bridge = await waitForEvenAppBridge()

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 8,
  containerID: 1,
  containerName: 'assistant',
  content: `Starting ${CLIENT_BUILD}…`,
  textColor: 4,
  isEventCapture: 1,
})

const createResult = await runBridge('startup page create', () => bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
))

if (createResult !== 0) {
  clientLog('warn', 'startup page already exists; rebuilding', { createResult })
  const recovered = await runBridge('startup page recovery rebuild', () => bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [mainText],
    }),
  ))
  if (!recovered) throw new Error(`Unable to recover startup page after create result ${createResult}`)
}

async function render(content: string) {
  displayText = content.slice(0, 1800)
  updateBrowserUi(micEnabled ? 'Listening' : 'Ready', displayText)
  const glassesContent = pageMode === 'tasks'
    ? displayText.replace(/\s+/g, ' ').slice(0, 62)
    : displayText
  const updated = await runDisplayBridge('text update', () => bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'assistant',
      contentOffset: 0,
      contentLength: 0,
      content: glassesContent,
      textColor: 4,
    }),
  ))
  if (!updated) throw new Error('G2 rejected the text update')
}

function renderSafely(content: string) {
  void render(content).catch((error) => {
    updateBrowserUi('Glasses render error', error instanceof Error ? error.message : String(error))
  })
}

async function renderVoiceCaption() {
  if (voiceStage !== 'listening' || !latestVoiceCaption) return
  lastCaptionRenderedAt = Date.now()
  const providerLabel = captionProvider === 'qwen-omni' ? 'Qwen Omni' : 'Paraformer'
  const content = `Listening with ${providerLabel}…\n\n${latestVoiceCaption}\n\nTap: 提交`
  displayText = content.slice(0, 1800)
  updateBrowserUi('Listening', displayText)
  const updated = await runDisplayBridge('caption text update', () => bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'assistant',
      contentOffset: 0,
      contentLength: 0,
      content: displayText,
      textColor: 4,
    }),
  ))
  if (!updated) throw new Error('G2 rejected the caption update')
}

function scheduleVoiceCaptionRender() {
  if (captionRenderTimer !== null) return
  const delay = Math.max(0, CAPTION_RENDER_INTERVAL_MS - (Date.now() - lastCaptionRenderedAt))
  captionRenderTimer = window.setTimeout(() => {
    captionRenderTimer = null
    void renderVoiceCaption().catch((error) => clientLog('error', 'caption render failed', error))
  }, delay)
}

function clearVoiceCaption() {
  latestVoiceCaption = ''
  if (captionRenderTimer !== null) window.clearTimeout(captionRenderTimer)
  captionRenderTimer = null
}

function clearVoiceConnectTimer() {
  if (voiceConnectTimer !== null) window.clearTimeout(voiceConnectTimer)
  voiceConnectTimer = null
}

async function showStatusPage(content: string) {
  displayText = content.slice(0, 1800)
  const updated = await runDisplayBridge('status text update', () => bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'assistant',
      contentOffset: 0,
      contentLength: 0,
      content: displayText,
    }),
  ))
  if (!updated) throw new Error('G2 rejected the status text update')
  pageMode = 'status'
  updateBrowserUi(micEnabled ? 'Listening' : 'Ready', displayText)
}

function showStatusPageSafely(content: string) {
  void showStatusPage(content).catch((error) => {
    updateBrowserUi('Glasses render error', error instanceof Error ? error.message : String(error))
  })
}

function send(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(message))
  return true
}

function requestTasks() {
  const requestId = createRequestId('tasks')
  latestTaskRequestId = requestId
  clientLog('info', 'requesting Codex tasks', requestId)

  if (!send({ type: 'tasks.list', requestId, limit: 8 })) {
    renderSafely('Desktop agent is not connected.\n\nLong-press to retry.')
    return
  }

  if (taskLoadTimer !== null) window.clearTimeout(taskLoadTimer)
  taskLoadTimer = window.setTimeout(() => {
    if (latestTaskRequestId !== requestId) return
    latestTaskRequestId = null
    renderSafely('Codex task request timed out.\n\nLong-press to retry.')
  }, 8_000)
}

function requestTaskDetail(task: CodexThreadSummary) {
  const requestId = createRequestId('detail')
  latestDetailRequestId = requestId
  pageMode = 'detail'
  clientLog('info', 'requesting Codex task detail', { threadId: task.id })
  renderSafely(`正在读取任务…\n\n${taskTitle(task)}`)

  if (!send({ type: 'tasks.read', requestId, threadId: task.id })) {
    latestDetailRequestId = null
    renderSafely('Desktop agent is not connected.\n\nLong-press to return to tasks.')
    return
  }

  if (detailLoadTimer !== null) window.clearTimeout(detailLoadTimer)
  detailLoadTimer = window.setTimeout(() => {
    if (latestDetailRequestId !== requestId) return
    latestDetailRequestId = null
    renderSafely('读取任务详情超时。\n\n长按返回任务列表。')
  }, 8_000)
}

function taskTitle(task: CodexThreadSummary) {
  return (task.name || task.preview || task.id).replace(/\s+/g, ' ').trim()
}

function truncateUtf8(value: string, maxBytes: number) {
  let result = ''
  let byteLength = 0
  for (const character of value) {
    const characterBytes = textEncoder.encode(character).byteLength
    if (byteLength + characterBytes > maxBytes) break
    result += character
    byteLength += characterBytes
  }
  return result
}

function taskItemNames() {
  const historyItems = tasks.map((task, index) => {
    const prefix = `${index + 1}. `
    const titleBudget = 60 - textEncoder.encode(prefix).byteLength
    return `${prefix}${truncateUtf8(taskTitle(task), titleBudget)}`
  })
  return ['+ New voice task', ...historyItems]
}

function taskPickerContent() {
  const items = taskItemNames()
  const first = Math.max(0, Math.min(selectedListIndex - 2, Math.max(items.length - 5, 0)))
  const visible = items.slice(first, first + 5).map((item, offset) =>
    first + offset === selectedListIndex ? `> ${item}` : `  ${item}`,
  )
  return [
    `Codex tasks (${tasks.length})`,
    '',
    ...visible,
    '',
    'Swipe: select  Tap: open',
  ].join('\n')
}

function taskDetailPages(task: CodexThreadDetail) {
  const updated = task.updatedAt
    ? new Date(task.updatedAt * 1_000).toLocaleString('zh-CN', { hour12: false })
    : '未知'
  const body = [
    `状态: ${task.status?.type || 'unknown'}  对话: ${task.turnCount}`,
    `模型: ${task.model || 'default'}`,
    `更新: ${updated}`,
    task.cwd ? `目录: ${task.cwd}` : '',
    '',
    task.latestUserMessage ? `最近指令:\n${task.latestUserMessage}` : '',
    '',
    task.latestAssistantMessage ? `最近回复:\n${task.latestAssistantMessage}` : '',
  ].filter((line, index, values) => line || (index > 0 && values[index - 1])).join('\n')

  const pages: string[] = []
  let remaining = body
  while (remaining) {
    if (remaining.length <= 420) {
      pages.push(remaining)
      break
    }
    const candidate = remaining.slice(0, 420)
    const splitAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf('。'), 280)
    pages.push(remaining.slice(0, splitAt + 1).trim())
    remaining = remaining.slice(splitAt + 1).trim()
  }
  return pages.length ? pages : ['暂无可显示的任务内容。']
}

function taskDetailContent(task: CodexThreadDetail) {
  const pages = taskDetailPages(task)
  taskDetailPage = Math.min(Math.max(taskDetailPage, 0), pages.length - 1)
  return [
    taskTitle(task),
    `第 ${taskDetailPage + 1}/${pages.length} 页`,
    '',
    pages[taskDetailPage],
    '',
    'Swipe: 翻页  Tap: 语音继续',
    'Long press: 返回  Double tap: 退出',
  ].join('\n')
}

async function showTaskDetail(task: CodexThreadDetail) {
  pageMode = 'detail'
  currentTaskDetail = task
  taskDetailPage = 0
  await render(taskDetailContent(task))
}

async function showTaskList() {
  currentTaskDetail = null
  taskDetailPage = 0
  selectedListIndex = Math.min(Math.max(selectedListIndex, 0), tasks.length)
  const updated = await runDisplayBridge('task list text update', () => bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'assistant',
      contentOffset: 0,
      contentLength: 0,
      content: taskPickerContent(),
    }),
  ))
  if (!updated) throw new Error('G2 rejected the Codex history text')

  pageMode = 'tasks'
  updateBrowserUi('Codex tasks', taskPickerContent())
}

async function updateTaskPicker() {
  const updated = await runDisplayBridge('task picker update', () => bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'assistant',
      contentOffset: 0,
      contentLength: 0,
      content: taskPickerContent(),
    }),
  ))
  if (!updated) throw new Error('G2 rejected the task picker update')
  updateBrowserUi('Codex tasks', taskPickerContent())
}

function showTaskListSafely() {
  void showTaskList().catch((error) => {
    pageMode = 'status'
    renderSafely(`Task list render failed.\n\n${error instanceof Error ? error.message : String(error)}`)
  })
}

function updateSelectedTaskFromEvent(itemName?: string, itemIndex?: number) {
  const names = taskItemNames()
  const nameIndex = itemName ? names.indexOf(itemName) : -1
  if (nameIndex >= 0) {
    selectedListIndex = nameIndex
    return
  }

  if (typeof itemIndex === 'number') {
    selectedListIndex = Math.min(Math.max(itemIndex, 0), tasks.length)
  }
}

function selectedTask() {
  return selectedListIndex === 0 ? undefined : tasks[selectedListIndex - 1]
}

async function handleVoiceStatus(message: Extract<ServerMessage, { type: 'voice.status' }>) {
  if (activeVoiceRequestId && message.requestId !== activeVoiceRequestId) {
    clientLog('warn', 'ignored voice status for another request', {
      expected: activeVoiceRequestId,
      received: message.requestId,
      stage: message.stage,
    })
    return
  }
  clientLog('info', `voice status: ${message.stage}`, message.message)
  updateBrowserUi(message.message, message.response || message.transcript || '')

  if (message.stage === 'listening') {
    clearVoiceConnectTimer()
    const opened = await runBridge('glasses microphone open', () =>
      bridge.audioControl(true, AudioInputSource.Glasses),
    )
    if (!opened) {
      voiceStage = 'transcribing'
      send({ type: 'voice.stop', requestId: createRequestId('voice-stop') })
      await showStatusPage('Unable to open the G2 microphone.\n\nLong-press to return to tasks.')
      return
    }
    audioFrameCount = 0
    micEnabled = true
    voiceStage = 'listening'
    await render(`Listening with Qwen…\n\n${selectedTask() ? taskTitle(selectedTask()!) : 'New Codex task'}\n\nTap: 提交`)
    return
  }

  if (message.stage === 'connecting') {
    voiceStage = 'connecting'
    await render('Connecting to Qwen ASR…')
    return
  }

  if (message.stage === 'cancelled') {
    clearVoiceConnectTimer()
    activeVoiceRequestId = null
    clearVoiceCaption()
    micEnabled = false
    voiceStage = 'idle'
    await runBridge('microphone close', () => bridge.audioControl(false))
    await showTaskList()
    return
  }

  if (message.stage === 'transcribing' || message.stage === 'starting_task') {
    micEnabled = false
    voiceStage = 'transcribing'
    await runBridge('microphone close', () => bridge.audioControl(false))
    await render(`${message.message}…${message.transcript ? `\n\n“${message.transcript}”` : ''}`)
    return
  }

  if (message.stage === 'running') {
    voiceStage = 'running'
    activeThreadId = message.threadId || activeThreadId
    activeTurnId = message.turnId || activeTurnId
    await render(`${message.message}…${message.transcript ? `\n\n“${message.transcript}”` : ''}\n\n单击停止任务。`)
    return
  }

  if (message.stage === 'stopping') {
    voiceStage = 'stopping'
    await render('正在停止 Codex 任务…')
    return
  }

  micEnabled = false
  clearVoiceConnectTimer()
  voiceStage = 'idle'
  activeVoiceRequestId = null
  clearVoiceCaption()
  activeThreadId = null
  activeTurnId = null
  await runBridge('microphone close', () => bridge.audioControl(false))
  const body = message.stage === 'completed'
    ? `${message.message}\n\n${message.response || '任务已创建，可稍后从历史任务查看。'}\n\n长按返回任务列表。`
    : message.stage === 'stopped'
      ? `${message.message}\n\n${message.response || '已保留当前任务和上下文。'}\n\n长按返回任务列表。`
      : `语音任务失败\n\n${message.message}\n\n长按返回任务列表。`
  await showStatusPage(body)
}

function connect() {
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
  reconnectTimer = null
  updateBrowserUi('Connecting', agentUrl)
  const connection = new WebSocket(agentUrl)
  socket = connection
  connection.binaryType = 'arraybuffer'

  connection.addEventListener('open', () => {
    send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: CLIENT_BUILD,
      token: pairingToken || undefined,
    })
  })

  connection.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return

    let rawMessage: unknown
    try {
      rawMessage = JSON.parse(event.data) as unknown
    } catch {
      renderSafely('Desktop sent an invalid response.')
      return
    }

    const message = parseServerMessage(rawMessage)
    if (!message) return

    switch (message.type) {
      case 'ready':
        if (message.codexReady) {
          if (message.tasks) {
            tasks = message.tasks
            selectedListIndex = 0
            clientLog('info', 'initial Codex tasks received', { count: tasks.length })
            showTaskListSafely()
          } else {
            renderSafely('Desktop connected. Loading Codex tasks…')
            requestTasks()
          }
        } else {
          renderSafely('Desktop connected. Codex is unavailable.')
        }
        break
      case 'tasks.list.result':
        if (message.requestId !== latestTaskRequestId) return
        latestTaskRequestId = null
        if (taskLoadTimer !== null) window.clearTimeout(taskLoadTimer)
        taskLoadTimer = null
        tasks = message.tasks
        clientLog('info', 'Codex tasks received', { count: tasks.length })
        selectedListIndex = 0
        showTaskListSafely()
        break
      case 'tasks.read.result':
        if (message.requestId !== latestDetailRequestId) return
        latestDetailRequestId = null
        if (detailLoadTimer !== null) window.clearTimeout(detailLoadTimer)
        detailLoadTimer = null
        clientLog('info', 'Codex task detail received', {
          threadId: message.task.id,
          turnCount: message.task.turnCount,
        })
        void showTaskDetail(message.task).catch((error) => {
          showStatusPageSafely(`Task detail render failed.\n\n${error instanceof Error ? error.message : String(error)}`)
        })
        break
      case 'audio.ack':
        if (!lastAudioAckAt) clientLog('info', 'first audio acknowledgement received', { bytes: message.bytesReceived })
        lastAudioAckAt = Date.now()
        break
      case 'voice.caption': {
        if (message.requestId !== activeVoiceRequestId || voiceStage !== 'listening') return
        const firstCaption = !latestVoiceCaption
        latestVoiceCaption = message.text
        captionProvider = message.provider
        if (firstCaption) clientLog('info', 'first live caption received', { provider: message.provider })
        scheduleVoiceCaptionRender()
        break
      }
      case 'voice.status':
        void handleVoiceStatus(message).catch((error) => {
          voiceStage = 'idle'
          micEnabled = false
          showStatusPageSafely(`Voice UI error\n\n${error instanceof Error ? error.message : String(error)}`)
        })
        break
      case 'error':
        if (message.requestId === latestTaskRequestId) {
          latestTaskRequestId = null
          if (taskLoadTimer !== null) window.clearTimeout(taskLoadTimer)
          taskLoadTimer = null
        }
        if (message.requestId === latestDetailRequestId) {
          latestDetailRequestId = null
          if (detailLoadTimer !== null) window.clearTimeout(detailLoadTimer)
          detailLoadTimer = null
        }
        if (voiceStage !== 'idle') {
          clearVoiceConnectTimer()
          voiceStage = 'idle'
          micEnabled = false
          activeVoiceRequestId = null
          clearVoiceCaption()
          void runBridge('microphone close', () => bridge.audioControl(false))
          showStatusPageSafely(`Voice task failed\n\n${message.message}\n\nLong-press to return to tasks.`)
        } else {
          renderSafely(`Error\n\n${message.message}`)
        }
        break
    }
  })

  connection.addEventListener('close', () => {
    if (socket !== connection) return
    socket = null
    clientLog('warn', 'desktop WebSocket closed')
    latestTaskRequestId = null
    latestDetailRequestId = null
    activeVoiceRequestId = null
    clearVoiceConnectTimer()
    clearVoiceCaption()
    if (taskLoadTimer !== null) window.clearTimeout(taskLoadTimer)
    taskLoadTimer = null
    if (detailLoadTimer !== null) window.clearTimeout(detailLoadTimer)
    detailLoadTimer = null
    renderSafely('Desktop disconnected.\nRetrying…')
    reconnectTimer = window.setTimeout(connect, 2000)
  })

  connection.addEventListener('error', () => {
    clientLog('error', 'desktop WebSocket error', agentUrl)
    updateBrowserUi('Connection error', agentUrl)
  })
}

connectionForm?.addEventListener('submit', (event) => {
  event.preventDefault()
  const nextUrl = agentUrlInput?.value.trim() || ''
  const nextToken = pairingTokenInput?.value.trim() || ''
  let parsed: URL
  try {
    parsed = new URL(nextUrl)
  } catch {
    updateBrowserUi('Invalid Agent URL', 'Use ws:// for a trusted private network or wss:// for internet access.')
    return
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    updateBrowserUi('Invalid Agent URL', 'The URL must begin with ws:// or wss://.')
    return
  }

  agentUrl = parsed.toString().replace(/\/$/, '')
  pairingToken = nextToken
  writeLocalSetting(AGENT_URL_STORAGE_KEY, agentUrl)
  writeLocalSetting(PAIRING_TOKEN_STORAGE_KEY, pairingToken)
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
  reconnectTimer = null
  const previous = socket
  socket = null
  previous?.close(1000, 'Connection settings changed')
  connect()
})

async function toggleVoice() {
  if (socket?.readyState !== WebSocket.OPEN) {
    await render('Desktop agent is not connected.')
    return
  }

  if (voiceStage === 'idle') {
    voiceStage = 'connecting'
    clearVoiceCaption()
    lastAudioAckAt = 0
    audioFrameCount = 0
    const target = selectedTask()
    const requestId = createRequestId('voice-start')
    activeVoiceRequestId = requestId
    const sent = send({
      type: 'voice.start',
      requestId,
      targetThreadId: target?.id,
    })
    if (!sent) {
      voiceStage = 'idle'
      activeVoiceRequestId = null
      await showStatusPage('Desktop agent is not connected.')
    } else {
      clientLog('info', 'voice.start sent', { requestId, targetThreadId: target?.id })
      clearVoiceConnectTimer()
      voiceConnectTimer = window.setTimeout(() => {
        if (voiceStage !== 'connecting' || activeVoiceRequestId !== requestId) return
        clientLog('error', 'voice connection timed out', { requestId })
        send({ type: 'voice.cancel', requestId })
        activeVoiceRequestId = null
        voiceStage = 'idle'
        showStatusPageSafely('Qwen 连接超时。\n\n单击重试，长按返回任务列表。')
      }, VOICE_CONNECT_TIMEOUT_MS)
      await showStatusPage(target
        ? `Preparing Qwen…\n\nContinue: ${taskTitle(target)}`
        : 'Preparing Qwen…\n\nCreate a new Codex task')
    }
    return
  }

  if (voiceStage === 'connecting') {
    const requestId = activeVoiceRequestId
    clearVoiceConnectTimer()
    activeVoiceRequestId = null
    voiceStage = 'idle'
    if (requestId) send({ type: 'voice.cancel', requestId })
    clientLog('info', 'tap cancelled voice connection', { requestId })
    await showTaskList()
    return
  }

  if (voiceStage === 'listening') {
    clientLog('info', 'tap stopping microphone', { audioFrameCount })
    voiceStage = 'transcribing'
    micEnabled = false
    clearVoiceCaption()
    await runBridge('microphone close', () => bridge.audioControl(false))
    send({ type: 'voice.stop', requestId: createRequestId('voice-stop') })
    await render(`Microphone stopped.\n\nAudio: ${lastAudioAckAt ? 'received' : 'pending'}\n\nQwen is transcribing…`)
    return
  }

  if (voiceStage === 'running') {
    if (!activeThreadId || !activeTurnId) {
      clientLog('error', 'cannot stop Codex task without active ids')
      await render('无法停止任务：缺少当前任务标识。')
      return
    }

    const requestId = createRequestId('task-stop')
    clientLog('info', 'tap interrupting Codex task', { threadId: activeThreadId, turnId: activeTurnId })
    voiceStage = 'stopping'
    const sent = send({
      type: 'task.stop',
      requestId,
      threadId: activeThreadId,
      turnId: activeTurnId,
    })
    if (!sent) {
      voiceStage = 'running'
      await render('停止请求发送失败：桌面 Agent 未连接。')
      return
    }
    await render('正在停止 Codex 任务…')
  }
}

async function handleTap() {
  if (voiceStage === 'idle' && pageMode === 'tasks') {
    const task = selectedTask()
    if (task) {
      clientLog('info', 'opening selected Codex task', {
        selectedListIndex,
        threadId: task.id,
        title: taskTitle(task),
      })
      requestTaskDetail(task)
      return
    }
    clientLog('info', 'opening new voice task', { selectedListIndex })
  }
  await toggleVoice()
}

function explicitEventType(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  return envelope?.eventType ?? null
}

function targetsAssistant(envelope?: { containerID?: number; containerName?: string }) {
  return envelope?.containerID === 1 || envelope?.containerName === 'assistant'
}

const unsubscribe = bridge.onEvenHubEvent((event) => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm && micEnabled && socket?.readyState === WebSocket.OPEN) {
    audioFrameCount += 1
    if (audioFrameCount === 1) clientLog('info', 'first microphone PCM frame received', { bytes: pcm.byteLength })
    socket.send(pcm)
  }

  if (pageMode === 'tasks') {
    updateSelectedTaskFromEvent(
      event.listEvent?.currentSelectItemName,
      event.listEvent?.currentSelectItemIndex,
    )
  }
  const explicitType = explicitEventType(event.listEvent)
    ?? explicitEventType(event.textEvent)
    ?? explicitEventType(event.sysEvent)
  // CLICK_EVENT is protobuf enum value 0, so the host omits eventType on the
  // wire. Physical taps arrive as a sysEvent envelope with no eventType.
  // Resolve explicit non-zero gestures first, then apply the zero-value
  // fallback only when an input envelope actually exists.
  const legacyClick = explicitType === null
    && (Boolean(event.sysEvent) || targetsAssistant(event.listEvent) || targetsAssistant(event.textEvent))
  const eventType = explicitType ?? (legacyClick ? OsEventTypeList.CLICK_EVENT : null)
  if (eventType !== null) {
    clientLog('info', 'input event received', {
      eventType,
      legacyClick,
      listContainer: event.listEvent?.containerID,
      textContainer: event.textEvent?.containerID,
    })
  }
  if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    clientLog('info', 'double tap exiting app')
    micEnabled = false
    void runBridge('microphone close', () => bridge.audioControl(false))
    void runBridge('page shutdown', () => bridge.shutDownPageContainer(1))
    return
  }

  if (
    (eventType === OsEventTypeList.SCROLL_TOP_EVENT
      || eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT)
    && pageMode === 'tasks'
    && taskItemNames().length > 0
  ) {
    selectedListIndex = eventType === OsEventTypeList.SCROLL_TOP_EVENT
      ? Math.max(0, selectedListIndex - 1)
      : Math.min(tasks.length, selectedListIndex + 1)
    void updateTaskPicker().catch((error) => {
      clientLog('error', 'task picker update failed', error)
    })
    return
  }

  if (
    (eventType === OsEventTypeList.SCROLL_TOP_EVENT
      || eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT)
    && pageMode === 'detail'
    && currentTaskDetail
  ) {
    const lastPage = taskDetailPages(currentTaskDetail).length - 1
    taskDetailPage = eventType === OsEventTypeList.SCROLL_TOP_EVENT
      ? Math.max(0, taskDetailPage - 1)
      : Math.min(lastPage, taskDetailPage + 1)
    renderSafely(taskDetailContent(currentTaskDetail))
    return
  }

  if (eventType === OsEventTypeList.LONG_PRESS_EVENT) {
    if (voiceStage !== 'idle') return
    if (pageMode !== 'tasks') {
      showTaskListSafely()
      return
    }
    renderSafely('Refreshing Codex tasks…')
    requestTasks()
    return
  }

  if (eventType === OsEventTypeList.CLICK_EVENT) {
    clientLog('info', 'tap received', { voiceStage, pageMode })
    const now = Date.now()
    if (legacyClick && (displayUpdateDepth > 0 || now < displayEchoIgnoreUntil)) {
      clientLog('info', 'ignored display echo tap')
      return
    }
    if (now - lastHandledTapAt < TAP_DEBOUNCE_MS) {
      clientLog('info', 'ignored duplicate tap event')
      return
    }
    lastHandledTapAt = now
    void handleTap()
  }
})

window.addEventListener('beforeunload', () => {
  unsubscribe()
  if (taskLoadTimer !== null) window.clearTimeout(taskLoadTimer)
  if (detailLoadTimer !== null) window.clearTimeout(detailLoadTimer)
  if (captionRenderTimer !== null) window.clearTimeout(captionRenderTimer)
  clearVoiceConnectTimer()
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
  void runBridge('microphone close', () => bridge.audioControl(false))
  void bridge.shutDownPageContainer(0)
  socket?.close()
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe()
    if (captionRenderTimer !== null) window.clearTimeout(captionRenderTimer)
    clearVoiceConnectTimer()
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    void bridge.audioControl(false)
    socket?.close()
  })
}

connect()

