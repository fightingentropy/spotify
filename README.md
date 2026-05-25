# Spotify

Spotify is a local-first music player built as a Vite React SPA served by a single Cloudflare Worker. By default the Worker owns auth, D1 library data, R2 media storage, Spotify import helpers, and range-capable media streaming.

The Mac mini setup can also run the app as a fixed local music server. In that mode
the mobile app reads `/api/home` from the Mac mini and streams songs directly from
`SPOTIFY_MUSIC_DIR`, so the phone never needs to pick a folder. Album artwork is
served from sidecar/embedded covers when available, then cached from an online
music artwork lookup when local files do not contain cover art.

## Tech Stack

- Vite + React 19
- Cloudflare Workers static assets + Hono API
- Cloudflare D1 for users, sessions, songs, likes, and playlists
- Cloudflare R2 for audio, cover art, and lyrics
- Zustand for player, likes, and browser-local library state

## Quick Start

```bash
bun install
bun run dev
```

The Worker applies the D1 schema at runtime. Local development uses Wrangler's local D1/R2 simulation unless configured otherwise.

## Mac mini Music Server

```bash
bun run mini:sync-music
bun run mini:deploy
```

Defaults mirror the Netflix mini setup:

- Remote host: `hermes@m4mini.local`
- Remote app: `/Users/hermes/Developer/spotify`
- Remote music source: `/Users/hermes/Music`
- App URL on the LAN: `http://m4mini.local:5174`

`mini:sync-music` copies audio, cover, lyrics, and `.spotify.json` sidecar files only.
It does not delete local files. To include audio clips from another folder:

```bash
bash scripts/sync-mini-music.sh --source /Users/erlinhoxha/Movies
```

The local server caches missing album art automatically. Set `SPOTIFY_ARTWORK_LOOKUP=0`
to disable online artwork lookup.

## Cloudflare App With Mac mini Storage

The Cloudflare deployment can use the Mac mini as the music source and upload
target. In that setup the Worker still serves the public app and keeps the
Spotify lookup/import helpers, but `/api/home`, `/api/songs`, `/api/files/local/*`,
`/api/artwork/local/*`, and likes proxy to the Mac mini.

Cloudflare cannot reach `m4mini.local` because that hostname only exists on the
local network. Expose the Mac mini server through a public HTTPS origin first,
preferably a Cloudflare Tunnel, then set:

```bash
MAC_MINI_ORIGIN=https://music.example.com
MAC_MINI_PROXY_TOKEN=use-a-long-random-shared-token
```

`MAC_MINI_ORIGIN` can live in `wrangler.jsonc`; put `MAC_MINI_PROXY_TOKEN` in a
Worker secret rather than committing it to the config.

```bash
wrangler secret put MAC_MINI_PROXY_TOKEN
```

On the Mac mini, set the matching server token before starting the launchd service:

```bash
SPOTIFY_PROXY_TOKEN=use-a-long-random-shared-token
SPOTIFY_PROXY_HOSTNAMES=spotify-mini.fightingentropy.org
```

With `MAC_MINI_ORIGIN` configured, manual uploads are saved into
`SPOTIFY_MUSIC_DIR` on the Mac mini. Spotify imports are resolved by the Worker,
then the Mac mini downloads and stores the final audio, cover, and lyrics files.

## Current App Features

- Home, Search, Library, Liked Songs, and Playlist routes
- Grid/List library views with persisted sort/view preferences
- Manual file upload and Spotify-link import
- Spotify import fetches audio, cover art, and lyrics automatically
- Qobuz/Tidal provider resolution with quality profile settings
- Duplicate song detection with replace confirmation
- R2 media streaming with range request support
- Mac mini local music streaming with range request support and cached album art
- Cloudflare Worker proxy mode for Mac mini music storage via a public HTTPS origin
- Worker-native credentials auth with opaque `spotify_session` cookie sessions
- Likes with optimistic updates
- Per-song edit mode for metadata, cover art, and lyrics
- PWA install support, mobile nav, player bar, now-playing sidebar, and mobile sheet

## Settings

- Mac mini music source
- Crossfade
- Edit mode
- Download provider (`Auto`, `Qobuz`, `Tidal`)
- Download quality profile (`Max`, `24-bit/48kHz`, `16-bit/44.1kHz`)

## API Endpoints

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
- `GET /api/songs/spotify/cover`
- `GET /api/files/*`
- `GET/POST/DELETE /api/likes`
- `POST /api/register`
- `GET /api/auth/session`
- `POST /api/auth/signin`
- `POST /api/auth/signout`
- `GET /api/artwork/*`

## Scripts

- `bun run dev`
- `bun run build`
- `bun run preview`
- `bun run deploy`
- `bun run lint`
- `bun run cf-typegen`
