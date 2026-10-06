# even-chatgpt

Voice-first Even G2 client for viewing and controlling local Codex tasks.

## Status

The repository provides a working local voice-to-Codex path:

- an EvenHub/Vite client that renders connection state on the G2 display;
- G2 microphone capture and 16 kHz PCM streaming;
- a local WebSocket desktop agent;
- a private stdio bridge to `codex app-server`;
- Codex account-status and thread-list requests;
- Qwen Omni realtime voice routing with Paraformer realtime ASR fallback;
- voice-created Codex threads and voice turns on existing threads;
- account and hardware setup documentation.

## Prerequisites

- Node.js 22.6 or newer
- EvenHub CLI and simulator
- Codex CLI
- an Even Realities account for device testing
- a ChatGPT/Codex login or OpenAI API key for Codex access
- an Alibaba Cloud Model Studio API key and Beijing workspace ID for Qwen Omni and Paraformer

See [Account setup](docs/ACCOUNT_SETUP.md) for the complete checklist.
See [Deployment and public demo](docs/DEPLOYMENT.md) for portable-router,
public-WSS, packaging, and Even Hub publication instructions.

## Install

```powershell
npm install
Copy-Item .env.example .env
npm run check:accounts
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

The G2 client defaults to `ws://127.0.0.1:8787` in the simulator. For physical glasses, follow the LAN and pairing instructions in [Account setup](docs/ACCOUNT_SETUP.md).

## Current G2 controls

- On launch, the client discovers recent user-facing Codex threads and highlights the first one.
- The first list item, **+ New voice task**, creates a new Codex thread from speech.
- Swipe up or down to move the task selection.
- Long-press to refresh the task list.
- Tap once to connect the configured voice provider and start recording. Partial Qwen/Paraformer transcripts are shown live on the glasses; tap again to close the microphone, finalize the transcript, and submit it to Codex.
- Selecting an existing thread sends the spoken instruction to that thread.
- Double-tap to exit the app.

New voice tasks default to Codex's read-only sandbox. Set `CODEX_SANDBOX_MODE=workspace-write` only after explicitly accepting that spoken tasks may change workspace files.

## Verify

```powershell
npm run typecheck
npm run build
```

## Security note

Production builds do not embed the Agent URL or pairing token. Configure them on
the phone companion page after installation. Keep provider keys and Codex auth on
the desktop, and expose the Agent only through a TLS-protected tunnel with a
strong pairing token; never open port 8787 directly to the internet.

