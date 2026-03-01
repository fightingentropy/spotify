# Waveform

Local-first music player built with Next.js, SQLite, filesystem media storage, and NextAuth.

## Stack

- Next.js `16.1.6` (App Router)
- React `19.2.4`
- SQLite (`better-sqlite3`) for app data
- Filesystem storage for audio, covers, and lyrics
- NextAuth credentials auth
- Zustand for player and likes state

## Quick Start

```bash
bun install
cp .env.example .env
bun run dev
```

The SQLite schema is auto-applied from `db/schema.sql` on startup.

## Local Music Import

Import from your local music folder:

```bash
bun run import:music --source /Users/erlinhoxha/Music
```

What import does:

- Scans source folder recursively for supported audio files
- Converts non-FLAC sources to FLAC via `ffmpeg`
- Imports artwork from sidecar cover files and embedded metadata
- Imports lyrics from:
  - sidecar files near audio (`song.lrc`, `song.txt`, `lyrics.lrc`, `lyrics.txt`)
  - dedicated lyrics folders (e.g. `lyrics/` or `Lyrics/`) by filename matching
  - embedded lyrics metadata when available

## Environment

Required:

- `SQLITE_DB_PATH` - path to SQLite database file
- `NEXTAUTH_SECRET` - NextAuth session secret
- `ADMIN_SECRET` - secret for `/api/admin/batch-upload`

Local media:

- `LOCAL_MEDIA_ROOT` - local storage root for imported/uploaded media
- `LOCAL_MUSIC_SOURCE_DIR` - default import source directory
- `LOCAL_IMPORT_USE_COVER_FILES` - enable sidecar cover file usage
- `LOCAL_IMPORT_USE_LYRICS_FILES` - enable sidecar lyrics file usage

Optional limits/rate control:

- `UPLOAD_MAX_IMAGE_BYTES`
- `UPLOAD_MAX_AUDIO_BYTES`
- `RATE_LIMIT_AUTH_MAX`
- `RATE_LIMIT_AUTH_WINDOW_MS`
- `RATE_LIMIT_REGISTER_MAX`
- `RATE_LIMIT_REGISTER_WINDOW_MS`
- `RATE_LIMIT_ADMIN_MAX`
- `RATE_LIMIT_ADMIN_WINDOW_MS`

## Main Features

- Upload songs with cover + audio
- Local library import from filesystem
- FLAC conversion pipeline for non-FLAC files
- Lyrics support from sidecar/embedded metadata
- Per-song cover/lyrics updates from Settings
- Global player with queue, seek, volume, shuffle/repeat, and crossfade
- Home/Liked/Playlist song collections with Grid/List view toggle
- Left library sidebar (collapsible)
- Right now playing sidebar (collapsible)
- Expanded now-playing sheet from player bar
- Likes with optimistic updates

## UI Notes

- Song collection view mode (`Grid` / `List`) is persisted in localStorage (`wf_song_view_mode`).
- Left sidebar collapsed state is persisted in localStorage (`wf_left_sidebar_collapsed`).
- Player state and crossfade settings persist client-side.

## API Endpoints

- `GET/POST /api/songs` - list songs and upload songs
- `POST /api/songs/:id/assets` - update song cover and/or lyrics
- `GET/POST /api/library/import` - import defaults + authenticated import trigger
- `POST /api/admin/batch-upload` - admin-secret import trigger
- `GET /api/files/[...key]` - streams local audio/images/lyrics (range support)
- `GET /api/likes`, `POST /api/likes`, `DELETE /api/likes` - like management

## Scripts

- `bun run dev`
- `bun run build`
- `bun run start`
- `bun run lint`
- `bun run import:music`

## Notes

- `ffmpeg` must be installed and available in `PATH` for non-FLAC conversion.
- Media files are stored under `LOCAL_MEDIA_ROOT` and ignored by git.
- Runtime SQLite DB files are ignored by git.
