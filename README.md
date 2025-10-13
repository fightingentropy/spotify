# Waveform

A minimal music player built with Next.js 15, PostgreSQL, MinIO, and NextAuth.

## Quick Start

```bash
bun install
cp .env.example .env
bun run docker:up              # Start Postgres + MinIO
psql "$DATABASE_URL" -f db/schema.sql
bun run scripts/seed.ts        # Optional: seed demo data
bun run dev
```

**Demo login:** `demo@example.com` / `password` at `/signin`

## Architecture

### Core Stack
- **Next.js 15** - App Router, React 19, Server Components
- **PostgreSQL** - Relational data via Bun's native SQL API
- **MinIO** - S3-compatible local object storage for audio/artwork
- **NextAuth** - Email/password auth with custom Bun SQL adapter
- **Zustand** - Client state management (player, likes)
- **Tailwind** - Styling

### Database (`db/`)
- `schema.sql` - Tables for users, songs, playlists, likes

### API Routes (`src/app/api/`)
- `auth/[...nextauth]` - NextAuth handlers
- `songs` - List songs + multipart upload
- `files/[...key]` - Proxy MinIO objects with cache headers
- `artwork/[...file]` - Serve artwork files
- `likes` - Toggle song likes
- `register` - User registration
- `admin/batch-upload` - Bulk upload endpoint

### Pages (`src/app/`)
- `/` - Home feed with song grid
- `/upload` - Upload new songs with metadata
- `/liked` - User's liked songs
- `/playlist/[id]` - Playlist view
- `/signin`, `/register` - Auth pages
- `/settings` - User settings

### Components (`src/components/`)
- `PlayerBar` - Global audio player with crossfade, keyboard shortcuts, persistence
- `SongCard` - Individual song tile with play/like actions
- `SongGrid` - Grid layout for song collections
- `LibrarySidebar` - Navigation sidebar
- `AuthButtons` - User menu dropdown
- `CrossfadeSettings` - Crossfade duration control

### State Management (`src/store/`)
- `player.ts` - Queue, playback state, volume, crossfade settings
- `likes.ts` - Optimistic like/unlike state

### Lib (`src/lib/`)
- `db.ts` - Postgres client with connection pooling
- `auth-adapter.ts` - NextAuth adapter for Bun SQL
- `storage.ts` - MinIO client wrapper
- `song-utils.ts` - Song metadata helpers
- `db-types.ts` - Database type definitions

### Scripts (`scripts/`)
- `seed.ts` - Seed demo data
- `docker.ts` - Docker compose management
- `upload-billboard.ts` - Batch upload Billboard songs

## Features

- Email/password authentication
- Upload songs with cover art and metadata
- Play queue with crossfade transitions
- Like/unlike songs (optimistic updates)
- Playlist management
- Keyboard shortcuts (space, arrow keys)
- Volume + seek controls
- LocalStorage persistence for player state

## Infrastructure

- **Postgres**: `localhost:5432` (user/pass/db: `waveform`)
- **MinIO Console**: `http://localhost:9001` (user: `waveform`, pass: `waveformsecret`)
- Files stored in `uploads` bucket with immutable cache headers
