# Current Music App Features

This repository contains a private, self-hosted music library with browser and
Expo clients, plus a Rust desktop client. It is an independent project and is not affiliated with Spotify
AB. Import or download media only when you have permission to access and copy
it.

## Shared browser and mobile features

- Authenticated home, search, library, liked-song, playlist, radio, podcast,
  event, upload/import, settings, profile, and listening-statistics screens.
- Queue, shuffle, repeat, previous/next, seeking, crossfade, media controls, and
  resume position. Web and Expo share pure helpers in `packages/shared`
  (account scope, like-cache patches, playback rate, sleep timer, song kind,
  cursors).
- Local media streaming with validated HTTP byte ranges, artwork, sidecars,
  lyrics, and bounded metadata indexing.
- `GET /api/songs` and library playlist detail still return a full array by
  default. Pass `limit` and/or `cursor` for `{ songs, nextCursor }` pages.
  Search-index accepts `q` and the same paging params. Without `limit`/`cursor`
  it still returns a full `{ songs }` projection (Worker capped at 5,000) for
  catalog matching.
- Manual upload and account-authorized provider import with streamed size
  limits and upload magic-byte validation.
- Playlist creation, editing, reordering, artwork, and folder conversion.
- Weekly playback history with top tracks, artists, and listening time.
- Discovery saves try SpotiFLAC first, then download YouTube audio with yt-dlp.
  A valid Premium session selects Premium Opus or AAC when available, preserving
  the original codec. See [library saves](docs/library-saves.md).

The route-level parity contract and intentional platform differences are in
[`docs/client-parity.md`](docs/client-parity.md).

## Browser performance

- All browser routes share page spacing, headings, neutral controls, and focus
  states through `PageLayout` and the shared component styles.
- Home sections load independently, with compact listening cards and responsive
  artwork. Local artwork uses cached WebP thumbnails; source files stay intact.
- API reads use a bounded cache with request deduplication and account isolation.
  Like changes update cached data immediately without stale reads undoing them.
- Routes preload on navigation intent. Large libraries use virtualized rows,
  cached search fields, and deferred filtering.
- Discover cards return cached metadata or fallback cards immediately while
  provider metadata refreshes in the background.
- Playback warms upcoming media only while playing and stops on pause or queue
  changes.
- The Now Playing sidebar previews live lyrics. The player microphone opens a
  shared, full-height lyrics view on desktop and mobile web, with timed line
  highlighting, click-to-seek, and explicit resume after scrolling. Plain-text
  lyrics remain readable without simulated timing.

## Mobile-only features

- User-pinned offline downloads and locally resolved playback.
- Durable background download/import queues and offline mutation replay.
- Device storage, cache, reachability, and background-download controls.
- Device-local custom podcast subscriptions.

Background URLSession downloads (iOS) and WorkManager downloads (Android).
Dual-deck native crossfade is iOS-only. Android plays through Track Player.

The browser's former service-worker/PWA download surface was deliberately
removed; native offline functionality is not represented as web parity.

## Native desktop

- The Rust/egui client uses the same authenticated music API for its library,
  catalog, playback, likes, and playlists; its macOS menu-bar player can keep the
  app running without a Dock icon.
- Radio and Podcasts use the website's shared catalogue, with native live/HLS
  playback and locally remembered episode positions per account.
- Home leads with playable playlist covers, including global/UK Top 50 charts,
  YouTube Music Discover Mix, personal listening-history collections, and your
  saved playlists. Chart and mix cards come from the shared music API.
- Downloads resolves Spotify links or music searches into selectable tracks,
  then saves to the Mac, the shared library, or both. Local exports offer format,
  tagging, artwork/lyrics, ReplayGain, and file-organization controls.
- Download settings include individual metadata tags, custom Tidal/Qobuz
  instances, resolver choice, provider order, ISRC duplicate matching, Atmos,
  portable settings backups, and SpotiFLAC settings imports. Local audio tools
  provide batch conversion/resampling, tag/lyrics editing, catalog enrichment,
  ReplayGain, filename templates, and spectrum/BPM/key estimates.
- Account-scoped queue/history provides real transfer stages, cancellation,
  interrupted-job retry, and measured local-file quality. Clearing completed
  history preserves files. See [desktop setup and Downloads](desktop/README.md).

## Private-host boundary

- The Worker owns accounts, sessions, D1 state, import orchestration, and
  optional R2 media.
- The Bun service owns private filesystem indexing, media/range serving,
  uploads, and sidecars.
- Worker-to-private-host calls use short-lived HMAC envelopes bound to method,
  full path and query, expiry, nonce, and forwarded user identity.
- The private service rejects expired, tampered, and replayed envelopes. A
  bounded nonce cache prevents one captured request being reused.
- Direct media URLs use a separate user/scoped media-signing key and one-hour
  expiry; the request-signing secret is never sent as a bearer token.
- Public media routing strips caller-supplied proxy and identity headers before
  forwarding signed media URLs.
- Canonical and real paths keep media access inside configured roots and reject
  symlink escapes.

Request signing and media URL signing use separate secrets. See the deployment
and rotation sequence in the README. Keep hostnames, account IDs, machine paths,
SSH aliases, service labels, and network topology in a private runbook.

## Verification

The web/Worker gate is:

```bash
bun run check
```

The independent native gate is:

```bash
cd mobile
npm ci
npm run typecheck
npm run lint
npm test
```

Neither local gate proves a production migration, private-host rollout, hosted
CI run, signed native install, or physical-device playback test occurred.
