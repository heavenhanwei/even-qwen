# Repository guidance

This repository contains two trust zones:

- `apps/g2-client` runs in the Even Realities phone WebView. Treat every value bundled here as public.
- `apps/desktop-agent` runs on the user's computer and is the only place allowed to hold provider keys or execute tools.

Security invariants:

- Never put API keys or long-lived pairing credentials in `VITE_*` variables.
- Do not add Codex CLI, Codex app-server, shell, arbitrary executable paths, or arbitrary process arguments. Codex is only a fixed allowlisted desktop application ID.
- Validate every model-produced tool call before execution.
- Qwen Omni is the only speech, response, and tool-decision provider. Do not add fallback ASR or secondary model routing without a user-visible architecture change.
- Read-only status and app-list operations may run automatically. App open/focus, browser navigation, and clipboard access require explicit G2 confirmation.
- Do not commit `.env`, provider credentials, tunnel credentials, recordings, or user conversation files.

Run `npm run typecheck` and `npm run build` before committing implementation changes.

