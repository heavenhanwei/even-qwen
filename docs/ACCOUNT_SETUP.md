# Account and device setup

## 1. Even Realities account

1. Install the Even Realities phone app.
2. Create the account inside the phone app. The web developer portal does not create accounts.
3. Sign in to <https://hub.evenrealities.com/login> with the same email and password.
4. Force-quit and reopen the phone app. The Even Hub developer section and **Scan QR** action should appear.
5. Pair the Even G2 under **Devices → Add device**, then install the latest firmware.

The phone and development computer must be on a network that allows device-to-device traffic. On Windows, allow the Vite development port and desktop-agent port through the Private firewall profile only.

Official references:

- <https://hub.evenrealities.com/docs/get-started/quickstart/sign-in>
- <https://hub.evenrealities.com/docs/get-started/quickstart/hardware>

## 2. Codex account

For this local prototype, reuse the Codex login already stored on the computer:

```powershell
codex login status
```

If sign-in is required, choose one:

```powershell
codex login
codex login --device-auth
```

Codex supports ChatGPT subscription authentication and OpenAI API-key authentication. The local desktop agent starts `codex app-server` over stdio so credentials never pass through the EvenHub web client.

Official references:

- <https://learn.chatgpt.com/docs/auth>
- <https://learn.chatgpt.com/docs/app-server>

For a personal/local open-source prototype, app-server can use the local account. A commercial or hosted product must not reuse app-server authentication as end-user authentication; plan a supported **Sign in with ChatGPT** integration before distribution.

## 3. Qwen voice-provider account

Create an Alibaba Cloud Model Studio workspace and API key in Beijing. Beijing is required when `paraformer-realtime-v2` is enabled as the fallback. Configure:

```dotenv
VOICE_PROVIDER=qwen-omni
VOICE_FALLBACK_PROVIDER=paraformer
DASHSCOPE_API_KEY=sk-...
DASHSCOPE_WORKSPACE_ID=your-workspace-id
DASHSCOPE_REGION=cn-beijing
QWEN_OMNI_MODEL=qwen3.8-omni-flash-realtime
PARAFORMER_MODEL=paraformer-realtime-v2
PARAFORMER_LANGUAGE_HINTS=zh
```

The desktop Agent first uses Qwen Omni to turn speech into a structured Codex instruction. If Omni cannot start or finish, it replays the buffered PCM audio to Paraformer and uses the transcript directly. The G2 client never receives the API key.

Other providers remain architectural options but are not wired into this build:

| Provider | Environment variable | VoiceRouter role |
| --- | --- | --- |
| Qwen / Alibaba Cloud Model Studio | `DASHSCOPE_API_KEY` | Omni task routing with Paraformer ASR fallback |
| Gemini API | `GEMINI_API_KEY` | Live audio model |
| OpenAI Realtime | `OPENAI_API_KEY` | Realtime speech-to-speech model |
| Claude | `ANTHROPIC_API_KEY` | Text reasoning after a separate ASR stage |

Keep provider keys in the desktop agent's environment. Never place them in a `VITE_*` variable because Vite embeds those values into browser JavaScript.

## 4. Local configuration

Copy the template:

```powershell
Copy-Item .env.example .env
```

The default binding is loopback-only and works with the simulator. To test physical glasses on the LAN:

1. Generate a long random `AGENT_PAIRING_TOKEN`.
2. Set `AGENT_BIND_HOST=0.0.0.0`.
3. Set `VITE_AGENT_WS_URL=ws://<computer-lan-ip>:8787`.
4. Set `VITE_AGENT_PAIRING_TOKEN` to the same temporary development token.
5. Add the exact agent origin to the `network` whitelist in `apps/g2-client/app.json` before packaging.
6. Restrict Windows Firewall access to the Private network profile.

The `VITE_AGENT_PAIRING_TOKEN` flow is for development only because it is visible in the built client. Production pairing will use a one-time QR challenge and short-lived session credentials.

## 5. Checks that require the user

- [ ] Even Realities phone account created.
- [ ] Same account successfully opens the Even Hub developer portal.
- [ ] Developer section appears after restarting the phone app.
- [ ] G2 is paired and firmware is current.
- [ ] `codex login status` reports a valid account.
- [ ] At least one voice provider is selected before voice-model work begins.
- [ ] A globally unique reverse-DNS `package_id` replaces `com.yourname.evenchatgpt` before packaging.

