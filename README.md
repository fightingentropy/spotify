Waveform — a minimal music player built with Next.js 15 (App Router), Tailwind, Prisma (Postgres), NextAuth, and MinIO for local object storage.

### Quick start
- Install dependencies: `npm install`
- Copy env: `cp .env.example .env` and adjust if needed
- Start infrastructure (Postgres + MinIO via Docker/OrbStack): `docker compose up -d`
- Generate client and migrate: `npx prisma generate && npx prisma migrate dev --name init`
- Seed demo data: `node prisma/seed.js` (optional)
- Start dev server: `npm run dev`

### Demo sign-in
- **Email**: `demo@example.com`
- **Password**: `password`
- **Sign-in page**: `/signin`

### Features
- Email/password auth (NextAuth Credentials + Prisma adapter)
- Upload songs (cover + audio) to `public/uploads` with metadata in SQLite
- Home feed listing songs; click a card to play
- Global player bar with play/pause, seek, volume

### Key files
- `prisma/schema.prisma`: DB schema
- `src/auth.ts`: NextAuth config and handlers
- `src/app/api/auth/[...nextauth]/route.ts`: Auth route handlers
- `src/app/api/songs/route.ts`: Songs list + upload endpoint (multipart)
- `src/app/upload/page.tsx`: Upload UI
- `src/components/PlayerBar.tsx`: Audio player
- `src/store/player.ts`: Player state

### Notes
- Uploaded files are stored in MinIO (`uploads` bucket). You can browse UI at `http://localhost:9001` (user: `waveform`, pass: `waveformsecret`).
- Postgres runs at `localhost:5432` (user/pass/db: `waveform`).
- To reset DB: drop the `waveform` database or run `prisma migrate reset`.
