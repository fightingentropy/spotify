# Waveform

Waveform is a local-first music player built with Next.js, SQLite, and filesystem media storage.  
It supports manual uploads and Spotify-link ingestion with automatic provider/quality selection (Tidal/Qobuz/Amazon via backend resolver).

## Tech Stack

- Next.js 16 (App Router)
- React 19
- SQLite (`better-sqlite3`)
- NextAuth (credentials)
- Zustand (player + likes state)
- Local filesystem object storage for audio, cover art, and lyrics

## Quick Start

```bash
bun install
cp .env.example .env
bun run dev
```

SQLite schema is auto-applied from `db/schema.sql` at startup.

## Current App Features

- Library views:
  - Home, Liked Songs, and Playlist pages
  - Grid/List modes with persisted preference
  - Upload-date sorting (newest/oldest)
  - Virtualized list rendering for large libraries
  - Duplicate rows deduped in song collections/search
- Upload flow:
  - Spotify link mode (default)
  - Manual file upload mode
  - Spotify fetch card actions: preview, download lyrics, download cover, check availability
  - Spotify downloads use the same provider flow for library imports and browser-folder saves: Qobuz, Amazon Music, then Tidal by default
  - Missing cover/lyrics prompts during import with ignore/upload choices
  - Duplicate song detection with replace confirmation
  - Automatic folder organization under:
    - `music/<artist>/<title>/audio`
    - `music/<artist>/<title>/cover`
    - `music/<artist>/<title>/lyrics`
- Playback:
  - Global player bar (seek, volume, shuffle, repeat, crossfade)
  - Right now-playing sidebar + mobile sheet
  - Lyrics hidden by default and toggleable
- Library management:
  - Likes with optimistic updates
  - Per-song edit mode (title/artist/cover/lyrics) from Settings
  - Song quality metadata support (`bit-depth` / `sample-rate`)
- Navigation:
  - Command+K / Ctrl+K search palette on home

## Settings (Current UI)

- Crossfade toggle + duration
- Edit mode toggle (enables per-song edit controls)
- Download provider (`Auto`, `Qobuz`, `Amazon Music`, `Tidal`)
- Download quality profile (`Max`, `24-bit/48kHz`, `16-bit/44.1kHz`)

## Environment Variables

Required:

- `SQLITE_DB_PATH`
- `NEXTAUTH_SECRET`
- `ADMIN_SECRET`

Storage and import defaults:

- `LOCAL_MEDIA_ROOT`
- `LOCAL_MUSIC_SOURCE_DIR`
- `LOCAL_IMPORT_USE_COVER_FILES`
- `LOCAL_IMPORT_USE_LYRICS_FILES`

Upload and rate limits:

- `UPLOAD_MAX_IMAGE_BYTES`
- `UPLOAD_MAX_AUDIO_BYTES`
- `RATE_LIMIT_AUTH_MAX`
- `RATE_LIMIT_AUTH_WINDOW_MS`
- `RATE_LIMIT_REGISTER_MAX`
- `RATE_LIMIT_REGISTER_WINDOW_MS`
- `RATE_LIMIT_ADMIN_MAX`
- `RATE_LIMIT_ADMIN_WINDOW_MS`

## API Endpoints

Core:

- `GET /api/songs` list songs
- `POST /api/songs` create song (manual upload or Spotify/link mode)
- `PATCH /api/songs/:id` update song metadata (title/artist)
- `POST /api/songs/:id/assets` update song cover and/or lyrics
- `GET /api/files/[...key]` stream local files (supports range requests)
- `GET/POST/DELETE /api/likes` liked songs management

Spotify helpers:

- `POST /api/songs/spotify` actions: `fetch`, `availability`, `lyrics`
- `POST /api/songs/spotify/file` download a Spotify track audio file
- `GET /api/songs/spotify/cover` cover proxy/download

Auth:

- `POST /api/register`
- `GET/POST /api/auth/[...nextauth]`

Import/admin utilities (API-only):

- `GET/POST /api/library/import` local library import defaults + authenticated import
- `POST /api/admin/batch-upload` admin-secret protected batch import

Misc:

- `GET /api/artwork/[...file]`

## Scripts

- `bun run dev`
- `bun run build`
- `bun run start`
- `bun run lint`

## Notes

- `ffmpeg` is required in `PATH` for local-library conversion/import paths.
- Media files are stored under `LOCAL_MEDIA_ROOT` and gitignored.
- Runtime SQLite DB files are gitignored.
