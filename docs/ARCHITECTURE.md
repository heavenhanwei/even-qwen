# Even Qwen architecture

```text
G2 → Even App / EvenHub SDK → WSS → Even Qwen Agent → Qwen Omni
                                      ├─ text session store
                                      ├─ Even device RPC
                                      └─ allowlisted desktop tools
```

## Protocol v2

JSON 控制消息始终携带 `conversationId`；回答携带 `responseId`；工具调用携带 `requestId`/`toolCallId`。音频是二进制 16 kHz、16-bit LE、mono PCM。Qwen semantic VAD 自动提交语音轮次。

Agent 不包含 Codex CLI、Codex 任务协议、app-server 或 Paraformer。Codex 只作为 `app_list`、`app_open`、`app_focus` 的固定应用 ID。

会话写入 `%LOCALAPPDATA%\\EvenQwen\\sessions`，最多 50 个；恢复时最多回放最近 20 条、32K 字符。Bridge 写操作串行，流式文本每 200 ms 合并一次。

