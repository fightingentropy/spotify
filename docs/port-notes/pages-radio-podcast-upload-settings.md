# Port Notes — Radio, Podcasts, Upload, Settings, Profile, Auth pages

Reconstruction-grade map of the secondary pages for the Expo / React Native port.
Source stack: Vite + React 19 + Tailwind v4 + Zustand + react-router-dom, wrapped in Capacitor.
All Tailwind classNames are quoted verbatim so they can be reproduced in NativeWind.

Files covered (11 primary + supporting):
- `src/client/pages/RadioPage.tsx`
- `src/client/pages/PodcastsPage.tsx`
- `src/client/pages/UploadPage.tsx`
- `src/client/pages/SettingsPage.tsx`
- `src/client/pages/ProfilePage.tsx`
- `src/client/pages/SignInPage.tsx`
- `src/client/pages/RegisterPage.tsx`
- `src/lib/radio-stations.ts`
- `src/lib/podcasts.ts`
- `src/components/CrossfadeSettings.tsx`
- `src/components/OfflineSettings.tsx`
- Supporting: `src/lib/playback-gesture.ts`, `src/lib/spotify-cookie.ts`, `src/client/podcast-progress.ts`, `src/types/player.ts`, `src/lib/spotify-batch-client.ts`, `src/client/auth.tsx` (relevant slices)

---

## Shared types & helpers used across these pages

### `PlayerSong` (`src/types/player.ts`)
Every radio station and podcast episode IS a `PlayerSong`, so the player store treats them uniformly.
```ts
type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
  networkImageUrl?: string;   // remote cover fallback when imageUrl is swapped for a local file
  audioUrl: string;
  lyricsUrl?: string;
  description?: string;
  link?: string;
  createdAt?: string;
  duration?: number;          // seconds
  audioBitDepth?: number;
  audioSampleRate?: number;
  source?: "server" | "browser-local" | "picked-file" | "radio" | "podcast" | "offline";
  localPath?: string;
  writable?: boolean;
  staged?: boolean;           // Discover Top-50 track not yet in library
  discoverTrackId?: string;
};
```

### Player store actions consumed here (`src/store/player.ts`)
- `setQueue: (songs: PlayerSong[], startIndex: number, options?: SetQueueOptions) => PlayerSong | null`
- `toggle: () => void`  → `set((s) => ({ isPlaying: !s.isPlaying }))`
- `currentSong: PlayerSong | null`
- `isPlaying: boolean`
- `crossfadeEnabled: boolean`
- `crossfadeSeconds: number` (range 0..12)
- `setCrossfadeEnabled: (enabled: boolean) => void`
- `setCrossfadeSeconds: (seconds: number) => void`
- Crossfade state is hydrated **once** by the store's lazy initializer (`readStoredCrossfadeEnabled()` / `readStoredCrossfadeSeconds()`), which read localStorage. `CrossfadeSettings.tsx` only reads/writes the store.

### `requestImmediatePlayback(song)` (`src/lib/playback-gesture.ts`) — **PORTING HAZARD**
```ts
export const PLAYBACK_GESTURE_EVENT = "spotify:playback-gesture";
requestImmediatePlayback(song): void
```
- Resolves the offline copy via `resolveOfflinePlaybackSong(song)`, then dispatches a `window.dispatchEvent(new CustomEvent("spotify:playback-gesture", { detail: { audioUrl } }))`.
- Purpose: lets the audio element start inside the user-gesture tick (browser autoplay policy) before the store async-updates. **RN has no `window`/`CustomEvent`/DOM events and no autoplay gate** — replace with a direct imperative call to the native player (e.g. `TrackPlayer.play()` / store action). Both RadioPage and PodcastsPage call this on every tap before `setQueue`.

---

## RadioPage (`src/client/pages/RadioPage.tsx`)

### Data source
- Static array `RADIO_STATIONS` from `src/lib/radio-stations.ts` (no fetch). Player store for play state.

### `RADIO_STATIONS` shape (`src/lib/radio-stations.ts`)
```ts
type RadioStation = PlayerSong & {
  location: string;
  streamLabel: string;       // e.g. "AAC+ 160 kbps", "HLS 96 kbps"
  accentClassName: string;   // Tailwind gradient stops for the top accent bar
};
```
Two stations defined:
1. **Dromos 89.8** — `id: "radio:dromos-89-8"`, `source: "radio"`, `album: "Radio Stations"`, `artist`/`location: "Athens, Greece"`, `streamLabel: "AAC+ 160 kbps"`, `audioUrl: "https://netradio.live24.gr/dromos2"` (plain stream), `accentClassName: "from-[#ff3f55] via-[#f59e0b] to-[#1ed760]"`.
2. **BBC Radio 1** — `id: "radio:bbc-radio-1"`, `source: "radio"`, `album: "Radio Stations"`, `artist`/`location: "London, United Kingdom"`, `streamLabel: "HLS 96 kbps"`, `audioUrl` is an **HLS `.m3u8`** (`https://a.files.bbci.co.uk/.../bbc_radio_one.m3u8`), `accentClassName: "from-[#ff4f8b] via-[#7c3aed] to-[#06b6d4]"`.

**PORTING HAZARD — HLS:** BBC stream is HLS. Browser `<audio>` + the app's native AVPlayer engine handle `.m3u8`; in RN you need an HLS-capable player (`react-native-track-player` / `expo-av` handle HLS on iOS natively; Android via ExoPlayer). Verify `.m3u8` playback explicitly.

### Layout & verbatim classNames
- Root: `<div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">`
  - Inner: `<div className="mx-auto max-w-7xl">`
- Header row: `<div className="mb-6 flex items-center gap-3">` → `<div className="flex min-w-0 items-center gap-3">`
  - Icon tile: `<div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-cyan-500/15 text-cyan-200">` containing `<RadioTower size={23} />` (lucide-react).
  - Title: `<h1 className="text-2xl font-semibold">Radio Stations</h1>`
  - Subtitle: `<div className="mt-1 text-sm text-white/[0.62]">{RADIO_STATIONS.length} live stations</div>`
- Grid: `<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">`
- Each station tile is a `<button>`:
  - `className={cn("group relative aspect-square overflow-hidden rounded-lg bg-white/[0.05] text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500", active && "ring-2 ring-emerald-500")}`
  - `aria-label={`${playing ? "Pause" : "Play"} ${station.title}`}`, `aria-pressed={playing}`
  - `<CoverImage src={station.imageUrl} alt fill className="object-cover" loading={index===0?"eager":"lazy"} sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 200px" />`
  - Gradient overlay: `<div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/45 to-black/10" />`
  - Top accent bar: `<div className={cn("absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r", station.accentClassName)} />`
  - **Live badge** (top-left): `<div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/80 backdrop-blur">` + `<Radio size={11} />` + text `Live`. (`backdrop-blur` → **RN: no backdrop-blur; use a semi-opaque solid or `expo-blur` BlurView.**)
  - Bottom info block: `<div className="absolute inset-x-2 bottom-2">`
    - `<h2 className="truncate text-[15px] font-semibold leading-5 text-white drop-shadow sm:text-base">{station.title}</h2>`
    - `<div className="mt-0.5 truncate text-xs leading-4 text-white/80 drop-shadow">{station.location}</div>`
    - `<div className="mt-1 truncate text-[11px] leading-4 text-white/65 drop-shadow">{station.streamLabel}</div>`

### Interactions
- `currentStationId = currentSong?.source === "radio" ? currentSong.id : null`. `active = currentStationId === station.id`; `playing = active && isPlaying`.
- `playStation(index)`: if already the current station → `if (!isPlaying) requestImmediatePlayback(station); toggle();`. Otherwise → `requestImmediatePlayback(station); setQueue(RADIO_STATIONS, index)`.
- No loading/empty/error states (static data). No swipe/long-press.

---

## PodcastsPage (`src/client/pages/PodcastsPage.tsx`)

### Data sources
- Static `PODCAST_SHOWS` (`src/lib/podcasts.ts`) for the show grid.
- Per-show episode list: **fetch** RSS from `GET /api/podcast-feeds/:id` (returns raw XML text), parsed client-side by `parsePodcastFeed(xml, show)`.
- Player store for play state; `readAllEpisodeProgress()` (localStorage) for resume/finished badges.

### `PODCAST_SHOWS` shape (`src/lib/podcasts.ts`)
```ts
type PodcastShow = {
  id: string;            // e.g. "huberman-lab"
  title: string;
  author: string;
  subtitle: string;
  description: string;
  feedUrl: string;       // canonical RSS, used as base URL for relative resolution + media allowlist
  websiteUrl: string;
  imageUrl: string;
  accentClassName: string; // Tailwind gradient stops
};
```
Four shows: `huberman-lab` (Megaphone), `modern-wisdom` (Megaphone), `flagrant` (Megaphone), `all-in` (Libsyn). Each has a megaphone/libsyn `imageUrl` and an `accentClassName` gradient.

### `PodcastEpisode` shape (built by `parsePodcastFeed`)
```ts
type PodcastEpisode = PlayerSong & {
  source: "podcast";
  podcastId: string;
  podcastTitle: string;
  description: string;
  link?: string;
  publishedAt?: string;  // ISO
};
```
Built fields: `id` = `stableEpisodeId(showId, item, audioUrl, title)` → `podcast:<showId>:<slug-of-guid|audioUrl|title>` (slug lowercased, non-alnum→`-`, ≤96 chars). `artist` = channel title/author/show.title. `album: "Podcasts"`. `imageUrl` & `audioUrl` are **both wrapped** in `podcastMediaProxyUrl(...)`. `duration` parsed from `itunes:duration` (seconds or `H:MM:SS`/`MM:SS`). `createdAt`/`publishedAt` from `pubDate`.

### RSS parsing (`parsePodcastFeed`) — **PORTING HAZARD: uses DOMParser**
- `new DOMParser().parseFromString(xmlText, "application/xml")` — **not available in RN.** Replace with `react-native-xml2js` / `fast-xml-parser`.
- `stripHtml()` also uses `new DOMParser().parseFromString(..., "text/html")` with a regex fallback.
- Reads `channel`, `title`, `itunes:author`, `image>url`, `itunes:image[href]`, per-`item`: `enclosure[url]` (required — items without it are dropped), `title`, `description`/`content:encoded`, `itunes:duration`, `pubDate`, `itunes:image[href]`, `guid`, `link`. Capped at `limit = 50` episodes.
- `safePodcastUrl(value, baseUrl)`: only http/https, rejects creds, resolves relative against feed URL.

### Media proxy — `podcastMediaProxyUrl(showId, mediaUrl)`
```ts
`/api/podcast-media/${encodeURIComponent(showId)}?url=${encodeURIComponent(mediaUrl)}`
```
- **PORTING HAZARD — relative URL.** Both episode `audioUrl` and `imageUrl` are same-origin relative paths. In RN there is no origin; prefix with the API base host or the native player/Image won't resolve them.
- Server-side validation (in the Worker, not RN code, but informs the contract): the proxy re-fetches the show's feed and only relays URLs that appear in media-bearing tags (`enclosure`/`media:content`/`itunes:image` `url=`/`href=`, plus `<url>` elements). `extractPodcastFeedMediaUrls(xml, show)` + `podcastFeedAllowsMediaUrl(set, url)` (matches exact, falls back to origin+path to tolerate drifting tracking params). So you cannot fetch arbitrary URLs through it.

### API routes used
- `GET /api/podcast-feeds/:id` → **response: raw RSS XML (text/xml)**, status 200; non-200 throws `Podcast feed returned <status>`. No auth header in client (cookie session via fetch defaults). Fetched with `fetch(url, { signal })`.
- `GET /api/podcast-media/:id?url=<encoded>` → audio/image bytes (proxied). Used as the `src` for `<audio>`/`<CoverImage>` and the offline downloader.

### Episode progress (`src/client/podcast-progress.ts`) — **PORTING HAZARD: localStorage**
- localStorage key `"spotify_podcast_progress"`, map `id -> { time, duration, updatedAt }`, capped at 200 entries (evicts oldest by `updatedAt`).
- Exports: `readEpisodeProgress(id)`, `readAllEpisodeProgress()`, `writeEpisodeProgress(id, time, duration)`, `markEpisodeFinished(id)`, `clearEpisodeProgress(id)`, `isEpisodeFinished(progress)`.
- "Finished" logic: `duration <= 60s` → finished when `time >= duration*0.95`; else finished when `time > duration - 30`. Constants: `PODCAST_FINISHED_TAIL_SECONDS=30`, `PODCAST_SHORT_EPISODE_SECONDS=60`, `PODCAST_SHORT_EPISODE_FINISHED_RATIO=0.95`.
- **Replace localStorage with AsyncStorage/MMKV in RN.** The page re-reads `readAllEpisodeProgress()` via `useMemo` keyed on `[episodes, currentPodcastEpisodeId, isPlaying]` — a cheap re-read on play/pause/episode change (no live subscription to timeupdate).

### Component state & feed loading
- State: `selectedShowId` (string, "" = none), `episodes: PodcastEpisode[]`, `status: "idle"|"loading"|"ready"|"error"`, `error`, `loadedAt` (ISO), `loadRequestIdRef` (monotonic, to drop stale responses).
- `loadFeed(signal?)`: guards on `selectedShow`, bumps requestId, fetches `/api/podcast-feeds/:id`, parses, sets episodes/loadedAt/status. Drops result if aborted or stale requestId. AbortError swallowed.
- `useEffect` on `selectedShow`: clears state when none; otherwise resets episodes/loadedAt, creates `AbortController`, calls `loadFeed`, aborts on cleanup. **`AbortController` exists in RN (RN ≥0.60).**
- `loadedLabel`: localized `toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit"})`.

### Layout & verbatim classNames
- Root identical to Radio: `"min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6"` → `"mx-auto max-w-7xl"`.
- Header: same structure, icon tile `"grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-fuchsia-500/15 text-fuchsia-200"` with `<Podcast size={23} />`; `<h1 className="text-2xl font-semibold">Podcasts</h1>`; subtitle `"mt-1 text-sm text-white/[0.62]"` → `{PODCAST_SHOWS.length} shows`.
- Show grid: `"grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"`.
- Show tile `<button>`: `className={cn("group relative aspect-square overflow-hidden rounded-lg bg-white/[0.05] text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400", selected && "ring-2 ring-fuchsia-400")}`, `aria-expanded={selected}`, `aria-controls={selected?"podcast-episodes":undefined}`, `aria-label={`Show episodes for ${title}`}`.
  - CoverImage src = `podcastMediaProxyUrl(show.id, show.imageUrl)`, same overlay/accent/badge structure as Radio but badge label `Show` with `<Podcast size={11} />`.
  - Bottom block adds author (`"mt-0.5 truncate text-xs leading-4 text-white/80 drop-shadow"`) and a 2-line description (`"mt-1 line-clamp-2 text-[11px] leading-4 text-white/65 drop-shadow"`). (`line-clamp-2` → RN: `numberOfLines={2}`.)
- Episode section (rendered only when a show is selected): `<section id="podcast-episodes" className="mt-8">`.
  - Header row: `"mb-4 flex flex-wrap items-start justify-between gap-4"`; left = 72×72 CoverImage (`"h-[72px] w-[72px] shrink-0 rounded-md object-cover"`) + label `"text-sm font-medium text-fuchsia-200">Episodes`, `<h2 className="mt-0.5 text-2xl font-semibold leading-tight text-white">`, description `"mt-1 max-w-4xl text-[14px] leading-6 text-white/[0.66]"`, meta row `"mt-2 flex flex-wrap items-center gap-3 text-sm text-white/[0.62]"` containing episode count, `Updated {loadedLabel}`, and a **Website `<a target="_blank" rel="noopener noreferrer">`** (`"inline-flex items-center gap-1.5 text-white/[0.72] transition hover:text-white"` + `<ExternalLink size={14} />`). (RN: replace `<a>` with `Linking.openURL`.)
  - **Refresh button**: `<button onClick={() => void loadFeed()} disabled={status==="loading"}>` `className="wf-control-button grid h-10 w-10 place-items-center rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white disabled:cursor-wait disabled:opacity-60"`, icon `<RefreshCw size={18} className={cn(status==="loading" && "animate-spin")} />`.

### Episode rows — loading / error / list states
- **Loading** (status loading & no episodes): `<EpisodeSkeletonRows />` — 4 rows, each `"flex min-h-[88px] items-center gap-4 rounded-xl px-3 py-3"`, skeleton blocks use class `wf-skeleton` (shimmer; defined in global CSS — recreate as RN animated placeholder).
- **Error** (status error & no episodes): `<div className="rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-6 text-sm text-red-100">{error ?? "Could not load podcast feed."}</div>`.
- **List**: `<div className="space-y-2">` of `<article>` rows.
  - Row: `className={cn("wf-list-row flex min-h-[92px] items-center gap-3 rounded-lg px-3 py-3 transition hover:bg-white/[0.07] sm:gap-4", active && "bg-white/[0.08] ring-1 ring-emerald-500/40")}`.
  - **Play/pause button**: `className={cn("wf-control-button grid h-11 w-11 shrink-0 place-items-center rounded-full transition", playing ? "bg-emerald-500 text-black" : "bg-white text-black")}`, icon Pause/Play (Play has `className="translate-x-[1px]"`).
  - Cover thumb (hidden on mobile, `sm:block`): `"hidden h-16 w-16 shrink-0 rounded-md object-cover sm:block"`.
  - Text button (whole-text tappable, also calls `playEpisode`): title `"line-clamp-2 text-[15px] font-semibold leading-5 text-white"`, desc `"mt-1 line-clamp-2 text-[13px] leading-5 text-white/[0.62]"` (`episodeDescription` truncates to 260 chars).
  - Meta row `"mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-white/[0.55]"`: date (`<CalendarDays size={13}/>` + `formatEpisodeDate`), duration (`<Clock3 size={13}/>` + `formatTime`), and one of:
    - **finished**: `"inline-flex items-center gap-1 text-emerald-400"` + `<CheckCircle2 size={13}/>` + `Played`.
    - **in-progress**: a mini progress bar `"h-1 w-16 overflow-hidden rounded-full bg-white/[0.12]"` with inner `"block h-full rounded-full bg-emerald-500"` `style={{ width: `${clamp((time/duration)*100)}%` }}` + `remainingLabel` (`${ceil((duration-time)/60)}m left`).
  - **Per-episode download**: `<OfflineSongDownloadButton song={episode} className="h-10 w-10" />` (offline pipeline; see OfflineSettings hazards).

### Interactions
- `currentPodcastEpisodeId = currentSong?.source === "podcast" ? currentSong.id : null`.
- `playEpisode(index)`: same toggle-vs-setQueue pattern as Radio (uses `requestImmediatePlayback(episode)` first).
- **Speed control / playback speed:** NOT implemented on this page or in the episode row. (The prompt asked to confirm — there is no per-episode speed UI here; any speed control lives elsewhere in the player chrome, not in PodcastsPage.tsx. Treat "speed control" as out of scope for this page.)

---

## UploadPage (`src/client/pages/UploadPage.tsx`)

Guarded: while `auth.status === "loading"` → `<div className="max-w-md mx-auto py-16 px-4">Loading...</div>`. If no `user` → signed-out block: `"max-w-md mx-auto py-16 px-4"` with "You must be signed in to upload songs." + `<Link to="/signin" className="underline">Sign in</Link>`.

Root: `<div className="max-w-5xl mx-auto py-12 px-4">`, `<h1 className="text-2xl font-semibold mb-6">Add a song</h1>`.

### Mode toggle (segmented control)
- Container: `"mb-8 inline-flex rounded-2xl border border-white/25 bg-white/[0.02] p-1.5"`.
- Two buttons; active class `"bg-foreground text-background"`, inactive `"text-foreground/80 hover:text-foreground"`; base `"h-10 px-5 rounded-xl text-sm font-medium transition-colors"`.
- Modes: **`"spotify"` (default)** = "Spotify link", **`"upload"`** = "Upload files". State `mode: "upload" | "spotify"`.

### MODE 1 — File upload (`mode === "upload"`)
- `<form onSubmit={onUploadSubmit} className="max-w-2xl rounded-3xl border border-white/20 bg-white/[0.02] p-6 md:p-7 space-y-5">`.
- Inputs: Title + Artist (`"w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"`, both `required`).
- Two file dropzone `<label>`s (`"rounded-2xl border border-dashed border-white/30 bg-black/20 p-4 cursor-pointer transition-colors hover:border-yellow-500/60 focus-within:border-yellow-500/60 focus-within:ring-2 focus-within:ring-yellow-500/50"`):
  - Cover image: `accept="image/*"`, hint "JPG, PNG, WEBP".
  - Audio file: `accept="audio/*"`, hint "FLAC, MP3, WAV".
  - Selected filename chip: `"mt-3 inline-block text-xs px-2.5 py-1 rounded-lg bg-white/10"`. Inputs are `className="sr-only"`.
- Submit button: `"h-11 px-5 rounded-2xl bg-yellow-500 text-black font-semibold disabled:opacity-50 inline-flex items-center gap-2"`, shows `<Loader2 className="animate-spin">` + "Uploading..." while loading.
- **`onUploadSubmit`** → validates all 4 fields present, builds `FormData { title, artist, image: File, audio: File }`, then:
  - `POST /api/songs` with `{ method: "POST", body: form, credentials: "include" }` (multipart, **no content-type header set** — browser sets boundary).
  - On !ok: parse JSON `{ error }`, throw. On ok: `invalidateLibraryApiCache()` then `navigate("/")`.
- **PORTING HAZARD:** uses browser `File` objects + `FormData` with `File`. In RN, file pickers (`expo-document-picker`/`expo-image-picker`) return `{ uri, name, type }`; build `FormData` with `{ uri, name, type }` instead of `File`. The native HTTP bridge (CapacitorHttp) is noted elsewhere to mangle multipart — see Profile image note; consider base64-JSON fallback for RN too.

### MODE 2 — Spotify link (`mode === "spotify"`)
URL input + Fetch button row: input `"flex-1 border border-white/25 rounded-2xl px-4 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"` placeholder `"Spotify playlist, album, or Liked Songs URL"`; Fetch button `"h-11 px-5 rounded-2xl bg-yellow-500 text-black font-medium disabled:opacity-50 inline-flex items-center gap-2"` (Loader2/Download icon).

Two sub-flows inside Spotify mode:

#### (a) Single track
`handleFetchSpotify()` when URL is NOT `/album/`, `/playlist/`, `/collection/`:
- `POST /api/songs/spotify` body `{ action: "fetch", spotifyUrl, region: "US" }`, headers `content-type: application/json`, `credentials: "include"`. Response `{ track: SpotifyTrack }` → `setSpotifyTrack`.
- `SpotifyTrack` = `{ spotifyId, title, artist, album, releaseDate, totalPlays, durationMs, imageUrl, previewUrl }`.
- **Track card** (`"rounded-3xl border p-5 bg-black/[0.03] dark:bg-white/[0.03]"`): 224×224 cover (`"relative w-56 h-56 rounded-2xl overflow-hidden bg-black/10"`) with a duration badge `"absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-0.5 rounded-lg"`; title `"text-4xl font-bold leading-tight break-words"`, artist `"text-2xl text-foreground/70 mt-1"`; meta grid (Album / Release Date / Total Plays).
- **Download** button (`handleAddFromSpotify`): `"h-11 flex-1 justify-center rounded-2xl bg-yellow-500 px-5 text-black font-semibold ..."`.
- **Preview toggle** (only if `previewUrl`): `"h-11 w-11 rounded-2xl border inline-flex items-center justify-center"` — uses `new Audio(previewUrl)` (`previewAudioRef`). **PORTING HAZARD: `new Audio()`** — replace with `expo-av`/TrackPlayer. Cleanup pauses + resets on unmount.
- Lyrics fetch before import: `POST /api/songs/spotify` body `{ action: "lyrics", spotifyUrl, title, artist, region: "US" }` → `{ lyrics: string }` (best-effort, errors → "").
- **Import**: `POST /api/songs` JSON body:
  ```json
  { "mode": "spotify", "spotifyUrl", "region": "US", "title", "artist", "album",
    "durationMs": "<string>", "imageUrl", "qualityProfile": "max", "outputFormat": "flac",
    "lyricsText?": "...", "replaceExisting?": "true" }
  ```
  - **409 + `{ code: "DUPLICATE_SONG", existingSong: { title, artist } }`** → opens the Replace modal. On confirm, resubmit with `replaceExisting: "true"`. On success: `invalidateLibraryApiCache()` + `navigate("/")`.
- **Output format is locked to FLAC**: `requestedOutputFormat: OutputFormat = "flac"`; the `<select id="upload-output-format" disabled>` only offers `FLAC (Lossless)`. Comment: server imports only accept FLAC (`assertServerImportOutputFormat`). `qualityProfile` always `"max"`.

#### (b) Batch (album / playlist / collection)
`handleFetchSpotify()` when URL contains `/album/`, `/playlist/`, or `/collection/`:
- **First tries client-side**: `resolveSpotifyBatchOnClient(url, cookie, "flac")` (`src/lib/spotify-batch-client.ts`). Cookie from `readSpotifyCookie()`.
- **Falls back to server**: `POST /api/songs/spotify/batch` JSON `{ spotifyUrl, region: "US", outputFormat: "flac", qualityProfile: "max", spotifyCookie }` → `{ batchInfo }`.
- `ClientBatchInfo`/`BatchInfo` = `{ type: "track"|"album"|"playlist", title, artist, trackCount, format: "flac"|"mp3"|"aac"|"ogg"|"opus"|"wav", trackIds: string[], tracks?: SpotifyTrack[] }`.
- `resolveSpotifyBatchOnClient`: `/collection/` → requires sp_dc cookie, calls `fetchSpotifyLikedTracks(cookie)`; `playlist/<22-char id>` → `fetchSpotifyPlaylistTracks`; `album/<22-char id>` → album path. Returns `batchFromTracks(...)`.
- **Batch info card** (`"rounded-3xl border border-white/20 bg-white/[0.02] p-6"`): rows Type/Title/Artist/Tracks/Format, then **Download All (N tracks)** button + **Cancel** button (shown only while loading).
- **`handleBatchDownload`**: sequential loop with `AbortController` (`batchAbortRef`), per-track: refresh metadata if `needsTrackMetadataRefresh` (calls `fetchSpotifyTrackById`), dedupe by `normalizeTrackKey(title, artist)`, fetch lyrics, `submitTrackImport` (same `/api/songs` JSON shape; 409 DUPLICATE_SONG → counted as "skipped"). Paces with `delay()` (200–500ms). Tracks `succeeded/skipped/failed`, collects failures.
- **Progress UI**: `currentTrack` label + `current/total`, a yellow progress bar `"h-2 rounded-full bg-white/10 overflow-hidden"` → inner `"h-full bg-yellow-500 transition-all duration-300"` width %, and `succeeded · skipped · failed` text. Failures in a `<details>`.
- **Auto-start via URL params** (`useEffect`): reads `window.location.hash` and `window.location.search` for `spotifyCookie` (hash preferred — never sent to server), `url`, `autostart=1`. Writes cookie via `writeSpotifyCookie`, sets `spotifyUrl`, then `window.history.replaceState({}, "", "/upload")`. **PORTING HAZARD: `window.location`/`history` + custom DOM event `"spotify-start-batch-download"` (`window.dispatchEvent`/`addEventListener`).** All of this is web-only; in RN use deep-link params (`expo-linking`) and a direct function call / event-emitter, not `window`.

### Replace-song modal — **PORTING HAZARD: DOM focus trap**
- `showReplaceModal` overlay `"fixed inset-0 z-50 bg-black/70 grid place-items-center p-4"`; dialog `"w-full max-w-md rounded-2xl border border-white/20 bg-zinc-950 p-5 space-y-4"`, `role="dialog" aria-modal`.
- Buttons: "Keep Existing" (`"h-10 px-4 rounded border border-white/30"`) and "Replace Song" (`"h-10 px-4 rounded bg-yellow-500 text-black font-medium ..."`).
- Effect implements Escape-to-close, **Tab focus trap via `document.querySelectorAll` / `document.activeElement` / `requestAnimationFrame`**, and focus restore. None of this exists in RN — use a `<Modal>` component; focus management is unnecessary.

### Spotify cookie storage (`src/lib/spotify-cookie.ts`) — **PORTING HAZARD**
- Key `"spotify_sp_dc_cookie"`. `readSpotifyCookie()` prefers `sessionStorage` then `localStorage`. `writeSpotifyCookie(v)` writes to `sessionStorage`, clears localStorage (or clears both if empty). **Replace `sessionStorage`/`localStorage` with secure storage (`expo-secure-store`) — this is a sensitive Spotify auth cookie.**

### Misc UploadPage hazards
- `window.setTimeout` in `delay()`, `window.location/history`, custom DOM events, `new Audio()`, `File`/`FormData` with `File`, `document.*` focus trap, `requestAnimationFrame`.
- `invalidateLibraryApiCache()` from `@/client/api` — re-implement against the RN data layer.

---

## SettingsPage (`src/client/pages/SettingsPage.tsx`)

Thin container only:
```tsx
<div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
  <div className="mx-auto max-w-3xl space-y-8">
    <h1 className="mb-6 text-2xl font-semibold">Settings</h1>
    <OfflineSettings />
    <CrossfadeSettings />
  </div>
</div>
```
Renders `<OfflineSettings />` then `<CrossfadeSettings />`. No own state/logic.

### CrossfadeSettings (`src/components/CrossfadeSettings.tsx`)
- Pure store-bound. Reads `crossfadeEnabled`, `crossfadeSeconds`; writes via `setCrossfadeEnabled`, `setCrossfadeSeconds`.
- Layout: `"space-y-6"` → `<h2 className="text-lg font-medium mb-2">Playback</h2>` → card `"rounded border border-black/10 dark:border-white/10 p-4"`.
- **Enable checkbox**: `<label htmlFor="crossfade-enabled" className="flex items-center gap-2">` + `<input type="checkbox" checked={crossfadeEnabled} onChange={e => setCrossfadeEnabled(e.target.checked)} />` + "Enable crossfade between songs". (RN: use `Switch`.)
- **Duration slider** (`"mt-4 opacity-80"`): label `"block text-sm mb-2"` → `Crossfade duration: {crossfadeSeconds}s` (the number wrapped in `<span suppressHydrationWarning>`).
  - `<input type="range" min={0} max={12} step={1} value={crossfadeSeconds} onChange={e => setCrossfadeSeconds(Number(e.target.value))} disabled={!crossfadeEnabled} className="w-full h-1.5 appearance-none rounded bg-black/10 dark:bg-white/10 accent-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" />`.
  - **Range 0–12 s, step 1, disabled when crossfade off.** (RN: `@react-native-community/slider` with `minimumValue={0} maximumValue={12} step={1} disabled={!enabled}`.)

### OfflineSettings (`src/components/OfflineSettings.tsx`) — **heavy PORTING HAZARDS**
This is the offline-storage dashboard. Data from `useOfflineStore` (`@/client/offline`) + `readOfflineDiagnostics()` (`@/client/offline-diagnostics`).
- Store fields read: `records` (map of download records), `pendingMutations`, `syncStatus`, `syncError`, `storageUsage`, `storageQuota`, `persistentStorage`, `nativeStorage`, `verificationStatus` (`"checking"|"ok"|"repair-needed"|"failed"|...`), `verificationCheckedAt`, `verifiedDownloads`, `missingDownloads`, `verificationError`, `autoDownloadLiked`.
- Store actions: `hydrate`, `retryFailedDownloads`, `clearPlaybackCache`, `clearDownloads`, `verifyDownloads`, `syncMutations`, `refreshStorage`, `setAutoDownloadLiked`, `queueDownloads`. Local helpers: `formatBytes`, `readDownloadedBytesTotal` (IDB total), `readOfflineDiagnostics`.
- `useEffect(hydrate)` on mount; `readDownloadedBytesTotal()` recomputed on `[records, storageUsage]`; diagnostics on mount + via Refresh.
- Derived: counts `downloaded/failed/active` from `records` by `status`; `usedPercent`, `freeBytes`; `verificationLabel`/`verificationIcon`; cache buckets from diagnostics (`shell/static/app-assets`, `*-runtime`, `media|playback`).
- **Auto-download liked toggle** (`handleAutoDownloadLikedChange`): on enable, `fetch("/api/liked", { credentials:"include", cache:"no-store", headers:{accept:"application/json"} })` → `LikedPayload { songs }`, then `queueDownloads(likedSongs, "liked")` (re-checks the toggle is still on after the await).
- Layout: `<section className="rounded-lg border border-white/[0.12] bg-white/[0.04] p-4">`; header icon tile `"grid h-10 w-10 place-items-center rounded-full bg-emerald-500/15 text-emerald-300"` (`<Database size={19}/>`), `<h2 className="text-lg font-semibold">Offline</h2>`, subtitle `{downloaded} downloaded · {active} active · {failed} failed`.
- Stat grid `<dl className="grid gap-3 text-sm sm:grid-cols-2">`, each cell `"rounded-md bg-black/20 p-3"`: Storage used (+%), Available (free), Downloaded media, Storage mode (Native app files / Persistent / Best effort / Not reported), Sync (Up to date / N pending [· sign in required]), Download verification (icon + label + `verifiedDownloads ok · missingDownloads repaired/missing`).
- Action buttons row `"mt-4 flex flex-wrap gap-2"` — pill buttons `"inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.08] px-3 text-sm font-medium text-white/[0.78] ..."`: Retry failed, Verify downloads (disabled while checking), Sync now, Refresh (storage+diagnostics). Then **Clear playback cache** and **Clear downloads** (red: `"bg-red-500/15 ... text-red-200 hover:bg-red-500/20"`).
  - **PORTING HAZARD: `window.confirm(...)`** gates both clear actions — replace with an RN `Alert.alert` confirm dialog.
- Auto-download-liked checkbox `<label className="mt-4 flex cursor-pointer items-center gap-3 rounded-md bg-black/20 p-3 text-sm">` + `<input type="checkbox" className="h-4 w-4 accent-emerald-500">` + "Automatically download liked songs".
- **Diagnostics** subsection (`"mt-5 border-t border-white/[0.1] pt-4"`): App shell / Service worker / API snapshots / Media cache / Offline database / Playback sync, each `"rounded-md bg-black/20 p-3"`. **PORTING HAZARD:** diagnostics expose web-only primitives — Service Worker (`controlled`/`registrationState`), **IndexedDB** (`apiSnapshots`, `downloads`, `mutations`), **Cache Storage** entries/bytes. None exist in RN; the entire offline subsystem (Cache API, Service Worker, IndexedDB, `navigator.storage` quota) must be rebuilt on `expo-file-system` + SQLite/MMKV. `readDownloadedBytesTotal` reads IDB.

---

## ProfilePage (`src/client/pages/ProfilePage.tsx`)

### Data source
- `useAuth()` → `{ user, status, signOut, updateProfileImage }`.
- Guards: `status === "loading"` → `<div className="px-4 py-8 text-white sm:px-6 lg:px-10"><div className="opacity-70">Loading profile...</div></div>`. No `user` → `<Navigate to="/signin" replace />` (RN: `navigation.replace("SignIn")`).
- `displayName = user.name || "Profile"`.

### Layout & verbatim classNames
- Root: `"min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-10"` → `"mx-auto max-w-3xl"`.
- Header: `"flex items-center gap-5 border-b border-white/[0.1] pb-7"`.
  - Avatar wrapper `"relative h-24 w-24 shrink-0"` containing `<AccountAvatar src={user.image} alt={displayName} className="h-24 w-24 rounded-full border border-white/[0.14] object-cover shadow-[0_16px_36px_rgba(0,0,0,0.35)]" iconSize={42} />`.
  - **Camera button** (bottom-right): `"absolute bottom-0 right-0 grid h-9 w-9 place-items-center rounded-full border border-white/[0.18] bg-background text-white shadow-[0_8px_18px_rgba(0,0,0,0.35)] transition hover:bg-white/[0.1] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-wait disabled:opacity-70"`; shows `<Loader2 className="animate-spin">` while uploading else `<Camera size={16}/>`. Clicks `fileInputRef.current?.click()`.
  - Hidden `<input ref type="file" accept="image/*" className="sr-only">` → `handleProfileImageChange(files[0])` then resets `value`. **PORTING HAZARD: hidden file input.** Replace with `expo-image-picker`.
  - Right column: `"text-sm font-medium uppercase tracking-[0.18em] text-white/[0.48]">Profile`, `<h1 className="mt-1 truncate text-3xl font-semibold sm:text-4xl">{displayName}</h1>`, email `"mt-2 truncate text-[15px] text-white/[0.64]"`, optional `imageError` `"mt-2 text-sm text-red-300"`.
- Action grid `"mt-6 grid gap-3 sm:grid-cols-2"`:
  - `<Link to="/settings" className="flex min-h-14 items-center gap-3 rounded-md border border-white/[0.12] px-4 text-white/[0.78] transition hover:bg-white/[0.07] hover:text-white">` + `<Settings size={19}/>` + "Settings".
  - Sign out `<button className="flex min-h-14 items-center gap-3 rounded-md border border-white/[0.12] px-4 text-left ...">` + `<LogOut size={19}/>` + "Sign out" → `await signOut(); navigate("/")`.

### `updateProfileImage` (auth) — **PORTING-RELEVANT**
- `POST /api/profile/image`. **Native path** (CapacitorHttp mangles multipart): JSON `{ image: <base64>, filename, contentType }`. **Web path**: `FormData { image: File }`. Both `credentials: "include"`. Response `{ user }` → updates cached auth user. **In RN/Expo prefer the base64-JSON path** (same reason: native HTTP bridges struggle with multipart).

---

## SignInPage (`src/client/pages/SignInPage.tsx`)

### Data source / API
- `useAuth().signIn(email, password)` → `POST /api/auth/signin`, headers `content-type: application/json`, `credentials: "include"`, body `{ email, password }`. Response `{ user, error? }`; throws `"Invalid email or password"` on failure. **Auth is cookie-session based** (no token in body) — RN needs a cookie jar or to switch to token auth.
- On success: `navigate(resolveRedirectTarget(location.state, location.search), { replace: true })`.
- `resolveRedirectTarget`: prefers `location.state.from`, else `?next=`, else `/`. **Open-redirect guard**: only accepts paths starting with `/` and NOT `//`.

### Layout & classNames
- Root `"max-w-md mx-auto py-16 px-4"`, `<h1 className="text-2xl font-semibold mb-6">Sign in</h1>`, `<form className="space-y-4">`.
- Email input: `type="email" autoComplete="email"`, label `"block text-sm mb-1"`, input `"w-full border rounded px-3 py-2 bg-transparent"`, `required`.
- Password input: `type="password" autoComplete="current-password"`, same classes, `required`.
- Error: `<div role="alert" className="text-sm text-red-600">` (id `signin-error`, referenced by inputs' `aria-describedby`).
- Submit: `"w-full h-10 rounded bg-foreground text-background disabled:opacity-50"`, label "Signing in..."/"Sign in".
- Footer: "Don't have an account? " + `<Link to="/register" className="underline">Register</Link>`.

---

## RegisterPage (`src/client/pages/RegisterPage.tsx`)

### Data source / API
- Direct `fetch("/api/register", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ name, email, password }) })`. **Note: no `credentials:"include"` here** (unlike signin). Response on !ok: `{ error }`.
- On success → sets `submitted = true` (does NOT auto-navigate or auto-login).

### Two states
**(1) Form state:**
- Root `"max-w-md mx-auto py-16 px-4"`, `<h1 className="text-2xl font-semibold mb-6">Create your account</h1>`, `<form className="space-y-4">`.
- Name input (`autoComplete="name"`, NOT required), Email (`type="email" autoComplete="email"`, required), Password (`type="password" autoComplete="new-password"`, `minLength={8} maxLength={128}` required). Inputs all `"w-full border rounded px-3 py-2 bg-transparent"`, labels `"block text-sm mb-1"`.
- Password hint `<p id="register-password-hint" className="mt-1 text-xs text-white/[0.5]">At least 8 characters.</p>`.
- Error `<div role="alert" className="text-sm text-red-600">`.
- Submit `"w-full h-10 rounded bg-foreground text-background disabled:opacity-50"`, "Creating..."/"Create account".
- Footer "Already have an account? " + `<Link to="/signin" className="underline">Sign in</Link>`.

**(2) "Check your email" submitted state:**
- `"max-w-md mx-auto py-16 px-4"`, `<h1 className="text-2xl font-semibold mb-4">Check your email</h1>`.
- `<p className="text-sm text-white/[0.68] mb-6">` text: `If {email || "that address"} is new, we've sent a verification link to it. You can sign in right away — just verify when you get a chance.`
- `<Link to="/signin" className="inline-flex h-10 items-center justify-center rounded bg-foreground px-4 text-background">Go to sign in</Link>`.
- Verification is **optional / non-blocking** — user can sign in immediately. (`useAuth` also exposes `resendVerification` → `POST /api/auth/resend-verification`, not used on this page.)

---

## Consolidated API route reference (these pages)

| METHOD path | Request body | Response | Auth | Notes |
|---|---|---|---|---|
| `GET /api/podcast-feeds/:id` | — | raw RSS XML text | cookie | `:id` = show id; non-200 → throw |
| `GET /api/podcast-media/:id?url=<enc>` | — | media bytes (audio/img) | cookie | server validates url against show feed allowlist; **relative URL** |
| `POST /api/songs` (file) | multipart `FormData { title, artist, image:File, audio:File }` | 200 / `{error}` | cookie `credentials:include` | no content-type header |
| `POST /api/songs` (spotify import) | JSON `{ mode:"spotify", spotifyUrl, region:"US", title, artist, album, durationMs:string, imageUrl, qualityProfile:"max", outputFormat:"flac", lyricsText?, replaceExisting? }` | 200 / **409 `{code:"DUPLICATE_SONG", existingSong:{title,artist}}`** / `{error}` | cookie | |
| `POST /api/songs/spotify` | JSON `{ action:"fetch"\|"lyrics", spotifyUrl, region:"US", title?, artist? }` | fetch→`{track:SpotifyTrack}`, lyrics→`{lyrics:string}` | cookie | |
| `POST /api/songs/spotify/batch` | JSON `{ spotifyUrl, region:"US", outputFormat:"flac", qualityProfile:"max", spotifyCookie }` | `{batchInfo}` | cookie | server fallback only |
| `GET /api/liked` | — | `LikedPayload { songs }` | cookie `cache:no-store` | offline backfill |
| `POST /api/auth/signin` | JSON `{ email, password }` | `{ user, error? }` | sets session cookie | |
| `POST /api/auth/signout` | — | — | cookie | |
| `POST /api/register` | JSON `{ name, email, password }` | 200 / `{error}` | none (no credentials) | password 8–128 |
| `POST /api/auth/resend-verification` | — | — | cookie | not used by RegisterPage |
| `POST /api/profile/image` | web: `FormData{image:File}`; native: JSON `{image:base64, filename, contentType}` | `{ user, error? }` | cookie | use base64 path in RN |

All routes are **same-origin relative URLs** — every `fetch` call must be rebased to the API host in RN.

---

## Top porting hazards for this area (whole-batch summary)

1. **Web-only audio + autoplay-gesture plumbing.** `requestImmediatePlayback` dispatches a `window` `CustomEvent` to start `<audio>`/AVPlayer inside the gesture tick, the Spotify preview uses `new Audio()`, and the BBC station is **HLS (.m3u8)**. RN has no `window`/DOM events, no autoplay gate, and needs an explicit HLS-capable player (TrackPlayer/expo-av). Rip out the gesture event and call the native player directly.
2. **Storage primitives across the board.** localStorage (`spotify_podcast_progress`, crossfade keys), sessionStorage/localStorage (`spotify_sp_dc_cookie` — sensitive), and the entire OfflineSettings subsystem (IndexedDB, Cache Storage, Service Worker, `navigator.storage` quota, `window.confirm`) do not exist in RN. Rebuild on AsyncStorage/MMKV + `expo-secure-store` (cookie) + `expo-file-system`/SQLite (downloads & diagnostics).
3. **DOMParser-based RSS/HTML parsing + relative same-origin fetch.** `parsePodcastFeed`/`stripHtml` use `DOMParser` (absent in RN → use `fast-xml-parser`), and every API call plus the podcast media/image proxy (`/api/podcast-media/...`) is a relative URL that must be rebased to the backend host. Secondary web-only bits: UploadPage's `window.location`/`history.replaceState`, custom DOM events, `File`/`FormData` multipart (CapacitorHttp mangles it — use base64 JSON), and the manual `document` focus-trap modal.
