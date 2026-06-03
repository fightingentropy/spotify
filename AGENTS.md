# AGENTS.md

## Cursor Cloud specific instructions

### Runtime

- **Package manager:** [Bun](https://bun.sh). If `bun` is missing, install with `curl -fsSL https://bun.sh/install | bash` and ensure `~/.bun/bin` is on `PATH`.
- **Single app:** React client + Cloudflare Worker API (`bun run dev` on port **5174**) + optional Bun local music server (`bun run local:music`, typically port **5175**).
- Production `wrangler.jsonc` sets `MAC_MINI_ORIGIN` to the remote Mac mini. For local E2E, point the Worker at the local music server via a gitignored **`.env`** file (see `.env.example`):

  ```bash
  MAC_MINI_ORIGIN=http://127.0.0.1:5175
  ```

  The Cloudflare Vite plugin loads `.env` into the Worker during `vite dev` when no `.dev.vars` is present.

### Services (local dev)

| Service | Command | Port |
|--------|---------|------|
| Vite + Worker | `bun run dev` | 5174 |
| Local music server | `SPOTIFY_MUSIC_DIR=<dir> PORT=5175 SPOTIFY_DIST_DIR=dist/client bun run local:music` | 5175 |

Start the music server **after** `bun run build` (it serves `dist/client`). Use a music directory with at least one audio file (e.g. `local-media/music/`).

**Port conflict:** both default to 5174; always run the music server on another port (e.g. 5175).

**Vite bind address:** dev may listen on IPv6 `::1` only. Prefer `http://localhost:5174` over `http://127.0.0.1:5174` if connections fail.

### Verify / quality gates

See `README.md` for full ops docs. Common checks:

```bash
bun run lint
bun --bun tsc --noEmit
bun run build
```

There is no automated test script in `package.json`.

### Secrets

- Remote Mac mini mode needs `MAC_MINI_PROXY_TOKEN` (Worker secret) matching `SPOTIFY_PROXY_TOKEN` on the music server.
- Local loopback proxying does not require tokens when `SPOTIFY_PROXY_TOKEN` is unset and the music server sees `127.0.0.1` / private hosts.

### Hello-world flow

1. `bun install && bun run build`
2. Add sample audio under `local-media/music/`
3. Start local music server on 5175 (see table above)
4. Ensure `.env` sets `MAC_MINI_ORIGIN=http://127.0.0.1:5175`
5. `bun run dev` → open `http://localhost:5174` → confirm `demo-track` (or your files) on Home and playback via the player bar

Auth (optional): `POST /api/register` then `POST /api/auth/signin` (session cookie `spotify_session`).
