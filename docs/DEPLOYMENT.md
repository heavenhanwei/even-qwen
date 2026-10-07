# Deployment and public demo

## Recommended architecture

Agent 可以运行在演示电脑或 Windows 服务器上。只有需要 `app_open`、`app_focus`、浏览器和剪贴板工具时，Agent 才必须运行在被控制的那台 Windows 电脑上。不要把 Qwen Key 或会话目录复制进 G2 包。

```text
Even G2
  -> Even phone app / packaged WebView
  -> wss://even-qwen.ifelse.work
  -> outbound-only tunnel
  -> ws://127.0.0.1:8788 desktop Agent
  -> Qwen Omni + allowlisted Windows tools
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
4. Enter `ws://<computer-ip>:8788` and the pairing token in the phone page.
5. Keep Windows Firewall restricted to the router's private subnet.

Public venue Wi-Fi is not recommended because client isolation commonly blocks
phone-to-computer traffic.

## Option B: Internet demo with a fixed WSS hostname

Use this when the glasses and phone leave the local network while the Agent
computer remains online. A named Cloudflare Tunnel is one workable transport;
the same topology can be implemented with another managed reverse tunnel.

### 1. Harden the desktop Agent

Keep these values only in the ignored root `.env`:

```dotenv
AGENT_BIND_HOST=127.0.0.1
AGENT_PORT=8788
AGENT_PAIRING_TOKEN=<at-least-32-random-bytes>
```

Start the Agent:

```powershell
npm run dev:agent
```

### 2. Create the tunnel

在 Cloudflare 的现有 Tunnel 中新增独立 Public Hostname：

```text
even-qwen.ifelse.work → http://127.0.0.1:8788
```

客户端使用：

```text
wss://even-qwen.ifelse.work
```

Run the generated `cloudflared` connector command on the Agent computer. Tunnel
credentials and connector tokens are secrets and must not be stored in this
repository. The G2 client connects to the public endpoint as:

```text
wss://even-qwen.ifelse.work
```

The tunnel is outbound-only, so port 8788 does not need to be opened on the
router. The pairing token is still required at the application layer.

### 3. Declare the exact production host

Even Hub publication enforces the manifest network whitelist. Add an exact
network permission to `apps/g2-client/app.json` before producing the public
release:

```json
{
  "name": "network",
      "desc": "Connects securely to the user's Even Qwen Agent.",
      "whitelist": ["wss://even-qwen.ifelse.work"]
}
```

Do not use a temporary tunnel hostname for an Even Hub release: changing the
hostname requires editing the whitelist and repacking the app.

### 4. Build and package

当前发布身份为 `com.ifelsework.evenqwen`；每次发布递增 `version`。

```powershell
npm run typecheck
npm run build
npm test
npm run pack:g2
```

`pack:g2` runs a release secret scan before creating `even-qwen.ehpk`. The
artifact is ignored by Git.

### 5. Configure the installed phone app

Open the Even Qwen companion page and enter:

- Agent URL: `wss://even-qwen.ifelse.work`
- Pairing token: the value in the desktop `.env`

Select **Save and reconnect**. Never put the pairing token in `app.json`, a
`VITE_*` production variable, Git, screenshots, or the Even Hub listing.

The glasses startup page reports the failing phase directly:

- **等待配置**: enter the pairing token on the phone companion page.
- **认证失败**: the phone has an old or incorrect token; replace it with the
  `AGENT_PAIRING_TOKEN` from this project's ignored `.env`.
- **连接失败**: verify the WSS hostname, tunnel route, and local Agent process.
- **G2 未连接**: reconnect the glasses in the Even app before starting voice mode.

## Even Hub publication

1. Log in with the same Even account used by the phone app: `evenhub login`.
2. Confirm the final `package_id` is `com.ifelsework.evenqwen`.
3. Add the exact `wss://` production hostname to the network whitelist.
4. Check package-id availability:

   ```powershell
   evenhub pack apps/g2-client/app.json apps/g2-client/dist --check
   ```

5. Run `npm run pack:g2`.
6. Upload `even-qwen.ehpk` in the Even Hub developer portal and submit it for
   validation/review.

The CLI creates the package but does not publish it automatically; portal upload
and review are separate steps.

## GitHub release

新仓库为 `https://github.com/heavenhanwei/even-qwen`，从本项目历史创建，不覆盖旧仓库。发布前执行：

```powershell
git status --short
npm run typecheck
npm run build
npm test
npm run pack:g2
git ls-files | Select-String -Pattern '(^|/)(\.env|sessions)(/|$)|\.ehpk$'
```

提交身份：

```powershell
git config user.name heavenhanwei
git config user.email heavenhanwei@gmail.com
```

只推送源码、锁文件和文档；`.env`、Qwen Key、Pairing Token、Tunnel Token、会话目录、本机应用路径、构建目录和 `.ehpk` 均不得进入 Git。

## Server deployment boundary

Agent 可部署到 Windows Server 并通过 Cloudflare Tunnel 提供 WSS。此时语音、会话和 Qwen 工具决策正常工作；但 `app_open`、`app_focus`、浏览器及剪贴板操作作用于服务器自身，而不是用户随身电脑。若演示需要控制随身电脑，应让 Agent 与 Tunnel connector 都运行在该电脑上。

## Security and operations checklist

- Keep `.env`, tunnel credentials, pairing token, and Qwen API keys only on the Agent computer.
- Bind the Agent to `127.0.0.1` when using a local tunnel connector.
- Use `wss://`, never public plaintext `ws://`.
- Rotate the pairing token before every external demo and after a lost phone.
- Stop the Agent and tunnel when the demo ends.
- Confirm the process does not expose port 8788 through Windows Firewall or router forwarding.
- Do not commit `.ehpk`, `dist`, logs, audio samples, or local credential files.

