# Spotify

Spotify is a Vite React music app served by a Cloudflare Worker. The current
production setup uses Cloudflare for the public app, auth, and API edge, while
the Mac mini is the music storage and streaming backend.

## Current Production Setup

- Public app: `https://spotify.fightingentropy.org`
- Mac mini LAN app/server: `http://m4mini.local:5174`
- Private Worker-to-Mac-mini origin: `https://spotify-origin.fightingentropy.org`
- Mac mini music folder: `/Users/hermes/Music`
- Remote app folder on Mac mini: `/Users/hermes/Developer/spotify`
- Music server launchd service: `com.fightingentropy.spotify-app`

The private origin hostname is only for Worker-to-Mac-mini traffic. Direct
public requests to `spotify-origin.fightingentropy.org` should return `401` unless the
request includes the shared proxy token.

## Architecture

```text
Phone/browser
  -> Cloudflare Worker + static assets
       -> auth/session in D1
       -> Spotify metadata/import helpers
       -> proxy music APIs to Mac mini when MAC_MINI_ORIGIN is set
            -> Cloudflare Tunnel origin: spotify-origin.fightingentropy.org
                 -> Mac mini local server on 127.0.0.1:5174
                      -> /Users/hermes/Music
```

In the active deployed mode, uploaded/imported music is not stored in R2. R2 is
still configured as a fallback/legacy storage mode, but `MAC_MINI_ORIGIN` makes
the Worker use the Mac mini for library reads, uploads, artwork, audio, lyrics,
and likes.

## Data Flow

- Library load: app calls `/api/home`; Worker proxies to the Mac mini; Mac mini
  returns the scanned songs and liked ids.
- Audio streaming: song `audioUrl` values point at `/api/files/local/*`; Worker
  proxies range requests to the Mac mini so seeking works.
- Artwork: local sidecar/embedded art is served first; missing art can be cached
  from online artwork lookup by the Mac mini server.
- Manual upload: browser posts to `/api/songs`; Worker requires auth, forwards
  the upload to the Mac mini, and the Mac mini saves it into `/Users/hermes/Music`.
- Spotify import: Worker resolves metadata/provider stream URLs, then sends the
  final remote audio URL to the Mac mini; the Mac mini downloads and stores the
  audio, cover, lyrics, and sidecar metadata.

## Important Runtime Notes

- Keep the Mac mini music server launchd service running:
  - `com.fightingentropy.spotify-app`
- `m4mini.local` only works on the LAN. Cloudflare reaches the Mac mini through
  the `spotify-mini` Cloudflare Tunnel and the public HTTPS origin hostname.
- Keep the Mac mini tunnel launchd service running:
  - `com.fightingentropy.spotify-tunnel`
- `MAC_MINI_PROXY_TOKEN` is a Worker secret. Do not commit the real value.
- `SPOTIFY_PROXY_TOKEN` on the Mac mini must match the Worker secret.
- The Settings page intentionally only shows user-facing playback/download
  settings now. Source status, edit-mode toggles, and Spotify cookie UI were
  removed from normal app chrome.
- The client caches API responses in memory for a short window and dedupes
  in-flight fetches, so navigating between Home/Search/etc does not reload the
  full song list every render. Uploads, imports, likes, sign-in, and sign-out
  invalidate the cache.

## Repository Structure

- `src/client/` - React app shell, routes, auth provider, shared API cache.
- `src/components/` - reusable UI, player bar, song list/grid, upload controls.
- `src/store/` - Zustand stores for player state, likes, and older browser-local
  library helpers.
- `src/worker/index.ts` - Cloudflare Worker API, auth, D1/R2 fallback paths,
  Spotify import helpers, and Mac mini proxy mode.
- `src/server/local-music-server.ts` - Bun server deployed to the Mac mini. It
  scans the music folder, serves media with range support, accepts uploads, and
  writes `.spotify.json` sidecars.
- `scripts/deploy-mini.sh` - builds/syncs the app and local server to Mac mini.
- `scripts/install-mini-server.sh` - installs/restarts the Mac mini launchd app
  service.
- `scripts/sync-mini-music.sh` - syncs audio/artwork/lyrics/sidecars to
  `/Users/hermes/Music`.
- `scripts/check-mini.sh` - health check for Mac mini server, launchd, library
  scan count, and LAN reachability.
- `wrangler.jsonc` - Cloudflare Worker bindings and `MAC_MINI_ORIGIN`.

## Local Development

```bash
bun install
bun run dev
```

Wrangler simulates the Worker bindings during local development. For the local
Mac mini-style server on this machine:

```bash
bun run build
SPOTIFY_MUSIC_DIR="$HOME/Music" bun run local:music
```

## Mac mini Operations

Deploy app/server updates to the Mac mini:

```bash
bun run mini:deploy
```

Reuse the current local `dist/` build:

```bash
bash scripts/deploy-mini.sh --skip-build
```

Check the Mac mini server:

```bash
bun run mini:check
```

Sync music to the Mac mini:

```bash
bun run mini:sync-music
```

Sync music from a specific local folder:

```bash
bash scripts/sync-mini-music.sh --source /Users/erlinhoxha/Movies
```

The sync copies audio, cover, lyrics, and `.spotify.json` sidecar files. It does
not delete remote files.

## Cloudflare Deployment

Deploy the public app:

```bash
bun run deploy
```

The active `wrangler.jsonc` contains:

```json
"MAC_MINI_ORIGIN": "https://spotify-origin.fightingentropy.org"
```

Set or rotate the Worker secret:

```bash
wrangler secret put MAC_MINI_PROXY_TOKEN
```

Mac mini server env lives at `/Users/hermes/.config/spotify/env` and should
include:

```bash
HOST=0.0.0.0
PORT=5174
SPOTIFY_MUSIC_DIR=/Users/hermes/Music
SPOTIFY_DIST_DIR=/Users/hermes/Developer/spotify/dist/client
SPOTIFY_CACHE_DIR=/Users/hermes/Developer/spotify/cache
SPOTIFY_ARTWORK_LOOKUP=1
SPOTIFY_ARTWORK_COUNTRY=GB
SPOTIFY_PROXY_TOKEN=...
SPOTIFY_PROXY_HOSTNAMES=spotify-origin.fightingentropy.org
```

## Verification

Useful checks after deploy:

```bash
bun --bun tsc --noEmit
bun run lint
bun run build
bun run mini:check
curl -I https://spotify.fightingentropy.org
curl -sS -o /dev/null -w "%{http_code}\n" https://spotify-origin.fightingentropy.org/api/music/source
```

Expected behavior:

- Cloudflare app returns `200`.
- Worker `/api/home` returns the Mac mini song library.
- Audio range requests through the Worker return `206`.
- Direct origin without the proxy token returns `401`.
- Mac mini LAN health check returns `200`.

## API Surface

- `GET /api/home`
- `GET /api/library`
- `GET /api/liked`
- `GET /api/playlist/:id`
- `POST /api/playlist/:id/reorder`
- `GET /api/songs`
- `POST /api/songs`
- `GET /api/songs/:id`
- `PATCH /api/songs/:id`
- `POST /api/songs/:id/assets`
- `POST /api/songs/spotify`
- `POST /api/songs/spotify/file`
- `POST /api/songs/spotify/batch`
- `GET /api/songs/spotify/cover`
- `GET /api/files/*`
- `GET /api/artwork/*`
- `GET/POST/DELETE /api/likes`
- `POST /api/register`
- `GET /api/auth/session`
- `POST /api/auth/signin`
- `POST /api/auth/signout`

## Scripts

- `bun run dev` - local Vite/Worker dev server.
- `bun run build` - production build for Worker and client assets.
- `bun run deploy` - build and deploy to Cloudflare.
- `bun run upload` - build and dry-run deploy.
- `bun run lint` - ESLint.
- `bun run local:music` - run the Bun local music server.
- `bun run mini:deploy` - deploy build/server to Mac mini.
- `bun run mini:install-server` - install Mac mini launchd app service.
- `bun run mini:sync-music` - sync music files to Mac mini.
- `bun run mini:check` - verify Mac mini health.
- `bun run cf-typegen` - regenerate Cloudflare binding types.
