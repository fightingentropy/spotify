# Port Notes — Home / Library / Search

Source app: Vite + React 19 + Tailwind v4 + Zustand, wrapped in Capacitor.
Target: Expo / React Native (NativeWind).

This document covers three top-level pages plus the search UI component and the shared
search-scoring lib:

- `src/client/pages/HomePage.tsx`
- `src/client/pages/LibraryPage.tsx`
- `src/client/pages/SearchPage.tsx`
- `src/components/MobileSearch.tsx`
- `src/lib/search-scoring.ts`

Cross-referenced supporting code (read for shapes, not part of this port slice but
required to understand it): `src/client/api.ts`, `src/types/player.ts`, `src/store/likes.ts`.

---

## 0. Shared data layer (must port first)

### `useApiData<T>(url, initialValue, options?)` — `src/client/api.ts:395`

Custom data hook used by all three pages. Returns `{ data, loading, error }`.

Signature:
```ts
useApiData<T>(
  url: string,
  initialValue: T,
  options?: { enabled?: boolean; keepPreviousData?: boolean; refreshOnReconnect?: boolean },
): { data: T; loading: boolean; error: string | null }
```

Behavior to reproduce in RN:
- `enabled` (default `true`): when false, never fetches, `loading=false`.
- `keepPreviousData` (default `false`): when true, suppresses spinner/error **only if data is
  already on screen**; on a cold load (no visible data) errors are NOT masked.
- `refreshOnReconnect` (default `true`): adds a `window.addEventListener("online", ...)` handler
  that re-fetches in the background. **PORTING HAZARD: `window` + `"online"` event are web-only.**
  In RN use `@react-native-community/netinfo` `addEventListener` instead.
- Reads from an in-memory `Map` cache (`apiCache`) keyed by full URL, plus a persisted
  offline snapshot layer (`readOfflineApiSnapshot`) that uses IndexedDB on web.
  **PORTING HAZARD: the offline snapshot store is IndexedDB-backed; reimplement on
  AsyncStorage / expo-sqlite / MMKV.**
- Fetch timeout is `5_000` ms; snapshot read timeout `1_000` ms.
- The fetch path (`fetchApiData`) uses **relative URLs** (e.g. `/api/home`) resolved against the
  page origin. **PORTING HAZARD: relative fetch does not work in RN — every endpoint must be
  prefixed with an absolute base URL (the self-hosted Worker origin).** Note the cache code parses
  URLs against a dummy base `http://spotify.local` to extract pathname/query, so the cache key
  semantics survive an absolute-URL rewrite as long as you keep the `?auth=` query param.

### `withAccountScope(url, scope)` — `src/client/api.ts:48`

Appends `?auth=<scope>` to a URL. `scope` falls back to `"anonymous"` when null/empty/whitespace.
Used to make per-account API responses cache-distinct. Every account-scoped page call wraps its URL:
```ts
withAccountScope("/api/home", user?.id ?? status)
```
So the actual fetched URL is e.g. `/api/home?auth=<userId>` (or `?auth=anonymous` /
`?auth=loading` when signed out / loading). **Port verbatim — it is pure string/URL manipulation.**

### Auth — `useAuth()` from `src/client/auth`

Returns `{ user, status }`. `status` is one of `"loading" | ...` (signed-in vs out reflected by
`user` being truthy). Pages gate fetches on `status !== "loading"` and use `user?.id ?? status`
as the account scope. `signedIn = !!user`.

### `PlayerSong` type — `src/types/player.ts:1`

```ts
type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
  networkImageUrl?: string;   // set by offline resolution; original remote cover URL fallback
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
  staged?: boolean;           // Discover Top-50 track playing from hidden .discover cache; NOT in library
  discoverTrackId?: string;   // Spotify track id used for promote-to-library
};
```

---

# 1. HomePage — `src/client/pages/HomePage.tsx`

Default export `HomePage()`. The home screen. Three horizontally-scrolling card rows:
**Discover → Recently played → Most played** (in that exact DOM order).

## 1.1 Data sources (three concurrent `useApiData` calls)

| Variable | URL (after scope) | Initial value | Options | Response type |
|---|---|---|---|---|
| `homeData` | `withAccountScope("/api/home", user?.id ?? status)` | `{ songs: [], likedSongIds: [] }` | `{ enabled: status !== "loading", keepPreviousData: true }` | `HomePayload` |
| `statsData` | `withAccountScope("/api/stats/home", user?.id ?? status)` | `{ recentlyPlayed: [], mostPlayed: [] }` | `{ enabled: status !== "loading", keepPreviousData: true }` | `StatsHomePayload` |
| `discoverData` | `"/api/discover/trending"` (NOT account-scoped — same global Spotify Top 50 for everyone) | `{ tracks: [] }` | `{ enabled: status !== "loading", keepPreviousData: true }` | `DiscoverPayload` |

Payload shapes (`src/client/api.ts`):
```ts
type HomePayload      = { songs: PlayerSong[]; likedSongIds: string[] };
type StatsHomePayload = { recentlyPlayed: PlayerSong[]; mostPlayed: { song: PlayerSong; playCount: number }[] };
type DiscoverPayload  = { tracks: DiscoverTrack[] };
type DiscoverTrack = {
  id: string;             // Spotify track id
  title: string;
  artist: string;
  album: string;
  imageUrl: string;
  durationMs: number | null;
  spotifyUrl: string;
  staged?: boolean;       // true => pre-downloaded into .discover cache, plays instantly
  audioId?: string;       // stable library id (only when staged)
  audioUrl?: string;      // playable URL (only when staged)
};
```

Local `HomeSong` type extends `PlayerSong` with optional `album`, `duration`, `durationMs`.

## 1.2 Likes-store seeding from `/api/home` `likedSongIds` (CRITICAL — easy to miss)

```ts
const mergeInitialLikes = useLikesStore((state) => state.mergeInitial);
useEffect(() => {
  mergeInitialLikes(homeData.likedSongIds);
}, [mergeInitialLikes, homeData.likedSongIds]);
```
Home no longer renders a `SongGrid` (which historically seeded likes), so **without this effect the
like buttons stay disabled** until the user opens a song-list page — including the heart for Discover
tracks. The implementer MUST replicate this seeding on the Home screen.

`mergeInitial(ids)` semantics (`src/store/likes.ts:80`): preserves local-only liked ids
(`browser-local:` / `picked-file:` prefixes), unions in the incoming server ids, then overlays
in-flight optimistic toggles (`pending`) so a save-in-progress isn't clobbered. Sets `hydrated:true`.
**PORTING HAZARD: `likes` store reads/writes `localStorage` (`spotify_local_liked_song_ids`) for
local-only likes — replace with AsyncStorage/MMKV.**

## 1.3 Player store wiring

```ts
const setQueue = usePlayerStore((s) => s.setQueue);
const play     = usePlayerStore((s) => s.play);
const pause    = usePlayerStore((s) => s.pause);
const currentSongId          = usePlayerStore((s) => s.currentSong?.id ?? null);
const currentDiscoverTrackId = usePlayerStore((s) => s.currentSong?.discoverTrackId ?? null);
const isPlaying              = usePlayerStore((s) => s.isPlaying);
```

## 1.4 Offline resolution

```ts
const offlineRecordsSignature = useOfflineStore((state) => {
  const ids: string[] = [];
  for (const id of Object.keys(state.records))
    if (state.records[id]?.status === "downloaded") ids.push(id);
  return ids.sort().join("|");
});
const resolveHomeSong = useCallback((song) => resolveOfflinePlaybackSong(song), [offlineRecordsSignature]);
```
Subscribes to a **stable string signature of downloaded record ids** (not the whole records map) so
per-tick download-progress updates don't churn re-renders. `resolveOfflinePlaybackSong(song)` swaps
`audioUrl`/`imageUrl` to device-local paths for downloaded songs (and sets `networkImageUrl`).
**PORTING HAZARD: offline store + local file paths are Capacitor-Filesystem-specific; reimplement
with expo-file-system.**

## 1.5 Playback warm-up

```ts
const warmSongSoon = useCallback((song) => { warmPlaybackSong(song, true); }, []);
```
Called on `onPointerEnter` / `onFocus` of a scroller tile (prefetch on hover/focus).
**PORTING HAZARD: `onPointerEnter`/hover does not exist on touch RN.** Drop hover-warm; optionally
warm on tap or on viewport-visible. `requestImmediatePlayback(song)` (`src/lib/playback-gesture`)
captures the user-gesture for autoplay — web Audio unlock concept; review for RN audio engine.

## 1.6 Tap behavior

### Scroller tiles (Recently played + Most played) — `handlePlayScrollerSong(songs, index)`
Tap-active-to-toggle, tap-other-to-play:
- If tapped song `id === currentSongId`:
  - if `isPlaying` → `pause()`
  - else → `requestImmediatePlayback(song); play()`
- Else → `requestImmediatePlayback(song); setQueue(songs, index)` (sets whole row as queue starting
  at the tapped index).

The whole card is clickable (`onClick={() => handlePlayScrollerSong(songs, index)}`). The floating
green play button **also** calls it but `event.stopPropagation()`s first (so mouse users don't
double-toggle). On touch the floating button is hidden (hover-only), so the card-tap is the path.

### Discover tiles — `onTap` + `handleDiscoverClick(track)`
`active = currentDiscoverTrackId != null && currentDiscoverTrackId === track.id`.
- `onTap`: if `active` → toggle (`isPlaying ? pause() : play()`); else → `void handleDiscoverClick(track)`.
- `handleDiscoverClick(track)` (async):
  1. **Instant path** — if `track.staged && track.audioUrl && track.audioId`: build a `HomeSong`
     from the track (`id: track.audioId`, `audioUrl`, `source:"server"`, `staged:true`,
     `discoverTrackId: track.id`, `duration = durationMs ? round(durationMs/1000) : undefined`),
     `resolveHomeSong(...)`, `requestImmediatePlayback(song)`, `setQueue([song], 0)`. Return.
  2. **Materialize path** — guard `if (importingId) return;` set `importingId`, clear `importError`,
     then `POST /api/discover/stage` (see §1.8). On success: `resolveHomeSong(json)`,
     `requestImmediatePlayback`, `setQueue([song], 0)`. On error set `importError`. Finally clear
     `importingId`.
- Tapping a Discover tile **plays without adding to library**. Keep/like/add-to-playlist/download is
  what promotes it (handled elsewhere via `/api/discover/promote`).

## 1.7 Loading / error / empty states

- Loading: `if (loading || status === "loading")` → full-bleed div, text **"Loading library..."**.
  Wrapper className: `min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-12`;
  inner: `opacity-70`.
- Error: `if (error)` → same wrapper className; inner: `text-red-400`, prints `{error}`.
- Empty: each section is conditionally rendered only when its array has length > 0
  (`discoverData.tracks.length > 0`, `recentlyPlayedSongs.length > 0`, `statsData.mostPlayed.length > 0`).
  If all empty, the page renders just the spacer `<div className="h-8 lg:h-20" />`. No explicit
  "empty home" message.
- Discover import error: shown inside the Discover section as
  `<div role="alert" className="mb-3 text-sm text-red-400">{importError}</div>`.

## 1.8 Network: `POST /api/discover/stage`

Materializes one Discover track on demand. `fetch` with `credentials: "include"` (cookie auth):
```
POST /api/discover/stage
headers: { "content-type": "application/json" }
credentials: "include"
body (JSON): {
  spotifyUrl: track.spotifyUrl,
  region: "US",
  title: track.title,
  artist: track.artist,
  album: track.album,
  durationMs: track.durationMs ?? undefined,
  imageUrl: track.imageUrl,
  qualityProfile: "max"
}
```
Response: a `HomeSong`/`PlayerSong` JSON (used directly as the queue song).
Error handling: `if (!res.ok)` read `{ error?: string }` and throw `body?.error || "Couldn't load this track (" + res.status + ")"`.
**PORTING HAZARDS: relative URL; `credentials:"include"` cookie auth (RN needs explicit cookie or
token header against absolute origin).**

## 1.9 Layout, section order, and verbatim classNames

Page root (return):
```html
<div className="relative min-h-[calc(100vh-3.5rem)] overflow-x-hidden bg-background text-white">
  <div className="relative px-4 pb-10 pt-12 sm:px-6 md:pt-16 lg:px-6 xl:px-8 2xl:px-10">
```

**Section order is fixed:** Discover, Recently played, Most played, then a trailing spacer.

Each `<section>`: `aria-label` + className `"mb-9 md:mb-10"`.
Each section heading `<h2>`: `"mb-4 text-2xl font-bold"` with text **"Discover"**, **"Recently played"**,
**"Most played"** respectively.
Each row container (horizontal scroller):
```
className="flex gap-4 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0"
```
(In RN: a horizontal `ScrollView`/`FlatList`; the `-mx-4 px-4` negative-margin bleed gives edge-to-edge
scroll under the page padding — reproduce with `contentContainerStyle` horizontal padding.)

Trailing spacer: `<div className="h-8 lg:h-20" />`.

### Scroller tile (`renderScrollerTile`) verbatim classNames
Outer card (`cn(...)`):
```
"wf-song-card group w-36 shrink-0 cursor-pointer rounded-md p-3 transition touch-manipulation sm:w-40"
+ (active ? "bg-white/[0.12]" : "hover:bg-white/[0.09]")
```
Cover wrapper:
```
"relative aspect-square overflow-hidden rounded-[5px] bg-white/[0.08] shadow-[0_10px_28px_rgba(0,0,0,0.35)]"
```
`<CoverImage>` props: `src={displaySong.imageUrl}` `networkSrc={displaySong.networkImageUrl}`
`alt={displaySong.title}` `fill` `sizes="160px"` `className="wf-song-cover object-cover"`
`loading={index < 6 ? "eager" : "lazy"}`.
Floating play button (`cn(...)`):
```
"absolute bottom-3 right-3 grid h-11 w-11 place-items-center rounded-full bg-[#1ed760] text-black shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121212]"
+ "wf-control-button"
+ (active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")
```
Icon: `active && isPlaying` → `<Pause size={21} fill="currentColor" />`, else
`<Play size={21} fill="currentColor" className="translate-x-0.5" />`.
Text block:
```
<div className="mt-3 min-w-0">
  <div className={cn("truncate text-[16px] font-medium leading-6 text-white", active && "text-[#1ed760]")}>{title}</div>
  <div className="truncate text-[14px] leading-5 text-white/[0.62]">{artist || "Unknown Artist"}</div>
  {subtitle ? <div className="mt-0.5 truncate text-[13px] text-white/[0.46]">{subtitle}</div> : null}
</div>
```

### Most-played subtitle ("N plays")
The Most played section passes a subtitle into `renderScrollerTile`:
```ts
entry.playCount > 0
  ? `${entry.playCount} ${entry.playCount === 1 ? "play" : "plays"}`
  : undefined
```
i.e. **"1 play"** or **"42 plays"**; omitted when `playCount === 0`.
`mostPlayedSongs = statsData.mostPlayed.map((entry) => entry.song)`.

### Discover tile (`renderDiscoverTile`) verbatim classNames
Outer card (`cn(...)`):
```
"wf-song-card group w-36 shrink-0 cursor-pointer rounded-md p-3 transition touch-manipulation sm:w-40"
+ (active || importing ? "bg-white/[0.12]" : "hover:bg-white/[0.09]")
```
Cover wrapper: same as scroller (`relative aspect-square overflow-hidden rounded-[5px] bg-white/[0.08] shadow-[0_10px_28px_rgba(0,0,0,0.35)]`).
`<CoverImage>`: `src={track.imageUrl}` `alt` `fill` `sizes="160px"` `className="wf-song-cover object-cover"` `loading="lazy"` (no `networkSrc`).
Importing overlay (only when `importing`):
```html
<div className="absolute inset-0 grid place-items-center bg-black/55">
  <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-white/25 border-t-white" />
</div>
```
Floating button (`cn(...)`, `disabled={importing}`):
```
"absolute bottom-3 right-3 grid h-11 w-11 place-items-center rounded-full bg-[#1ed760] text-black shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121212] wf-control-button"
+ (active || importing ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")
```
Button icon: `importing` → small spinner `<div className="h-5 w-5 animate-spin rounded-full border-2 border-black/30 border-t-black" />`; else `activePlaying` → `<Pause size={21} fill="currentColor" />`; else `<Play size={21} fill="currentColor" className="translate-x-0.5" />`.
Text block: title `cn("truncate text-[16px] font-medium leading-6 text-white", active && "text-[#1ed760]")`;
artist `"truncate text-[14px] leading-5 text-white/[0.62]"` (`track.artist || "Unknown Artist"`). No subtitle.

### Animations
- Spinners: Tailwind `animate-spin` (continuous rotate). Reproduce with `react-native-reanimated`.
- Hover-opacity transitions on play buttons (`opacity-0 group-hover:opacity-100`, `transition`) — drop
  on touch; show button always (or on active) in RN.

### Color constants
- Green accent / play button: `#1ed760`; ring offset dark bg `#121212`. Active title text `#1ed760`.
- Card hover/active surface: `white/[0.09]` hover, `white/[0.12]` active.

---

# 2. LibraryPage — `src/client/pages/LibraryPage.tsx`

Default export `LibraryPage()`. A vertical list of navigation rows ("shelves") plus the user's
playlists. Uses `react-router-dom` `<Link>` for navigation.
**PORTING HAZARD: `react-router-dom` `<Link to=...>` → React Navigation / Expo Router; rewrite each
`to` as a route push.**

## 2.1 Data source

```ts
const { data, loading, error } = useApiData<LibraryPayload>(
  withAccountScope("/api/library", user?.id ?? status),
  { playlists: [], userId: null },
);  // NOTE: no options object → enabled defaults true, keepPreviousData false, refreshOnReconnect true
```
`LibraryPayload = { playlists: PlaylistEntry[]; userId: string | null }`.
`PlaylistEntry = { id: string; name: string; imageUrl?: string|null; userId?: string; createdAt?: string; songsCount: number }`.

## 2.2 Signed-in / loading gating (non-obvious invariant)

```ts
const signedIn = !!user;  // from useAuth — NOT data.userId
const showSkeleton = status === "loading" || (signedIn && loading && data.playlists.length === 0);
```
The playlists section is driven by **real auth state (`!!user`)**, NOT `data.userId`, because
`data.userId` is null during cold-load / on fetch error even for a signed-in user, which would
otherwise flash a misleading "Sign in" prompt. **Preserve this exactly.**

## 2.3 Static rows (order + verbatim classNames + icon colors)

Every row shares this `<Link>` className (the static shelves and playlist rows):
```
"wf-list-row wf-pressable flex min-h-[64px] items-center gap-3 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5"
```
(Upload row additionally has `lg:hidden`.)

Each row = a 56×56 color-coded icon square (`h-14 w-14`) + a two-line text block:
text line `"text-[15px] leading-snug"`, subtitle `"mt-0.5 text-[13px] leading-snug text-[#b3b3b3]"`.

Row order (top to bottom):

1. **Liked Songs** → `/liked`
   Icon square: `"grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 text-white"` — **emerald gradient (top-left to bottom-right)**.
   Icon `<Heart size={24} />`. Title "Liked Songs", subtitle "Your favorites".

2. **Downloads** → `/downloads`
   Icon square: `"grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300"`.
   Icon `<Download size={24} />`. Title "Downloads", subtitle "Saved for offline".

3. **Radio Stations** → `/radio`
   Icon square: `"grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-cyan-500/15 text-cyan-200"`.
   Icon `<RadioTower size={24} />`. Title "Radio Stations", subtitle "Dromos 89.8 and BBC Radio 1".

4. **Podcasts** → `/podcasts`
   Icon square: `"grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-fuchsia-500/15 text-fuchsia-200"`.
   Icon `<Podcast size={24} />`. Title "Podcasts", subtitle "Huberman Lab and Modern Wisdom".

5. **Playlists section** (conditional — see §2.4).

6. **Upload** → `/upload` (`lg:hidden` — mobile only)
   Icon square: `"grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-black/5 text-lg font-semibold dark:bg-white/10"`, content literal **`+`** (no lucide icon). Title "Upload", subtitle "Add new music".

Icons come from `lucide-react`: `Download, Heart, ListMusic, Podcast, RadioTower`. **PORTING HAZARD:
swap to `lucide-react-native`.**

## 2.4 Playlists section (conditional rendering)

```
if showSkeleton            -> <PlaylistSkeletonRows />
else if signedIn:
    if data.playlists.length > 0 -> header "Playlists" + list of playlist <Link> rows
    else -> "Playlists" header + message: {error ?? "You don’t have any playlists yet."}
else (signed out) -> "Sign in to view your playlists." with a <Link to="/signin"> "Sign in" link
```

- Section header (when playlists exist): `<div className="px-3 pb-2 pt-4 text-xs uppercase tracking-wide opacity-60">Playlists</div>`.
- Playlist row `<Link to={`/playlist/${playlist.id}`}>`, same shared row className. Icon square:
  `"grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-black/5 dark:bg-white/10"`, icon
  `<ListMusic size={24} className="opacity-80" />`. Text block has `min-w-0`; title
  `"truncate text-[15px] leading-snug"` (`{playlist.name}`); subtitle
  `"mt-0.5 text-[13px] leading-snug text-[#b3b3b3]"` = `Playlist • {playlist.songsCount} tracks`
  (note the `•` bullet and word "tracks").
- Empty (signed in, no playlists) block: `<div className="px-3 pb-2 pt-4">` containing the same
  uppercase "Playlists" header and `<div className="mt-2 text-sm opacity-70">{error ?? "You don’t have any playlists yet."}</div>`. **Note `error` is shown in this slot when present** (so a fetch error surfaces as the playlists-section message, not a top-level error screen).
- Signed-out block: `<div className="px-3 py-6 text-sm opacity-70">` with
  `<Link className="text-emerald-500 underline" to="/signin">Sign in</Link> to view your playlists.`
  (The literal string after the link is " to view your playlists.")

## 2.5 Skeleton — `PlaylistSkeletonRows()`
Renders 3 placeholder rows (`[0,1,2].map`). Container `"space-y-2 px-3 py-2"` `aria-hidden`.
Each: `"flex min-h-[64px] items-center gap-3 rounded-xl"` with a square
`"wf-skeleton h-14 w-14 shrink-0 rounded-lg"` and two bars
`"wf-skeleton h-4 w-44 max-w-full rounded-full"` / `"wf-skeleton h-3 w-24 rounded-full"`.
`wf-skeleton` is a shimmer class defined in global CSS — **PORTING NOTE: reproduce the shimmer with a
RN skeleton lib or a reanimated gradient.**

## 2.6 Page shell
```html
<div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
  <div className="mx-auto max-w-7xl">
    <h1 className="mb-5 text-2xl font-bold">Your Library</h1>
    <div className="space-y-2"> ...rows... </div>
```
(Note: uses `100dvh` here vs `100vh` on Home — `dvh` is web-only; in RN use the safe-area-aware
screen height.)

## 2.7 Dark/light theming
Library uses `dark:` variants (`dark:active:bg-white/5`, `dark:bg-white/10`) and theme tokens
`bg-background`, `text-foreground`-adjacent grays (`#b3b3b3`). The app is effectively dark; if RN port
is dark-only, collapse the `dark:` pairs to the dark value.

---

# 3. SearchPage — `src/client/pages/SearchPage.tsx`

Default export `SearchPage()`. Thin wrapper: fetches the search index then renders `<MobileSearch>`.

## 3.1 Data source
```ts
const { data, loading, error } = useApiData<SearchIndexPayload>(
  withAccountScope("/api/search-index", user?.id ?? status),
  { songs: [] },
  { enabled: status !== "loading", keepPreviousData: true },
);
const songs = data.songs;  // PlayerSong[]
```
`SearchIndexPayload = { songs: PlayerSong[] }`. The full song catalog is loaded once; **search is
100% client-side** (no per-keystroke server query).

## 3.2 States (verbatim)
- Loading (`loading || status === "loading"`):
  ```html
  <div className="px-4 py-6 max-w-7xl mx-auto">
    <div className="mb-5 text-2xl font-semibold">Search</div>
    <div className="space-y-3" aria-hidden>
      <div className="wf-skeleton h-12 rounded-full" />   <!-- fake search bar -->
      {[0,1,2,3].map(...)}  <!-- 4 skeleton rows -->
    </div>
  </div>
  ```
  Each skeleton row: `"flex min-h-[64px] items-center gap-4 rounded-xl"`, square
  `"wf-skeleton h-14 w-14 shrink-0 rounded-lg"`, bars `"wf-skeleton h-4 w-48 max-w-full rounded-full"`
  / `"wf-skeleton h-3 w-28 rounded-full"`.
- Error: `<div className="px-4 py-6 max-w-7xl mx-auto text-red-500">{error}</div>`.
- Otherwise: `<><MobileSearch songs={songs} /></>`.

---

# 4. MobileSearch — `src/components/MobileSearch.tsx`

`"use client"` directive (Next-style; **strip in RN**). Default export `MobileSearch({ songs })`.
Props: `{ songs: PlayerSong[] }`.

## 4.1 State & stores
```ts
const [query, setQuery] = useState("");
const setQueue = usePlayerStore((s) => s.setQueue);
const offlineRecords = useOfflineStore((s) => s.records);
```

## 4.2 Search logic (client-side full-text)
```ts
const dedupedSongs = useMemo(() => dedupeSongsByTitleArtist(songs), [songs]);

const results = useMemo(() => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return dedupedSongs
    .filter((song) => {
      const title = song.title.toLowerCase();
      const artist = song.artist.toLowerCase();
      return title.includes(q) || artist.includes(q);
    })
    .slice(0, 50);   // hard cap of 50 results
}, [dedupedSongs, query]);

const resolvedResults = useMemo(
  () => results.map((song) => resolveOfflinePlaybackSong(song)),
  [offlineRecords, results],
);
```
- Dedup by title+artist via `dedupeSongsByTitleArtist` (`src/lib/song-dedupe`) before filtering.
- **Matching is a simple case-insensitive substring `includes` on title OR artist** — it does NOT use
  the `search-scoring.ts` weighted scorer (that lib is for backend provider ranking; see §5). No
  album match here, no ranking/sort — results keep `dedupedSongs` order, capped at 50.
- `resolveOfflinePlaybackSong` swaps in local file paths for downloaded songs (offline records dep).

## 4.3 Tap-to-play (no toggle)
```ts
onClick={() => {
  const queueIndex = songs.findIndex((item) => item.id === song.id);
  if (queueIndex >= 0) {
    requestImmediatePlayback(song);
    setQueue(songs, queueIndex);  // queue = the FULL original songs array, starting at this index
  }
}}
```
Note: the queue is the **full unfiltered `songs` prop**, with the start index found by `id` in that
array (not the filtered/resolved list). There is no active/toggle state here — tapping always
(re)starts playback of that song within the full catalog queue.

## 4.4 Layout & verbatim classNames
Shell: `<div className="px-4 py-6 max-w-7xl mx-auto">`.
Heading: `<h1 className="text-2xl font-bold mb-5">Search</h1>`.
Search input wrapper: `<div className="relative mb-6">`.
Search icon (`lucide-react` `Search`): `size={18}`,
`className="absolute left-4 top-1/2 -translate-y-1/2 text-foreground/50 pointer-events-none"`.
Input:
```html
<input type="search" aria-label="Search songs" value={query}
  onChange={(e) => setQuery(e.target.value)}
  placeholder="What do you want to play?"
  autoComplete="off" autoCorrect="off" spellCheck={false}
  className="w-full h-12 pl-11 pr-4 rounded-full border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 text-base outline-none transition focus:ring-2 focus:ring-emerald-500/40" />
```
(In RN: `<TextInput>`; `type="search"`, `autoCorrect`, `spellCheck`, `focus:ring` have RN equivalents
— `autoCorrect={false}`, `spellCheck={false}`, custom focus border.)

Results container: `<div className="space-y-1">`.

States inside results:
- Empty query (`query.trim().length === 0`):
  `<div className="py-12 text-center text-sm opacity-70">Start typing to search songs</div>`.
- No matches (`resolvedResults.length === 0`):
  `<div className="py-12 text-center text-sm opacity-70">No songs found</div>`.
- Otherwise map each `song` to a result button:
  ```html
  <button type="button" onClick={...}
    className="wf-list-row wf-pressable w-full min-h-[56px] px-2 rounded-xl flex items-center gap-3 text-left active:bg-black/5 dark:active:bg-white/5 touch-manipulation">
    <div className="relative h-12 w-12 rounded-md overflow-hidden shrink-0">
      <CoverImage src={song.imageUrl} alt={song.title} className="wf-song-cover h-full w-full object-cover" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium truncate">{song.title}</div>
      <div className="text-xs opacity-70 truncate">{song.artist}</div>
    </div>
  </button>
  ```

---

# 5. search-scoring lib — `src/lib/search-scoring.ts`

**Scope note:** this module is shared text-match scoring for the **backend** qobuz/tidal
search-candidate rankers — it is NOT used by the client `MobileSearch` (which uses plain `includes`).
Document here because the task referenced it; the implementer should know it does NOT govern the UI
search behavior.

Imports `normalizeSearchValue` from `./provider-http`.

Exports:
```ts
function scoreField(needleRaw, haystackRaw, exactScore, partialScore, requireHaystack): number
  // normalizes both via normalizeSearchValue
  // exact match (haystack === needle) -> exactScore
  // else if needle present and (!requireHaystack || haystack) and (haystack.includes(needle) || needle.includes(haystack)) -> partialScore
  // else 0

export function scoreTitleArtistAlbum(
  needles:   { title: string; artist: string; album: string },
  haystacks: { title: string; artist: string; album: string },
): number
```
Weights (exact / substring):
- title:  1000 / 500   (`requireHaystack = false`)
- artist:  300 / 180   (`requireHaystack = true`)
- album:   150 /  90   (`requireHaystack = true`)
`scoreTitleArtistAlbum` returns the sum of the three field scores. Per-provider quality bonus and
field extraction live in each provider, not here. Pure function — ports as-is if the backend logic is
ever moved client-side, but **not needed for the UI port**.

---

# 6. Consolidated PORTING HAZARDS (this slice)

1. **Relative `fetch` URLs + cookie auth.** `/api/...` paths and `credentials:"include"` (Discover
   stage POST) and the whole `useApiData`/`fetchApiData` layer assume same-origin browser fetch.
   In RN every call needs an absolute base URL to the self-hosted Worker, and cookie auth must be
   replaced with an explicit token/cookie header. Keep the `?auth=<scope>` query param
   (`withAccountScope`).
2. **Web-only data/runtime primitives.** `window`/`"online"` reconnect listener (use NetInfo);
   IndexedDB offline API snapshots and Capacitor-Filesystem local file paths (use expo-file-system +
   AsyncStorage/MMKV); `localStorage` for local-only likes in the likes store; `100dvh`/`100vh`/
   `calc(... - 3.5rem)` heights; `react-router-dom` `<Link>` (use React Navigation / Expo Router).
3. **Hover / pointer interactions don't exist on touch.** Floating play buttons are `opacity-0
   group-hover:opacity-100` and warm-up fires on `onPointerEnter`/`onFocus`. On RN show the play
   control based on `active` state (not hover) and drop hover-warm. Also `lucide-react` →
   `lucide-react-native`, `wf-skeleton`/`animate-spin` shimmer/spin → reanimated, and the likes-store
   seeding `useEffect` on Home (`mergeInitial(homeData.likedSongIds)`) must be replicated or the
   like/heart buttons stay disabled.
