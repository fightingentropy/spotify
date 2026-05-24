# Spotify

Spotify is a local-first music player built as a Vite React SPA served by a single Cloudflare Worker. The Worker owns auth, D1 library data, R2 media storage, Spotify import helpers, and range-capable media streaming.

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

## Current App Features

- Home, Search, Library, Liked Songs, and Playlist routes
- Grid/List library views with persisted sort/view preferences
- Manual file upload and Spotify-link import
- Spotify import fetches audio, cover art, and lyrics automatically
- Qobuz/Tidal provider resolution with quality profile settings
- Duplicate song detection with replace confirmation
- R2 media streaming with range request support
- Worker-native credentials auth with opaque `wf_session` cookie sessions
- Likes with optimistic updates
- Per-song edit mode for metadata, cover art, and lyrics
- Browser-local folder mode for on-device music
- PWA install support, mobile nav, player bar, now-playing sidebar, and mobile sheet

## Settings

- Local Folder
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
