# Even Qwen

基于 Even G2、EvenHub SDK 和 `qwen3.8-omni-flash-realtime` 的连续语音助手。Qwen Omni 统一负责语音理解、回答和工具决策；Codex 仅是可打开或切换的白名单 Windows 应用。

## Status

实现范围：

- G2 端连续语音、实时字幕、回答分页、历史会话和工具确认；
- Protocol v2 与经过配对令牌保护的 WebSocket；
- Qwen semantic VAD 自动成轮，无需 Tap 提交；
- 最多 50 个本地文本会话，不保存音频或密钥；
- 固定桌面应用白名单与 HTTP/HTTPS、剪贴板工具；
- 设备状态只暴露连接、电量、充电、佩戴和入盒状态。

## Prerequisites

- Node.js 22.6 or newer
- EvenHub CLI and simulator
- an Even Realities account for device testing
- an Alibaba Cloud Model Studio API key for Qwen Omni

See [Account setup](docs/ACCOUNT_SETUP.md) for the complete checklist.
See [Deployment and public demo](docs/DEPLOYMENT.md) for portable-router,
public-WSS, packaging, and Even Hub publication instructions.

## Install

```powershell
npm install
Copy-Item .env.example .env
npm run check:config -w @even-qwen/desktop-agent
```

## Run locally

Terminal 1:

```powershell
npm run dev:agent
```

Terminal 2:

```powershell
npm run dev:g2
```

Terminal 3:

```powershell
npm run simulator
```

应用默认连接 `wss://even-qwen.ifelse.work`。模拟器本地调试时在手机页面改为 `ws://127.0.0.1:8787`；详见 [部署说明](docs/DEPLOYMENT.md)。

## Current G2 controls

- 会话列表 Tap：创建或打开会话并进入连续语音。
- 聆听中 Tap：退出语音模式，未成轮音频丢弃。
- 回答中 Tap：中止回答并恢复聆听。
- 工具确认页 Tap：批准；长按：拒绝。
- 普通页面长按：返回/刷新会话列表。
- 任意页面双击：立即退出。

## Verify

```powershell
npm run typecheck
npm run build
npm test
npm run pack:g2
```

## Security note

生产包不嵌入 API Key。Qwen Key 只存在桌面 Agent 的 `.env`；公网仅通过 TLS Tunnel 暴露 WSS，并使用强配对令牌。不要直接将 8787 端口暴露到互联网。

