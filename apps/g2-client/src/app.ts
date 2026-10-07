import './style.css'
import {
  AudioInputSource,
  CreateStartUpPageContainer,
  DeviceConnectType,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type DeviceStatus,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ClientMessagePayload,
  type ConversationMessage,
  type ConversationSummary,
  type DeviceStatusSnapshot,
  type ServerMessage,
  type VoiceStage,
} from '@even-qwen/protocol'

type PageMode = 'startup' | 'conversations' | 'voice' | 'approval'
type PendingApproval = Extract<ServerMessage, { type: 'tool.approval.request' }>

const DEFAULT_AGENT_URL = import.meta.env.VITE_AGENT_WS_URL || 'wss://even-qwen.ifelse.work'
const DEFAULT_TOKEN = import.meta.env.VITE_AGENT_PAIRING_TOKEN || ''
const STORAGE_URL = 'even-qwen.agent-url'
const STORAGE_TOKEN = 'even-qwen.pairing-token'
const STORAGE_CONVERSATION = 'even-qwen.last-conversation'
const STREAM_UPDATE_MS = 200
const PAGE_CHARS = 460
const TAP_DEBOUNCE_MS = 220
const DISPLAY_ECHO_GUARD_MS = 80

const statusElement = document.querySelector<HTMLParagraphElement>('#status')!
const detailsElement = document.querySelector<HTMLPreElement>('#details')!
const form = document.querySelector<HTMLFormElement>('#connection-form')!
const urlInput = document.querySelector<HTMLInputElement>('#agent-url')!
const tokenInput = document.querySelector<HTMLInputElement>('#pairing-token')!

let bridge: EvenAppBridge | null = null
let socket: WebSocket | null = null
let startupCreated = false
let pageMode: PageMode = 'startup'
let voiceStage: VoiceStage = 'idle'
let conversations: ConversationSummary[] = []
let selectedIndex = 0
let activeConversationId = localStorage.getItem(STORAGE_CONVERSATION) || ''
let activeMessages: ConversationMessage[] = []
let deviceStatus: DeviceStatusSnapshot = { connected: false }
let deviceStatusKnown = false
let pendingApproval: PendingApproval | null = null
let requestCounter = 0
let microphoneOpen = false
let foreground = true
let pages: string[] = ['等待语音…']
let pageIndex = 0
let transcript = ''
let assistantText = ''
let streamTimer: number | null = null
let tapTimer: number | null = null
let lastInputAt = 0
let reconnectTimer: number | null = null
let authenticationFailed = false
let bridgeQueue: Promise<unknown> = Promise.resolve()
let displayUpdateDepth = 0
let displayEchoIgnoreUntil = 0
let lastHandledTapAt = 0
const unsubscribers: Array<() => void> = []
let startupAgentStatus = '连接中'
let startupQwenStatus = '等待'
let startupDetail = ''

function queueBridge<T>(action: () => Promise<T>): Promise<T> {
  const guardedAction = async () => {
    displayUpdateDepth += 1
    try {
      return await action()
    } finally {
      displayUpdateDepth = Math.max(0, displayUpdateDepth - 1)
      displayEchoIgnoreUntil = Date.now() + DISPLAY_ECHO_GUARD_MS
    }
  }
  const next = bridgeQueue.then(guardedAction, guardedAction)
  bridgeQueue = next.then(() => undefined, () => undefined)
  return next
}

function requestId(): string {
  requestCounter += 1
  return `${Date.now()}-${requestCounter}`
}

function send(message: ClientMessagePayload, conversationId = activeConversationId): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, conversationId, ...message }))
}

function setPhoneStatus(text: string, detail = ''): void {
  statusElement.textContent = text
  detailsElement.textContent = detail
}

function g2StatusText(): string {
  if (!deviceStatusKnown) return '等待设备状态'
  if (!deviceStatus.connected) return '未连接'
  return Number.isFinite(deviceStatus.batteryLevel) ? `已连接 · ${deviceStatus.batteryLevel}%` : '已连接'
}

function startupText(): string {
  const detail = startupDetail ? `\n\n${startupDetail}` : ''
  return `Even Qwen\n\nAgent：${startupAgentStatus}\nQwen：${startupQwenStatus}\nG2：${g2StatusText()}${detail}\n\n双击退出`
}

async function updateStartupStatus(): Promise<void> {
  if (!bridge || !startupCreated || pageMode !== 'startup') return
  await queueBridge(() => bridge!.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 1,
    containerName: 'startup-status',
    content: startupText(),
  })))
}

function setStartupStatus(agent: string, qwen: string, detail = ''): void {
  startupAgentStatus = agent
  startupQwenStatus = qwen
  startupDetail = detail
  void updateStartupStatus()
}

function textContainer(id: number, name: string, y: number, height: number, content: string, capture = false, brightness = 4) {
  return new TextContainerProperty({
    xPosition: 12, yPosition: y, width: 552, height, containerID: id, containerName: name,
    borderWidth: 0, paddingLength: 8, content: content.slice(0, 2000),
    isEventCapture: capture ? 1 : 0, textColor: brightness,
  })
}

async function createStartup(): Promise<void> {
  if (!bridge || startupCreated) return
  const result = await queueBridge(() => bridge!.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [
      textContainer(1, 'startup-status', 0, 288, startupText(), true),
    ],
  })))
  if (Number(result) !== 0) throw new Error(`启动页创建失败 (${String(result)})`)
  startupCreated = true
}

async function rebuildConversations(): Promise<void> {
  if (!bridge || !startupCreated) return
  pageMode = 'conversations'
  const names = ['＋ 新建语音会话', ...conversations.slice(0, 19).map((item) => item.title || '未命名会话')]
  selectedIndex = Math.max(0, Math.min(selectedIndex, names.length - 1))
  await queueBridge(() => bridge!.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [
      textContainer(10, 'conversation-title', 8, 36, `Even Qwen · 会话 (${conversations.length})`, false),
      textContainer(12, 'conversation-help', 258, 24, '滑动选择 · Tap进入 · 长按刷新 · 双击退出', false, 2),
    ],
    listObject: [new ListContainerProperty({
      xPosition: 8, yPosition: 48, width: 560, height: 202, containerID: 11, containerName: 'conversation-list',
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: names.length, itemWidth: 540, isItemSelectBorderEn: 1, itemName: names.map((name) => name.slice(0, 64)),
      }),
    })],
  })))
}

async function rebuildVoice(): Promise<void> {
  if (!bridge || !startupCreated) return
  pageMode = 'voice'
  await queueBridge(() => bridge!.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [
      textContainer(20, 'voice-title', 8, 34, `Even Qwen · ${stageLabel(voiceStage)}`, false),
      textContainer(21, 'voice-content', 48, 194, currentPageText(), true),
      textContainer(22, 'voice-help', 252, 28, voiceHelp(), false, 2),
    ],
  })))
}

async function rebuildApproval(message: PendingApproval): Promise<void> {
  if (!bridge || !startupCreated) return
  pageMode = 'approval'
  const parameters = Object.entries(message.parameters).map(([key, value]) => `${key}: ${String(value)}`).join('\n')
  await queueBridge(() => bridge!.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [
      textContainer(30, 'approval-title', 8, 36, '工具确认', false),
      textContainer(31, 'approval-content', 50, 176, `${message.summary}\n\n${parameters}`.slice(0, 1900), true),
      textContainer(32, 'approval-help', 238, 40, 'Tap 批准 · 长按拒绝 · 双击退出', false, 2),
    ],
  })))
}

function stageLabel(stage: VoiceStage): string {
  return ({ connecting: '连接 Qwen', listening: '正在聆听', thinking: '思考中', responding: '回答中', idle: '待机', stopped: '已停止', error: '错误' })[stage]
}

function voiceHelp(): string {
  if (voiceStage === 'responding') return `Tap中止回答 · 滑动翻页 ${pageIndex + 1}/${pages.length} · 长按返回`
  return `Tap退出语音 · 滑动翻页 ${pageIndex + 1}/${pages.length} · 长按返回`
}

function currentPageText(): string {
  return (pages[pageIndex] || '等待语音…').slice(0, 2000)
}

function paginate(text: string): string[] {
  const normalized = text.trim() || '等待语音…'
  const result: string[] = []
  for (let offset = 0; offset < normalized.length; offset += PAGE_CHARS) result.push(normalized.slice(offset, offset + PAGE_CHARS))
  return result.length ? result : ['等待语音…']
}

function historyText(messages: ConversationMessage[]): string {
  return messages.slice(-8).map((message) => `${message.role === 'user' ? '我' : message.role === 'assistant' ? 'Qwen' : '工具'}：${message.text}`).join('\n\n')
}

function scheduleStreamUpdate(): void {
  if (streamTimer !== null) return
  streamTimer = window.setTimeout(() => {
    streamTimer = null
    const content = assistantText ? `Qwen：${assistantText}` : transcript ? `我：${transcript}` : stageLabel(voiceStage)
    pages = paginate(content)
    pageIndex = pages.length - 1
    if (pageMode === 'voice') void updateVoiceText()
  }, STREAM_UPDATE_MS)
}

async function updateVoiceText(): Promise<void> {
  if (!bridge || pageMode !== 'voice') return
  await queueBridge(async () => {
    await bridge!.textContainerUpgrade(new TextContainerUpgrade({ containerID: 20, containerName: 'voice-title', content: `Even Qwen · ${stageLabel(voiceStage)}` }))
    await bridge!.textContainerUpgrade(new TextContainerUpgrade({ containerID: 21, containerName: 'voice-content', content: currentPageText() }))
    await bridge!.textContainerUpgrade(new TextContainerUpgrade({ containerID: 22, containerName: 'voice-help', content: voiceHelp() }))
  })
}

function connectAgent(): void {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
  const url = localStorage.getItem(STORAGE_URL) || DEFAULT_AGENT_URL
  const token = localStorage.getItem(STORAGE_TOKEN) || DEFAULT_TOKEN
  if (!token) {
    authenticationFailed = true
    setPhoneStatus('等待配对令牌', '请在手机端填写 Even Qwen Agent 的 pairing token 并保存。')
    setStartupStatus('等待配置', '等待', '请在手机端填写配对令牌')
    return
  }
  authenticationFailed = false
  setPhoneStatus('正在连接 Agent…', url)
  setStartupStatus('连接中', '等待')
  const connectingSocket = new WebSocket(url)
  socket = connectingSocket
  connectingSocket.binaryType = 'arraybuffer'
  connectingSocket.addEventListener('open', () => {
    if (socket !== connectingSocket) return
    setPhoneStatus('Agent 已连接', url)
    setStartupStatus('认证中', '等待')
    send({ type: 'hello', token, clientName: 'Even Qwen G2' }, activeConversationId)
    sendDeviceStatus()
  })
  connectingSocket.addEventListener('message', (event) => {
    if (socket !== connectingSocket) return
    if (typeof event.data !== 'string') return
    try { void handleServerMessage(JSON.parse(event.data) as ServerMessage) }
    catch (error) { void logClient('error', `无法解析 Agent 消息: ${String(error)}`) }
  })
  connectingSocket.addEventListener('close', () => {
    if (socket !== connectingSocket) return
    socket = null
    if (authenticationFailed) return
    setPhoneStatus('Agent 已断开，正在重连…', url)
    setStartupStatus('已断开', '等待', '正在重连…')
    voiceStage = 'error'
    void closeMicrophone()
    if (foreground) reconnectTimer = window.setTimeout(connectAgent, 1500)
  })
  connectingSocket.addEventListener('error', () => {
    if (socket !== connectingSocket) return
    setPhoneStatus('Agent 连接失败', '检查 WSS 路由、Agent 服务和配对令牌。')
    setStartupStatus('连接失败', '等待', '请在手机端检查 WSS 地址')
  })
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  if (message.protocolVersion !== PROTOCOL_VERSION) return
  if (message.conversationId) {
    activeConversationId = message.conversationId
    localStorage.setItem(STORAGE_CONVERSATION, activeConversationId)
  }
  if (message.type === 'ready') {
    conversations = message.conversations
    authenticationFailed = false
    setStartupStatus('已连接', message.qwenReady ? '已就绪' : 'Key 未配置')
    setPhoneStatus(message.qwenReady ? 'Even Qwen 已就绪' : 'Agent 已连接，Qwen Key 未配置')
    await rebuildConversations()
    return
  }
  if (message.type === 'conversation.list.result') {
    conversations = message.conversations
    await rebuildConversations()
    return
  }
  if (message.type === 'conversation.created') {
    activeConversationId = message.conversation.id
    activeMessages = []
    transcript = ''
    assistantText = ''
    pages = ['正在连接 Qwen…']
    pageIndex = 0
    await startVoiceMode()
    return
  }
  if (message.type === 'conversation.open.result') {
    activeMessages = message.messages
    pages = paginate(historyText(activeMessages))
    pageIndex = pages.length - 1
    await startVoiceMode()
    return
  }
  if (message.type === 'voice.mode.status') {
    voiceStage = message.stage
    if (message.stage === 'listening') await openMicrophone()
    if (message.stage === 'stopped' || message.stage === 'error') await closeMicrophone()
    if (pageMode === 'voice') await updateVoiceText()
    return
  }
  if (message.type === 'transcript.delta') {
    transcript = message.snapshot ? message.delta : transcript + message.delta
    scheduleStreamUpdate()
    return
  }
  if (message.type === 'transcript.final') {
    transcript = message.text
    assistantText = ''
    pages = paginate(`我：${message.text}\n\nQwen：思考中…`)
    pageIndex = pages.length - 1
    await updateVoiceText()
    return
  }
  if (message.type === 'assistant.delta') {
    voiceStage = 'responding'
    assistantText += message.delta
    scheduleStreamUpdate()
    return
  }
  if (message.type === 'assistant.final') {
    voiceStage = 'listening'
    assistantText = message.text
    pages = paginate(`我：${transcript}\n\nQwen：${message.text}`)
    pageIndex = pages.length - 1
    await updateVoiceText()
    return
  }
  if (message.type === 'assistant.cancelled') {
    voiceStage = 'listening'
    assistantText = assistantText ? `${assistantText}\n\n[回答已中止]` : '[回答已中止]'
    pages = paginate(assistantText)
    pageIndex = pages.length - 1
    await updateVoiceText()
    return
  }
  if (message.type === 'tool.approval.request') {
    pendingApproval = message
    await rebuildApproval(message)
    return
  }
  if (message.type === 'client.tool.request') {
    send({ type: 'client.tool.result', requestId: message.requestId, toolCallId: message.toolCallId, ok: true, result: deviceStatus })
    return
  }
  if (message.type === 'error') {
    setPhoneStatus(`错误：${message.message}`)
    if (message.code === 'unauthorized') {
      authenticationFailed = true
      setStartupStatus('认证失败', '等待', '配对令牌无效，请在手机端更新')
    } else if (pageMode === 'startup') {
      setStartupStatus('错误', '等待', message.message.slice(0, 80))
    }
    if (pageMode === 'voice') {
      pages = paginate(`错误：${message.message}`)
      pageIndex = 0
      await updateVoiceText()
    }
  }
}

async function openSelectedConversation(): Promise<void> {
  if (selectedIndex === 0) {
    send({ type: 'conversation.create', requestId: requestId() }, '')
    return
  }
  const conversation = conversations[selectedIndex - 1]
  if (!conversation) return
  activeConversationId = conversation.id
  localStorage.setItem(STORAGE_CONVERSATION, activeConversationId)
  send({ type: 'conversation.open', requestId: requestId() })
}

async function startVoiceMode(): Promise<void> {
  voiceStage = 'connecting'
  await rebuildVoice()
  send({ type: 'voice.mode.start', requestId: requestId() })
}

async function stopVoiceMode(): Promise<void> {
  send({ type: 'voice.mode.stop', requestId: requestId() })
  await closeMicrophone()
  voiceStage = 'stopped'
  selectedIndex = 0
  send({ type: 'conversation.list', requestId: requestId() }, activeConversationId)
}

async function openMicrophone(): Promise<void> {
  if (!bridge || microphoneOpen || !startupCreated || !foreground) return
  const opened = await queueBridge(() => bridge!.audioControl(true, AudioInputSource.Glasses))
  microphoneOpen = opened
  if (!opened) throw new Error('无法打开 G2 麦克风')
}

async function closeMicrophone(): Promise<void> {
  if (!bridge || !microphoneOpen) return
  await queueBridge(() => bridge!.audioControl(false))
  microphoneOpen = false
}

async function handleTap(): Promise<void> {
  if (pageMode === 'startup') {
    if (authenticationFailed) {
      setStartupStatus('认证失败', '等待', '请在手机端更新配对令牌')
      return
    }
    setStartupStatus('正在重试', '等待')
    connectAgent()
    return
  }
  if (pageMode === 'conversations') {
    await openSelectedConversation()
    return
  }
  if (pageMode === 'approval' && pendingApproval) {
    send({ type: 'tool.approval.resolve', requestId: requestId(), toolCallId: pendingApproval.toolCallId, approved: true })
    pendingApproval = null
    await rebuildVoice()
    return
  }
  if (pageMode === 'voice' && voiceStage === 'responding') {
    send({ type: 'response.cancel', requestId: requestId() })
    voiceStage = 'listening'
    await updateVoiceText()
    return
  }
  if (pageMode === 'voice') await stopVoiceMode()
}

async function handleLongPress(): Promise<void> {
  if (pendingApproval && pageMode === 'approval') {
    send({ type: 'tool.approval.resolve', requestId: requestId(), toolCallId: pendingApproval.toolCallId, approved: false })
    pendingApproval = null
    await rebuildVoice()
    return
  }
  if (pageMode === 'conversations') {
    send({ type: 'conversation.list', requestId: requestId() }, activeConversationId)
    return
  }
  await stopVoiceMode()
}

async function exitApp(): Promise<void> {
  if (tapTimer !== null) { clearTimeout(tapTimer); tapTimer = null }
  foreground = false
  send({ type: 'voice.mode.stop', requestId: requestId() })
  await closeMicrophone()
  socket?.close(1000, 'app exit')
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  if (bridge && startupCreated) await queueBridge(() => bridge!.shutDownPageContainer(0))
}

function explicitEventType(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  return envelope?.eventType ?? null
}

function capturedContainer(envelope?: { containerID?: number }): boolean {
  if (!envelope) return false
  const activeContainer = ({ startup: 1, conversations: 11, voice: 21, approval: 31 })[pageMode]
  return envelope.containerID === activeContainer
}

function inputType(event: EvenHubEvent): { type: OsEventTypeList | null; legacyClick: boolean } {
  const explicitType = explicitEventType(event.listEvent)
    ?? explicitEventType(event.textEvent)
    ?? explicitEventType(event.sysEvent)
  // CLICK_EVENT is protobuf value 0 and some Even App versions omit zero-valued
  // fields. A physical Tap then arrives as a captured envelope without eventType.
  const legacyClick = explicitType === null
    && (Boolean(event.sysEvent) || capturedContainer(event.listEvent) || capturedContainer(event.textEvent))
  return { type: explicitType ?? (legacyClick ? OsEventTypeList.CLICK_EVENT : null), legacyClick }
}

function handleInput(event: EvenHubEvent): void {
  if (event.audioEvent?.audioPcm && socket?.readyState === WebSocket.OPEN && microphoneOpen && voiceStage === 'listening') {
    socket.send(event.audioEvent.audioPcm)
  }
  const { type, legacyClick } = inputType(event)
  if (event.listEvent?.currentSelectItemIndex !== undefined && pageMode === 'conversations') {
    selectedIndex = Math.max(0, Math.min(event.listEvent.currentSelectItemIndex, conversations.length))
  }
  if (type === null) return
  const now = Date.now()
  if (now - lastInputAt < 40) return
  lastInputAt = now
  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (tapTimer !== null) { clearTimeout(tapTimer); tapTimer = null }
    void exitApp()
    return
  }
  if (type === OsEventTypeList.LONG_PRESS_EVENT) {
    if (tapTimer !== null) { clearTimeout(tapTimer); tapTimer = null }
    void handleLongPress()
    return
  }
  if (type === OsEventTypeList.CLICK_EVENT) {
    if (legacyClick && (displayUpdateDepth > 0 || now < displayEchoIgnoreUntil)) return
    if (now - lastHandledTapAt < TAP_DEBOUNCE_MS) return
    lastHandledTapAt = now
    void logClient('info', `tap received: page=${pageMode}, stage=${voiceStage}, legacy=${legacyClick}`)
    if (tapTimer !== null) clearTimeout(tapTimer)
    tapTimer = window.setTimeout(() => { tapTimer = null; void handleTap() }, 280)
    return
  }
  if (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    const delta = type === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1
    if (pageMode === 'voice') {
      pageIndex = Math.max(0, Math.min(pages.length - 1, pageIndex + delta))
      void updateVoiceText()
    }
  }
  if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    foreground = false
    send({ type: 'voice.mode.stop', requestId: requestId() })
    void closeMicrophone()
  }
  if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    foreground = true
    connectAgent()
    if (startupCreated) void rebuildConversations()
  }
}

function sanitizeDevice(status?: DeviceStatus | null): DeviceStatusSnapshot {
  return {
    connected: status?.connectType === DeviceConnectType.Connected,
    ...(Number.isFinite(status?.batteryLevel) ? { batteryLevel: Math.max(0, Math.min(100, Number(status!.batteryLevel))) } : {}),
    ...(typeof status?.isCharging === 'boolean' ? { isCharging: status.isCharging } : {}),
    ...(typeof status?.isWearing === 'boolean' ? { isWearing: status.isWearing } : {}),
    ...(typeof status?.isInCase === 'boolean' ? { isInCase: status.isInCase } : {}),
  }
}

function sendDeviceStatus(): void {
  send({ type: 'device.status', status: deviceStatus })
}

async function logClient(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
  send({ type: 'client.log', level, message })
}

async function initialize(): Promise<void> {
  urlInput.value = localStorage.getItem(STORAGE_URL) || DEFAULT_AGENT_URL
  tokenInput.value = localStorage.getItem(STORAGE_TOKEN) || DEFAULT_TOKEN
  bridge = await waitForEvenAppBridge()
  unsubscribers.push(bridge.onLaunchSource((source) => void logClient('info', `launch source: ${source}`)))
  unsubscribers.push(bridge.onDeviceStatusChanged((status) => {
    deviceStatusKnown = true
    deviceStatus = sanitizeDevice(status)
    void updateStartupStatus()
    sendDeviceStatus()
  }))
  unsubscribers.push(bridge.onEvenHubEvent(handleInput))
  await createStartup()
  try {
    const deviceInfo = await bridge.getDeviceInfo()
    deviceStatusKnown = true
    deviceStatus = sanitizeDevice(deviceInfo?.status)
    await updateStartupStatus()
  } catch {
    deviceStatusKnown = false
  }
  connectAgent()
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  localStorage.setItem(STORAGE_URL, urlInput.value.trim())
  localStorage.setItem(STORAGE_TOKEN, tokenInput.value)
  authenticationFailed = false
  const previousSocket = socket
  socket = null
  previousSocket?.close(1000, 'settings changed')
  connectAgent()
})

window.addEventListener('beforeunload', () => {
  if (microphoneOpen) void bridge?.audioControl(false)
  socket?.close(1000, 'page unload')
})

void initialize().catch((error) => {
  setPhoneStatus('Even Qwen 启动失败', error instanceof Error ? error.message : String(error))
})
