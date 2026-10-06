# Initial architecture

```text
Even G2
  microphone / touch / display
             │ Bluetooth
             ▼
Even Realities App WebView
  apps/g2-client
             │ authenticated WebSocket
             ▼
Desktop Agent
  apps/desktop-agent
  ├─ session and pairing boundary
  ├─ VoiceProvider boundary
  │  ├─ Qwen Omni realtime task-router adapter
  │  └─ Paraformer realtime ASR fallback adapter
  ├─ read-only-by-default Codex policy boundary
  └─ Codex adapter
       │ private stdio JSON-RPC
       ▼
  codex app-server
```

## Current protocol

The client sends JSON control messages and binary 16 kHz PCM frames. The desktop agent currently implements:

- `hello`
- `ping`
- `account.status`
- `tasks.list`
- `voice.start`
- binary PCM audio frames
- `voice.stop`

The agent returns connection status, task lists, audio acknowledgements, voice-routing state, and Codex turn progress/results. Voice sessions buffer at most 60 seconds of PCM so the same utterance can be replayed to Paraformer if the primary Omni request fails.

## Next milestone

Add desktop approval handling for write-capable Codex turns and optional Qwen TTS playback. Destructive and external actions must remain desktop-confirmed.

