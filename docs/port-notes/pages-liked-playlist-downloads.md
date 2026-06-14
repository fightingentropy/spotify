# Port Notes — Liked / Playlist / Downloads pages

Reconstruction-grade reference for porting three list pages (and the shared `SongGrid`
stack they all render) from the Vite + React 19 + Tailwind v4 + Zustand web app to
Expo / React Native + NativeWind.

Source files covered:
- `src/client/pages/LikedPage.tsx`
- `src/client/pages/PlaylistPage.tsx`
- `src/client/pages/DownloadedPage.tsx`
- Shared: `src/components/SongGrid.tsx`, `src/components/SongCard.tsx`,
  `src/components/SongListItem.tsx`, `src/components/TrackActionsMenu.tsx`,
  `src/components/OfflineDownloadButton.tsx`
- Supporting logic: `src/client/api.ts`, `src/store/likes.ts`, `src/client/offline.ts`,
  `src/client/auth.tsx`, `src/types/player.ts`

> All `className` strings below are quoted **verbatim**. Tailwind v4 is in use; custom
> classes prefixed `wf-` (e.g. `wf-skeleton`, `wf-control-button`, `wf-song-card`,
> `wf-pressable`, `wf-list-row`, `wf-main`, `wf-song-cover`) are defined in global CSS,
> not utilities — they have no NativeWind equivalent and must be reimplemented (see
> PORTING HAZARDS).

---

## 0. Shared data type: `PlayerSong` (`src/types/player.ts`)

```ts
export type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
  networkImageUrl?: string;   // remote-cover fallback when imageUrl is a device-local file
  audioUrl: string;
  lyricsUrl?: string;
  description?: string;
  link?: string;
  createdAt?: string;         // ISO string; used by SongGrid sort
  duration?: number;
  audioBitDepth?: number;
  audioSampleRate?: number;
  source?: "server" | "browser-local" | "picked-file" | "radio" | "podcast" | "offline";
  localPath?: string;
  writable?: boolean;
  staged?: boolean;           // Discover staging track, not in library
  discoverTrackId?: string;   // Spotify id for promote-to-library
};
```

---

## 1. Data sources & fetch layer (`src/client/api.ts`)

All three pages fetch through the `useApiData<T>(url, initialValue, options?)` hook.

### `useApiData` signature & behavior
```ts
useApiData<T>(
  url: string,
  initialValue: T,
  options?: { enabled?: boolean; keepPreviousData?: boolean; refreshOnReconnect?: boolean },
): { data: T; loading: boolean; error: string | null }
```
- Returns `{ data, loading, error }`. `error` is a **plain string** (no status code).
- In-memory `Map` cache keyed by full URL (incl. `?auth=` scope). Also persists a subset
  of paths to IndexedDB via `offline-api-snapshots` (the "persistable" set includes
  `/api/liked`, `/api/likes`, `/api/playlist/...`).
- Cold load shows `loading=true`; `keepPreviousData:true` keeps the prior `data` on URL
  change (used to avoid flicker on account switch) but does NOT mask errors on a cold load.
- Sends request with: `credentials: "include"`, `cache: "no-cache"`, header
  `accept: application/json`, conditional `if-none-match` (etag), and
  `x-spotify-api-refresh: 1` when online. Honors `etag`/`304`.
- 5s fetch timeout (`API_FETCH_TIMEOUT_MS`). On `401` dispatches a `window` CustomEvent
  `spotify:api-auth-required` (consumed by `auth.tsx` to force sign-out).
- Offline: reads from SW cache / IDB snapshot; on miss returns a human "not cached yet"
  message.

### `withAccountScope(url, scope)` — REQUIRED wrapper on every page fetch
```ts
withAccountScope(url: string, scope: string | null | undefined): string
```
Appends `?auth=<scope>` to the URL (scope = `user.id` when authed, else the auth `status`
string, defaulting to `"anonymous"`). This is how the cache is partitioned per account.
Every page passes `user?.id ?? status` as the scope.

### Payload shapes returned by the endpoints
```ts
export type LikedPayload = {                  // GET /api/liked  AND  GET /api/likes
  songs: PlayerSong[];
  likedSongIds: string[];
};

export type PlaylistPayload = {               // GET /api/playlist/:id
  playlist: {
    id: string;
    name: string;
    imageUrl: string | null;
    userId: string;
    createdAt: string;
  } | null;
  songs: PlayerSong[];
  likedSongIds: string[];
};
```
- `/api/liked` (authed) returns full `songs[]` + `likedSongIds[]`.
- `/api/likes` (anonymous fallback) returns the lighter shape; `LikedPage` also tolerates
  a legacy `likes?: string[]` field and coerces it to `likedSongIds`.

---

## 2. LikedPage (`src/client/pages/LikedPage.tsx`)

### Data source
```ts
const { user, status, refresh } = useAuth();
const authSettled = status !== "loading";
const { data, loading, error } = useApiData<LikedPayload>(
  withAccountScope(user ? "/api/liked" : "/api/likes", user?.id ?? status),
  { songs: [], likedSongIds: [] },
  { enabled: authSettled, keepPreviousData: true },
);
```
- Endpoint switches between `/api/liked` (signed-in) and `/api/likes` (signed-out).
- `enabled` waits until auth is no longer `"loading"`.
- `isAuthError = !!error && (/\b401\b/.test(error) || /unauthor/i.test(error))` — detects
  auth failures from the error string; on true, `useEffect` calls `refresh()`.
- Derives `songs` (guards non-array), `likedSongIds` (falls back to legacy `likes`).

### Layout / classNames (verbatim)

`SongGridSkeleton` (local component, 8 placeholder cards):
- container: `"grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"` `aria-hidden`
- each item wrapper: `"space-y-3"`
- art block: `"wf-skeleton aspect-square rounded-lg"`
- line 1: `"wf-skeleton h-4 rounded-full"`
- line 2: `"wf-skeleton h-3 w-2/3 rounded-full"`

Page states (all share the page shell):
- Page shell `<div>`: `"min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6"`
  → inner `<div>`: `"mx-auto max-w-7xl"`

States:
1. **Not auth-settled** (`status === "loading"`): shell + `<h1 className="mb-6 text-2xl font-semibold">Liked Songs</h1>` + `<SongGridSkeleton />`.
2. **Signed-out / auth error** (`!user || isAuthError`): shell + same `<h1 className="mb-6 text-2xl font-semibold">` + `<div className="opacity-70">` containing `<Link className="underline" to="/signin">Sign in</Link> to view and manage your liked songs.`
3. **Loaded**: shell, `<h1 className="mb-4 text-2xl font-semibold leading-tight sm:mb-6">Liked Songs</h1>`, then:
   - if `loading && songs.length === 0` → `<SongGridSkeleton />`
   - else if `error` → `<div className="text-red-500">{error}</div>`
   - else if `songs.length === 0` → `<div className="opacity-70">You haven&apos;t liked any songs yet.</div>`
   - else → `<SongGrid ... />`

### SongGrid usage (Liked)
```tsx
<SongGrid
  songs={songs}
  likedSongIds={likedSongIds}
  hideIfUnliked            // KEY: rows auto-vanish on unlike
  canLike                  // always true here
  bulkDownloadScope="liked"
  emptyLabel="You haven't liked any songs yet."
  viewToggleClassName="mb-8 sm:-mt-14"
/>
```
- `hideIfUnliked` → SongGrid filters out songs whose like flag is false (live, against the
  likes store) → **unlike auto-removes the row** without a refetch.
- `bulkDownloadScope="liked"` → renders one "download all" icon button in the header and
  HIDES per-card download buttons (`showRowDownload = !bulkDownloadScope`).

---

## 3. PlaylistPage (`src/client/pages/PlaylistPage.tsx`)

### Data source
```ts
const { id = "" } = useParams();              // react-router route param
const { user, status } = useAuth();
const { data, loading, error } = useApiData<PlaylistPayload>(
  withAccountScope(`/api/playlist/${encodeURIComponent(id)}`, user?.id ?? status),
  { playlist: null, songs: [], likedSongIds: [] },
  { enabled: status !== "loading", keepPreviousData: true },
);
```

### Layout / classNames (verbatim)

`PlaylistLoadingSkeleton` (local, 6 cards):
- root: `"px-6 py-8 max-w-7xl mx-auto"`
- header block: `"mb-8 space-y-3"` containing
  - `"wf-skeleton h-7 w-56 max-w-full rounded-full"` (title)
  - `"wf-skeleton h-4 w-24 rounded-full"` (count)
- grid: `"grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"` `aria-hidden`
  - each: wrapper `"space-y-3"`, art `"wf-skeleton aspect-square rounded-lg"`,
    line1 `"wf-skeleton h-4 rounded-full"`, line2 `"wf-skeleton h-3 w-2/3 rounded-full"`

States (early returns):
1. `loading || status === "loading"` → `<PlaylistLoadingSkeleton />`
2. `error` → `<div className="px-6 py-8 max-w-7xl mx-auto text-red-500">{error}</div>`
3. `!data.playlist` → `<div className="px-6 py-8 max-w-7xl mx-auto opacity-70">Playlist not found.</div>`

### Loaded layout (the playlist header)
- root: `"px-6 py-8 max-w-7xl mx-auto"`
- header row: `"mb-4 flex flex-col items-start gap-3 sm:mb-6 sm:flex-row sm:justify-between"`
  - left text block: `"min-w-0"`
    - **name**: `<h1 className="truncate text-2xl font-semibold">{data.playlist.name}</h1>`
    - **track count**: `<div className="mt-1 text-sm opacity-70">{data.songs.length} tracks</div>`
  - **Download playlist** button (only when `data.songs.length > 0`):
    ```tsx
    <OfflineBulkDownloadButton
      songs={data.songs}
      scope={`playlist:${data.playlist.id}`}
      label="Download playlist"
      className="w-full justify-center sm:w-auto"
    />
    ```
- Body:
  - if `data.songs.length === 0` → `<div className="opacity-70">This playlist is empty.</div>`
  - else → `<SongGrid songs={data.songs} likedSongIds={data.likedSongIds} canLike={!!user} viewToggleClassName="mb-8 sm:-mt-14" />`

### View-only (NO reorder UI)
PlaylistPage renders the plain `SongGrid` with **no drag/reorder affordance**. The data
layer *supports* reorder (`OfflineMutation` type `"playlist-reorder"` exists in
`offline.ts`), but this page never exposes it. The port should treat the playlist as a
read-only list. `bulkDownloadScope` is NOT passed here, so per-card download buttons remain
visible on playlist rows/cards (unlike Liked, where the bulk scope hides them).

---

## 4. DownloadedPage (`src/client/pages/DownloadedPage.tsx`)

This page does **not** fetch the song list from an API — it reads downloaded records
straight from IndexedDB via the offline store, with manual pagination + an IntersectionObserver.

### Data sources
```ts
const { user, status } = useAuth();
const hydrate  = useOfflineStore((s) => s.hydrate);
const hydrated = useOfflineStore((s) => s.hydrated);
// Liked ids ONLY (for the heart state on each row); songs come from IDB:
const { data } = useApiData<LikedPayload>(
  withAccountScope(user ? "/api/liked" : "/api/likes", user?.id ?? status),
  { songs: [], likedSongIds: [] },
);
```
Local state:
```ts
const [downloadRecords, setDownloadRecords] = useState<OfflineDownloadRecord[]>([]);
const [totalDownloads, setTotalDownloads]   = useState(0);
const [loadingInitial, setLoadingInitial]   = useState(true);
const [loadingMore, setLoadingMore]         = useState(false);
const [loadError, setLoadError]             = useState<string | null>(null);
const sentinelRef       = useRef<HTMLDivElement>(null);
const loadingRef        = useRef(false);
const loadGenerationRef = useRef(0);   // bumped on account switch to discard stale loads
const recordsRef        = useRef<OfflineDownloadRecord[]>([]);
const DOWNLOADS_PAGE_SIZE = 80;
```

### Pagination logic (`loadDownloads(reset?)`)
- Reads a page: `readDownloadedRecordsPage({ offset, limit: 80 })` where
  `offset = reset ? 0 : recordsRef.current.length`.
- `mergeOfflineDownloadRecords(page.records)` pushes the page into the offline store's
  in-memory map.
- `setTotalDownloads(page.total)`.
- **Dedup by `songId`** when appending: builds a `Set`, filters out already-seen
  `record.songId`, stores deduped array in both state and `recordsRef`.
- **Generation guard**: captures `loadGenerationRef.current` at start; after the `await`,
  bails (`return`) if it changed → an account switch can't append the previous account's page.
- `reset` loads always run even while a load-more is in flight; non-reset loads early-return
  if `loadingRef.current`.

Effects:
- On mount: `void hydrate()`.
- On `[hydrated, loadDownloads, user?.id, status]`: bump generation, clear records/total,
  `loadDownloads(true)` (account switch reset).
- IntersectionObserver on `sentinelRef` with `{ rootMargin: "900px 0px" }`: when the
  sentinel intersects and `recordsRef.current.length < totalDownloads`, calls
  `loadDownloads(false)`. Guarded by `typeof IntersectionObserver === "undefined"`.

Derived:
```ts
const downloadedSongs = downloadRecords.map(resolveOfflineDownloadRecordSong); // useMemo
const hasMore = downloadedSongs.length < totalDownloads;
```
`resolveOfflineDownloadRecordSong(record)` rewrites the song to point at the offline asset
URLs (native file URL or cached URL) — see §8.

### Layout / classNames (verbatim)

`DownloadSkeletonRows` (4 rows):
- root: `"space-y-2"` `aria-hidden`
- each row: `"flex min-h-[64px] items-center gap-4 rounded-xl px-3"`
  - thumb: `"wf-skeleton h-14 w-14 shrink-0 rounded-lg"`
  - text col: `"min-w-0 flex-1 space-y-2"`
    - `"wf-skeleton h-4 w-48 max-w-full rounded-full"`
    - `"wf-skeleton h-3 w-28 rounded-full"`

Page:
- shell: `"min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6"`
  - inner: `"mx-auto max-w-7xl"`
  - **header** `"mb-6 flex items-center gap-3"`:
    - icon badge: `"grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300"` containing `<Download size={23} />` (lucide)
    - text block `"min-w-0"`:
      - `<h1 className="text-2xl font-semibold">Downloads</h1>`
      - count: `<div className="mt-1 text-sm text-white/[0.62]">{totalDownloads} {totalDownloads === 1 ? "song" : "songs"}</div>`
  - Body states:
    - `!hydrated || loadingInitial` → `<DownloadSkeletonRows />`
    - `downloadedSongs.length === 0` → `<div className="opacity-70">{loadError ?? "Downloaded songs will show up here."}</div>`
    - else → `<SongGrid>` (see below) **followed by the infinite-scroll sentinel**:
      ```tsx
      <SongGrid
        songs={downloadedSongs}
        likedSongIds={data.likedSongIds}
        canLike={!!user}
        emptyLabel="Downloaded songs will show up here."
        viewToggleClassName="mb-8 sm:-mt-14"
      />
      <div ref={sentinelRef} className="flex min-h-16 items-center justify-center py-6 text-sm text-white/[0.62]">
        {loadingMore ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 size={16} className="animate-spin" /> Loading more
          </span>
        ) : hasMore ? (
          <button type="button" onClick={() => void loadDownloads(false)}
            className="rounded-full border border-white/15 px-4 py-2 font-medium text-white/[0.78] transition hover:bg-white/[0.08] hover:text-white">
            Load more
          </button>
        ) : loadError ? loadError : null}
      </div>
      ```
- Note: DownloadedPage does NOT pass `bulkDownloadScope`, so per-card download buttons
  ARE shown (each acts as "remove download" since they're already downloaded).

---

## 5. SongGrid (`src/components/SongGrid.tsx`) — the shared core

### Props
```ts
type SongGridProps = {
  songs: PlayerSong[];
  likedSongIds?: string[];          // default []
  hideIfUnliked?: boolean;          // default false (Liked passes true)
  canLike?: boolean;                // default false
  showLikeControls?: boolean;       // default true
  showQueueButton?: boolean;        // default true (controls per-row "add to queue")
  bulkDownloadScope?: DownloadScope;// "home" | "liked" | `playlist:${id}` | `song:${id}`
  emptyLabel?: string;
  viewToggleClassName?: string;
};
```
`showRowDownload = !bulkDownloadScope` — when a bulk scope is set, per-card/row download
buttons are hidden and a single header download button is shown.

### Stores consumed
- `usePlayerStore`: `setQueue`, `currentSong`, `isPlaying`, `play`, `pause`, `shuffle`,
  `toggleShuffle`.
- `useLikesStore`: `mergeInitial`, `toggleLike`, `likedSongIds` (lookup map), `pending`,
  `hydrated`.

### View mode + sort (persisted to localStorage)
- `viewMode: "grid" | "list"` ← `localStorage["spotify_song_view_mode"]`
- `sortMode: "default" | "uploaded_desc" | "uploaded_asc"` ← `localStorage["spotify_song_sort_mode"]`
- `preferencesReady` gates initial render with `opacity-0` until localStorage is read
  (avoids a flash of default mode).
- Setters `setNextViewMode` / `setNextSortMode` write back to localStorage.

### Likes hydration & visibility
- On change of `likedSongIds` prop (compared with `haveSameIds`), calls
  `mergeInitial(likedSongIds)` once.
- `likedMap = hydrated ? likedLookup(store) : initialLookup(props)`.
- `sortedDedupedSongs`: optional sort by `Date.parse(createdAt)` (newest/oldest), then
  dedup by `song.id`.
- `visibleSongs = hideIfUnliked ? sortedDedupedSongs.filter(s => likedMap[s.id]) : sortedDedupedSongs`.
  → **This filter is what makes unlike auto-remove a row in Liked.**

### Virtualization (PORTING HAZARD — replace with FlatList)
Custom DOM virtualization kicks in at `VIRTUALIZATION_MIN_ITEMS = 80`:
- Grid: measures `window.getComputedStyle` of the grid container, parses
  `gridTemplateColumns` / gaps, computes row height from `.wf-song-card` rect, renders only
  a window of cards positioned absolutely. Uses `requestAnimationFrame`, `ResizeObserver`,
  and scrolls relative to the nearest `.wf-main` scroll container.
- List: fixed `VIRTUAL_ROW_HEIGHT = 72`, overscan 8 rows, same `.wf-main` scroll math.
- **In RN this entire mechanism should be discarded** and replaced with `FlatList` /
  `FlashList` (numColumns for grid, single column for list). None of the
  `getBoundingClientRect`/`getComputedStyle`/`window.scroll` code translates.

### Header toolbar (verbatim classNames)
Wrapper: `cn("mb-3 flex w-full items-center gap-2", viewToggleClassName)`
Inner: `"ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none"`

1. **Play/Pause whole list** button:
   `"wf-control-button grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#1ed760] text-black shadow-[0_8px_18px_rgba(0,0,0,0.22)] transition hover:bg-[#1fdf64] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#1ed760]"`
   - icon: `listIsPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="translate-x-0.5" />`
   - `listIsPlaying = (currentSong is in visibleSongs) && isPlaying`.
   - `onClick = handlePlayVisibleSongs`: if current song is in list → toggle play/pause;
     else `setQueue(songs, 0, { respectShuffle: true })` and `requestImmediatePlayback(...)`.
2. **Shuffle** toggle button:
   base `"relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-black/10 bg-black/5 text-foreground/70 transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:text-white"`
   + `"wf-control-button"` + (when on) `"text-[#1ed760] dark:text-[#1ed760]"`.
   - icon `<Shuffle size={19} />` + an active dot `span` `cn("absolute bottom-1 h-1 w-1 rounded-full bg-[#1ed760] transition-opacity", shuffle ? "opacity-100" : "opacity-0")`.
3. **Bulk download** (only if `bulkDownloadScope`): `<OfflineBulkDownloadButton songs={visibleSongs} scope={bulkDownloadScope} iconOnly className="wf-control-button h-10 w-10" />`.
4. **Sort `<select>`**: `"h-10 min-w-0 flex-1 rounded-lg border border-black/10 bg-black/5 px-3 text-sm dark:border-white/10 dark:bg-white/5 sm:w-64 sm:flex-none"`
   options: `Sort: Default` / `Sort: Upload date (newest)` / `Sort: Upload date (oldest)`.
5. **Grid/List toggle** container: `"inline-flex h-10 shrink-0 items-center rounded-lg border border-black/10 bg-black/5 p-1 dark:border-white/10 dark:bg-white/5"`
   - each button: `cn("inline-flex h-8 w-9 items-center justify-center gap-2 rounded-md text-sm transition sm:w-auto sm:px-3", "wf-control-button", active && "bg-black/10 font-medium dark:bg-white/10")`
   - grid: `<LayoutGrid size={16} /> <span className="hidden sm:inline">Grid</span>`
   - list: `<Rows3 size={16} /> <span className="hidden sm:inline">List</span>`

### Grid container classNames
- Non-virtual grid: `"grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4"`
- Virtual grid measure layer: `"absolute left-0 right-0 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4"`
- List (non-virtual): `"space-y-2"`.

### Like handler (shared by cards & rows)
```ts
handleToggleLike(songId, nextLiked):
  if (!canLike) navigate("/signin"); return;
  result = await toggleLike(songId, nextLiked, song)
  if (!result.ok && result.status === 401) navigate("/signin");
```
Empty state: if `visibleSongs.length === 0` and `hideIfUnliked && emptyLabel` →
`<div className="opacity-70">{emptyLabel}</div>`, else renders `null`.

---

## 6. SongCard (`src/components/SongCard.tsx`) — grid card (per-card play + heart + download)

Memoized; resolves offline playback song via `resolveOfflinePlaybackSong(song)`.
Subscribes to `currentSong?.id === song.id` (`isActive`) and `... && isPlaying`.

Structure & classNames (verbatim):
- root `<div onPointerEnter={warmPlaybackSong}>`:
  `cn("wf-song-card wf-pressable group relative aspect-square rounded-lg overflow-hidden bg-black/5 dark:bg-white/5", isActive && "ring-2 ring-emerald-500")`
- full-bleed play button (`absolute inset-0`):
  `"absolute inset-0 z-10 rounded-lg cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"`,
  `aria-label` toggles Pause/Play, `onClick=handlePlay`.
- `<CoverImage>` (`fill`, sizes, `wf-song-cover object-cover`, `priority` for first 6).
- gradient overlay: `"absolute inset-0 bg-gradient-to-t from-black/60 to-transparent"`.
- **per-card download** (only if `showDownload`): `<OfflineSongDownloadButton>` with
  `"wf-control-button absolute left-2 top-2 z-30 bg-black/40 text-white/90 backdrop-blur hover:bg-black/60"`.
- **per-card overflow / heart**: `<TrackActionsButton>` at
  `"absolute right-2 top-2 z-30 h-9 w-9 text-white/90 bg-black/40 backdrop-blur hover:bg-black/60"`
  (the 3-dots menu — heart lives inside the sheet, see §7).
- bottom info bar `"pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex items-end justify-between gap-2"`:
  - title `"text-white font-medium drop-shadow truncate"`, artist `"text-white/80 text-xs drop-shadow truncate"`.
  - play badge: outer `cn("transition-opacity shrink-0", isActive ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100")`, inner `"wf-control-button h-10 w-10 rounded-full bg-emerald-500 text-white grid place-items-center"` with `<Pause/Play size={18}>`.

`handlePlay`: if active → toggle pause/resume (with `requestImmediatePlayback`); else if
`onPlayAt` provided → `requestImmediatePlayback(resolvedSong); onPlayAt(songIndex)`; else
`setSong(song); play()`.

---

## 7. SongListItem (`src/components/SongListItem.tsx`) — list row

Same data wiring as SongCard. classNames (verbatim):
- root `<div onPointerEnter={warmPlaybackSong}>`:
  `cn("wf-list-row group flex items-center gap-3 px-3 py-2", isActive ? "bg-emerald-500/10 rounded-lg" : "hover:bg-black/5 hover:dark:bg-white/5 rounded-lg")`
- play button (fills row): `"wf-pressable flex min-w-0 flex-1 items-center gap-3 rounded-md bg-transparent text-left focus:outline-none"`
  - thumb wrapper `"relative h-12 w-12 shrink-0 overflow-hidden rounded"` + `<CoverImage fill sizes="48px" className="wf-song-cover object-cover" />`
  - text col `"min-w-0 flex-1"`: title `cn("block truncate text-sm font-medium", isActive && "text-emerald-500")`, artist `"block truncate text-xs opacity-70"`.
- per-row download (if `showDownload`): `<OfflineSongDownloadButton className="wf-control-button text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10" />`.
- now-playing badge (only when `isActive`): `"pointer-events-none wf-control-button h-9 w-9 rounded-full bg-emerald-500 text-white grid place-items-center shrink-0"`.
- overflow/heart: `<TrackActionsButton className="h-9 w-9 text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10" />`.

---

## 8. TrackActionsButton / Sheet (`src/components/TrackActionsMenu.tsx`) — the heart + queue actions

The per-row/per-card "heart" is no longer an inline button — it lives inside a bottom-sheet
opened by a 3-dots (`MoreHorizontal`) trigger (per the recent commit "move per-row actions
into a 3-dots overflow menu").

### Trigger `TrackActionsButton`
Props: `{ song, liked?, likePending?, canLike?, onToggleLike?, showQueue?=true, showLike?=true, className?, iconSize?=18 }`.
- `hasLikeAction = showLike && !!onToggleLike`; `hasQueueActions = showQueue`.
- Returns `null` if neither action available (no dead trigger).
- Button: `cn("wf-control-button grid shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500", className)`, `<MoreHorizontal size={iconSize} />`, `aria-haspopup="dialog"`.
- `onClick`: `impactLight()` (haptics) + `setOpen(true)`.

### Sheet `TrackActionsSheet` (rendered via `createPortal` to `document.body`)
- Animated bottom sheet: mounts `translate-y-full`, flips to `translate-y-0` on next RAF;
  `SHEET_TRANSITION_MS = 260`. Swipe-down (touch delta > 60px) or backdrop tap closes.
- Escape key closes; locks body scroll via `document.body.classList` (`wf-now-playing-open`).
- Backdrop button: `cn("absolute inset-0 bg-black/60 transition-opacity duration-300", visible ? "opacity-100" : "opacity-0")`.
- Panel `<section>`: `cn("absolute inset-x-0 bottom-0 mx-auto w-full max-w-md", "rounded-t-3xl border-t border-white/10 bg-background text-white", "shadow-[0_-16px_50px_rgba(0,0,0,0.55)] outline-none", "pb-[calc(env(safe-area-inset-bottom)+0.5rem)]", "transition-transform duration-[260ms] ease-out will-change-transform motion-reduce:transition-none", visible ? "translate-y-0" : "translate-y-full")`.
- grab handle: `"mx-auto mt-2.5 h-1 w-9 rounded-full bg-white/25"`.
- header (cover + title/artist): row `"flex items-center gap-3 px-5 pb-4 pt-3"`; divider `"mx-5 border-t border-white/10"`.
- actions container `"px-2 py-2"`:
  - if `showQueue`: **Play next** (`<ListStart size={20} />` → `playNext(song)`) and
    **Add to queue** (`<ListEnd size={20} />` → `addToQueue(song)`).
  - if `showLike && onToggleLike`: **heart row** —
    icon `<Heart size={20} className={cn(liked ? "fill-emerald-500 text-emerald-500" : undefined)} />`,
    label = `!canLike ? "Save to Liked Songs" : liked ? "Remove from Liked Songs" : "Save to Liked Songs"`,
    `disabled={likePending}`, `onClick` → `onToggleLike(song.id, !liked)`.
- `ActionRow` className: `cn("flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left text-[15px] font-medium text-white/90", "transition hover:bg-white/10 active:bg-white/10 focus:outline-none focus-visible:bg-white/10", "touch-manipulation disabled:cursor-wait disabled:opacity-60")` — icon span `"grid h-6 w-6 shrink-0 place-items-center text-white/70"`, label span `"min-w-0 truncate"`.

---

## 9. Likes store (`src/store/likes.ts`)

State:
```ts
type LikesState = {
  likedSongIds: Record<string, true>;   // lookup map
  pending: Record<string, true>;        // in-flight toggles
  hydrated: boolean;
  mergeInitial: (ids: string[]) => void;
  resetRemote: () => void;
  toggleLike: (songId, nextLiked, song?) => Promise<{ ok: boolean; status: number; error?: string }>;
};
```
Key behaviors:
- Initializes from `localStorage["spotify_local_liked_song_ids"]` (only local song ids,
  ids starting `browser-local:` / `picked-file:`).
- `mergeInitial`: merges the server-provided ids with local ids, and **preserves in-flight
  optimistic likes** (entries in `pending`).
- `resetRemote()`: called by `auth.tsx` on user-id change — drops all remote likes, keeps
  local ones, clears `pending`.
- `toggleLike` (optimistic):
  1. Rejects if already `pending` or no-op.
  2. `impactLight()` haptics.
  3. Local-only ids: persist to localStorage, return immediately.
  4. Optimistically updates `likedSongIds` + sets `pending`.
  5. If liking a staged Discover track (`song.discoverTrackId`), `promoteStagedSong(song)`
     first (id may change).
  6. Captures `accountScope = getOfflineAccountScope()` BEFORE the await.
  7. `fetch("/api/likes", { method: nextLiked ? "POST" : "DELETE", body: JSON.stringify({ songId }), credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" } })`.
  8. On non-ok: revert, return `{ ok:false, status, error }`.
  9. On ok: clear pending, `patchLikeApiCache(songId, nextLiked, song, accountScope)`
     (mutates the in-memory api cache for `/api/home`, `/api/liked`, `/api/likes`,
     `/api/playlist/*` — this is what makes the Liked row appear/disappear without refetch),
     `syncAutoDownloadLiked(...)`.
  10. On network error: queue an offline mutation (`queueOfflineMutation({ type:"like", payload })`),
      still patch the cache optimistically, return `{ ok:true, status:202 }`. If queueing
      fails too, revert.

`patchLikeApiCache` (api.ts): updates `likedSongIds`/legacy `likes` arrays in cached
payloads; for `/api/liked` also inserts/removes the full song object in `songs[]`
(prepends the song on like, filters it out on unlike) — keeps Liked grid consistent.

---

## 10. Offline store & download helpers (`src/client/offline.ts`)

### Record shape
```ts
type OfflineDownloadRecord = {
  songId: string;
  song: PlayerSong;
  audioUrl: string; imageUrl: string; lyricsUrl?: string;
  nativeFiles?: NativeOfflineFiles;   // capacitor file URLs per asset kind
  accountScope?: string; deviceId?: string;
  status: "queued" | "downloading" | "downloaded" | "failed";
  progress: number; size: number; error?: string;
  pinnedBy: DownloadScope[];          // which scopes pin this song
  createdAt; updatedAt; lastAccessedAt; verifiedAt?;
};
type DownloadScope = "home" | "liked" | `playlist:${string}` | `song:${string}`;
```

### Functions used by these pages (exact signatures)
- `useOfflineStore` (zustand). Relevant actions: `hydrate(): Promise<void>`,
  `queueDownloads(songs: PlayerSong[], scope: DownloadScope): Promise<void>`,
  `removeDownload(songId): Promise<void>`, `removeScope(scope): Promise<void>`,
  `unpinScope(songId, scope): Promise<void>`. State: `hydrated`, `records: Record<songId, record>`.
- `readDownloadedRecordsPage(options?: { scope?; offset?; limit?; direction? }): Promise<OfflineDownloadRecordPage>`
  where `OfflineDownloadRecordPage = { records, total, offset, limit, hasMore }`. Reads
  status=`"downloaded"` records for the current account from IDB via an index cursor;
  default direction `"prev"` (newest first); `limit` clamped 1..500.
- `mergeOfflineDownloadRecords(records: OfflineDownloadRecord[]): void` — merges into the
  in-memory store map (capped at `MAX_DOWNLOAD_RECORDS_IN_MEMORY = 420`).
- `resolveOfflineDownloadRecordSong(record, song?=record.song): PlayerSong` — returns the
  song rewritten to play from offline assets: native file URL (`nativeOfflineAssetWebUrl`)
  when available with `source: "offline"`, else cached durable URL; sets `networkImageUrl`
  fallback.
- `resolveOfflinePlaybackSong(song): PlayerSong` — used by cards/rows to swap in offline
  URLs for the *current account's* downloaded record.
- `getSongDownloadState(record): status | "none"`.
- `getScopeDownloadState(records, songs, scope): status | "partial" | "none"` (in-memory).
- `readScopeDownloadState(songs, scope): Promise<status | "partial" | "none">` (authoritative
  IDB read — used by the bulk button because the in-memory map is capped).

### IndexedDB: `spotify_offline_v1` v3
Stores: `downloads_v2` (keyPath `["accountScope","songId"]`, indexes
`accountScope_updatedAt`, `accountScope_status_updatedAt`), `api_snapshots` (keyPath `url`),
`mutations` (keyPath `id`). Legacy `downloads` migrated on open. Account scoping via
`normalizeOfflineAccountScope` (defaults `"anonymous"`; `"loading"` → `"anonymous"`).

---

## 11. OfflineDownloadButton (`src/components/OfflineDownloadButton.tsx`)

Two exports: `OfflineSongDownloadButton` (per-song) and `OfflineBulkDownloadButton`
(per-collection, used by SongGrid header + PlaylistPage).

### `canCacheSong(song)` (gates everything)
Returns false for `source` `"browser-local"`/`"picked-file"`, for missing/`blob:`/`data:`
audio URLs, and for cross-origin audio (`new URL(song.audioUrl, location.origin).origin !== location.origin`).
If the only song fails this, the button shows but is effectively a no-op.

### `OfflineBulkDownloadButton` props
```ts
{ songs: PlayerSong[]; scope: DownloadScope; label?="Download"; className?; iconOnly?=false; hideWhenDownloaded?=false }
```
- Subscribes (shallow) to scope status + progress; ALSO does a debounced (400ms)
  authoritative `readScopeDownloadState(songs, scope)` from IDB and prefers that.
- Status drives the label/icon/colors:
  - `downloaded` → icon `X`, text "Remove downloads", emerald style → opens a confirm dialog.
  - `failed` / actionError → `RefreshCw`, "Retry downloads", red style.
  - `downloading` (inFlight) → progress pie, `Downloading {percent}% · cancel`, tap cancels via `removeScope(scope)`.
  - `partial` → "Finish download".
  - else → the `label` ("Download" / "Download playlist").
- `handleClick`: `impactLight()`; if downloaded → confirm; if inFlight → `removeScope`;
  else `queueDownloads(cacheableSongs, scope)`.
- Button base classNames (verbatim):
  `iconOnly ? "grid h-11 w-11 place-items-center rounded-full" : "inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-medium"`,
  plus `"shrink-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"`,
  plus color set: downloaded `"bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20"`,
  error `"bg-red-500/15 text-red-300 hover:bg-red-500/20"`, default
  `"bg-white/[0.08] text-white/[0.78] hover:bg-white/[0.12] hover:text-white"`,
  inFlight `"text-emerald-300"`, pending `"cursor-wait"`, empty `"cursor-wait opacity-70"`.
- Confirm dialog (createPortal to body): overlay `"fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm"`,
  panel `"w-full max-w-sm rounded-2xl border border-white/15 bg-zinc-950 p-5 text-white shadow-[0_20px_80px_rgba(0,0,0,0.65)]"`,
  title "Remove downloads?", body "This will remove offline copies for this collection from this device.",
  Cancel + "Remove downloads" buttons.

### `OfflineSongDownloadButton`
Per-song; statuses `downloaded` (emerald `DownloadedBadge`), `failed` (`RefreshCw`),
`queued`/`downloading` (progress pie + cancel `X` on hover), else `CircleArrowDown`.
`handleClick`: downloaded → confirm dialog ("Remove download?", body references
`song.title`); inFlight → `removeDownload(song.id)`; else `queueDownloads([song], "song:"+id)`.
Returns `null` if `!canCacheSong(song)`.
`DownloadProgressPie` uses CSS `conic-gradient` + `color-mix` (web-only — reimplement).

---

## 12. Auth (`src/client/auth.tsx`) — `useAuth()`

```ts
{ user: AuthUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  refresh; signIn; signOut; updateProfileImage; resendVerification }
AuthUser = { id; email; name: string|null; image: string|null; emailVerified: boolean }
```
- Session via `GET /api/auth/session` (`credentials:"include"`, `cache:"no-store"`, 2.5s timeout).
- Caches user in `localStorage["spotify_cached_auth_user"]`; signed-out flag in
  `spotify_auth_signed_out`. On `localhost`/`*.local` falls back to a hardcoded local owner.
- Listens for the `spotify:api-auth-required` window event to force sign-out.
- On user-id change calls `useLikesStore.getState().resetRemote()` and
  `setOfflineAccountScope(user?.id ?? status)`.

---

## 13. PORTING HAZARDS (must rewrite for Expo / RN)

1. **DOM virtualization in SongGrid** — `getBoundingClientRect`, `getComputedStyle`,
   `ResizeObserver`, `IntersectionObserver`, `requestAnimationFrame`, `window.scroll`,
   `.closest(".wf-main")`. Discard entirely; use `FlatList`/`FlashList` (numColumns 2..5
   responsive for grid; single column for list). DownloadedPage's IntersectionObserver
   sentinel → `onEndReached` + `onEndReachedThreshold` driving `loadDownloads(false)`.
2. **`createPortal(..., document.body)`** in TrackActionsSheet and both download confirm
   dialogs → RN `Modal` / a sheet lib (`@gorhom/bottom-sheet`). No `document`, no portals.
3. **`localStorage`** in SongGrid (view/sort prefs), likes store (local liked ids), auth
   (cached user), offline store (account scope, device id, auto-download flag) →
   `AsyncStorage` / `expo-secure-store` / MMKV. All access is currently synchronous; RN
   storage is async — refactor read paths.
4. **IndexedDB + Cache API** are the entire offline/download engine (`spotify_offline_v1`,
   `caches.open`, streaming `response.body.getReader()`, blob caching). None exist in RN.
   Rebuild on `expo-file-system` (download to disk) + SQLite/MMKV for the record index.
   `readDownloadedRecordsPage`, `mergeOfflineDownloadRecords`,
   `resolveOfflineDownloadRecordSong`, `queueDownloads`, `removeScope` all need RN backends.
5. **Relative fetch URLs** everywhere (`/api/liked`, `/api/likes`, `/api/playlist/:id`,
   `/api/likes`, `/api/auth/session`, etc.) rely on same-origin web behavior. RN has no
   origin — must prefix with an absolute base URL and send the session cookie/token
   explicitly (RN `fetch` does not auto-attach cookies like a browser; `credentials:"include"`
   is a no-op). The whole `withAccountScope`/`if-none-match`/etag/`x-spotify-api-refresh`
   round-trip should be reimplemented against an absolute API client.
6. **`window`/`document`/`navigator.onLine`/`navigator.serviceWorker`/`caches`** guards
   in api.ts, auth.tsx, offline.ts. Replace online checks with `@react-native-community/netinfo`;
   drop all service-worker logic; drop the `spotify:api-auth-required` window CustomEvent
   (use a store/event-emitter instead).
7. **CSS-only visuals**: `wf-*` global classes (skeleton shimmer, pressable, control button,
   song card/cover, list row), `conic-gradient` + `color-mix` progress pie, `backdrop-blur`,
   `env(safe-area-inset-bottom)`, `aspect-square`, gradient overlays, `drop-shadow`. Map to
   NativeWind where possible; reimplement shimmer (e.g. `expo-linear-gradient` + Reanimated),
   progress pie (SVG/Reanimated), safe-area via `react-native-safe-area-context`.
8. **`min-h-[calc(100dvh-3.5rem)]`** assumes a 3.5rem (56px) top bar and dynamic viewport
   units — replace with flex layout + safe-area insets.
9. **Touch gestures**: TrackActionsSheet swipe-to-dismiss uses raw `TouchEvent`
   (`event.touches`/`changedTouches`); reimplement with `react-native-gesture-handler`.
   `onPointerEnter`-based playback warming (SongCard/SongListItem) has no RN hover — drop or
   move warming to `onPress`.
10. **Haptics** `impactLight()` (`@/lib/haptics`) — repoint to `expo-haptics`.
11. **`react-router-dom`** (`useParams`, `useNavigate`, `Link to="/signin"`) → Expo Router /
    React Navigation equivalents.
