# Deployment and public demo

## Recommended architecture

The desktop Agent should remain on the computer that owns the Codex login and
workspace. Do not copy the Codex session, Alibaba API key, or workspace files to
the G2 package.

```text
Even G2
  -> Even phone app / packaged WebView
  -> wss://agent.example.com
  -> outbound-only tunnel
  -> ws://127.0.0.1:8787 desktop Agent
  -> local Codex app-server + Qwen/Paraformer
```

The production G2 build does not embed the Agent URL or pairing token. Configure
both from the companion-page form after installing the package. They are stored
only in that phone's WebView local storage.

## Option A: portable-router demo

This is the most reliable exhibition setup when the computer travels with the
glasses:

1. Use a travel router with Wi-Fi for the phone and Ethernet or Wi-Fi for the
   computer.
2. Reserve a stable computer address in the router.
3. Bind the Agent to the private interface with a strong pairing token.
4. Enter `ws://<computer-ip>:8787` and the pairing token in the phone page.
5. Keep Windows Firewall restricted to the router's private subnet.

Public venue Wi-Fi is not recommended because client isolation commonly blocks
phone-to-computer traffic.

## Option B: Internet demo with a fixed WSS hostname

Use this when the glasses and phone leave the local network while the Codex
computer remains online. A named Cloudflare Tunnel is one workable transport;
the same topology can be implemented with another managed reverse tunnel.

### 1. Harden the desktop Agent

Keep these values only in the ignored root `.env`:

```dotenv
AGENT_BIND_HOST=127.0.0.1
AGENT_PORT=8787
AGENT_PAIRING_TOKEN=<at-least-32-random-bytes>
```

Start the Agent:

```powershell
npm run dev:agent
```

### 2. Create the tunnel

In Cloudflare, create a named tunnel and a fixed public hostname such as
`agent.example.com`. Route that hostname to:

```text
http://localhost:8787
```

Run the generated `cloudflared` connector command on the Codex computer. Tunnel
credentials and connector tokens are secrets and must not be stored in this
repository. The G2 client connects to the public endpoint as:

```text
wss://agent.example.com
```

The tunnel is outbound-only, so port 8787 does not need to be opened on the
router. The pairing token is still required at the application layer.

### 3. Declare the exact production host

Even Hub publication enforces the manifest network whitelist. Add an exact
network permission to `apps/g2-client/app.json` before producing the public
release:

```json
{
  "name": "network",
  "desc": "Connects securely to the user's desktop Codex Agent.",
  "whitelist": ["wss://agent.example.com"]
}
```

Do not use a temporary tunnel hostname for an Even Hub release: changing the
hostname requires editing the whitelist and repacking the app.

### 4. Build and package

Before packing, replace the placeholder `package_id` with a unique lowercase
reverse-domain identifier owned by the publisher and increment `version`.

```powershell
npm run typecheck
npm run build
npm run pack:g2
```

`pack:g2` runs a release secret scan before creating `even-chatgpt.ehpk`. The
artifact is ignored by Git.

### 5. Configure the installed phone app

Open the Even ChatGPT companion page and enter:

- Agent URL: `wss://agent.example.com`
- Pairing token: the value in the desktop `.env`

Select **Save and reconnect**. Never put the pairing token in `app.json`, a
`VITE_*` production variable, Git, screenshots, or the Even Hub listing.

## Even Hub publication

1. Log in with the same Even account used by the phone app: `evenhub login`.
2. Choose the final `package_id`; it cannot be the current
   `com.yourname.evenchatgpt` placeholder.
3. Add the exact `wss://` production hostname to the network whitelist.
4. Check package-id availability:

   ```powershell
   evenhub pack apps/g2-client/app.json apps/g2-client/dist --check
   ```

5. Run `npm run pack:g2`.
6. Upload `even-chatgpt.ehpk` in the Even Hub developer portal and submit it for
   validation/review.

The CLI creates the package but does not publish it automatically; portal upload
and review are separate steps.

## Security and operations checklist

- Keep `.env`, tunnel credentials, Codex auth, and API keys only on the desktop.
- Bind the Agent to `127.0.0.1` when using a local tunnel connector.
- Use `wss://`, never public plaintext `ws://`.
- Rotate the pairing token before every external demo and after a lost phone.
- Stop the Agent and tunnel when the demo ends.
- Keep `CODEX_SANDBOX_MODE=read-only` for demonstrations unless writes are
  explicitly required.
- Do not commit `.ehpk`, `dist`, logs, audio samples, or local credential files.

