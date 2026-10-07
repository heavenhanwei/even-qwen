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

## 2. Qwen Omni account

Create an Alibaba Cloud Model Studio workspace and API key in the selected region. Configure:

```dotenv
DASHSCOPE_API_KEY=sk-...
DASHSCOPE_WORKSPACE_ID=your-workspace-id
DASHSCOPE_REGION=cn-beijing
QWEN_OMNI_MODEL=qwen3.8-omni-flash-realtime
```

Qwen Omni is the only model path and handles audio understanding, answer generation and tool choice. The G2 client never receives the API key. Never place the key in a `VITE_*` variable because Vite embeds those values into browser JavaScript.

## 3. Local configuration

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

The `VITE_AGENT_PAIRING_TOKEN` flow is for development only because it is visible in the built client. In production, enter the token on the phone companion page; do not set it while building.

## 4. Checks that require the user

- [ ] Even Realities phone account created.
- [ ] Same account successfully opens the Even Hub developer portal.
- [ ] Developer section appears after restarting the phone app.
- [ ] G2 is paired and firmware is current.
- [ ] Qwen API Key and workspace belong to the configured region.
- [ ] `package_id` is `com.ifelsework.evenqwen` and the exact WSS hostname is whitelisted.

