# Repository guidance

This repository contains two trust zones:

- `apps/g2-client` runs in the Even Realities phone WebView. Treat every value bundled here as public.
- `apps/desktop-agent` runs on the user's computer and is the only place allowed to hold provider keys or execute tools.

Security invariants:

- Never put API keys, Codex tokens, or long-lived pairing credentials in `VITE_*` variables.
- Never expose `codex app-server` directly to the phone or network. The desktop agent owns its stdio connection.
- Validate every model-produced tool call before execution.
- Read-only actions may run automatically. Writes require an explicit policy decision; destructive or external actions require desktop confirmation.
- Do not commit `.env`, Codex auth caches, recordings, or user task transcripts.

Run `npm run typecheck` and `npm run build` before committing implementation changes.

