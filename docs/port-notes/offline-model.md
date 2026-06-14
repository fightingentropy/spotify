# Offline Model — Port Notes (Web → Expo/React Native)

Reconstruction-grade reference for the offline / download subsystem. Source files:

- `src/client/offline.ts` (2253 lines) — the Zustand store + download pump + mutation queue + IndexedDB layer. **The core of everything.**
- `src/client/offline-api-snapshots.ts` — cached API JSON snapshots (ETag-tagged) in the shared IndexedDB.
- `src/client/capacitor-offline.ts` — native (iOS/Android) file storage via `@capacitor/filesystem`, blob materialization for seekable playback.
- `src/client/offline-diagnostics.ts` — read-only diagnostics (cache sizes, IDB counts, SW state).
- `src/lib/download-settings.ts` — two localStorage key constants.
- `src/lib/db-schema.ts` / `src/lib/db-types.ts` — **server-side** D1 (SQLite) schema. The `OfflineDownload` table is the cloud mirror of download pins.
- `src/lib/storage-keys.ts` — server path/content-type helpers (not offline-specific).

Consumers worth knowing (not in the file list but referenced):
- `src/store/likes.ts` — calls `queueDownloads`/`unpinScope` on like toggle (autoDownloadLiked), and `queueOfflineMutation` when a like POST fails offline.
- `src/components/OfflineSettings.tsx` — UI toggle for autoDownloadLiked + the `/api/liked` backfill.
- `src/components/PlayerBar.tsx` → `src/client/playback-warm.ts` `prefetchUpcomingPlayback` — wraps `prefetchUpcoming`.

---

## 0. TL;DR mental model

Three IndexedDB object stores in one DB (`spotify_offline_v1`, version 3):

1. **`downloads_v2`** — `OfflineDownloadRecord`, keyed by the composite `[accountScope, songId]`. One row per (account, song); a row is reference-counted across **scopes** via its `pinnedBy: DownloadScope[]` array.
2. **`api_snapshots`** — `OfflineApiSnapshot`, keyed by `url`. Cached JSON GET responses with ETags, for offline reads + optimistic local mutation patches.
3. **`mutations`** — `OfflineMutation`, keyed by `id`. Outbox of offline likes / playlist reorders / song edits, replayed when back online.

Two **Cache API** caches hold the actual media bytes on **web**:
- `spotify-media-v1` (`OFFLINE_MEDIA_CACHE`) — durable, pinned downloads.
- `spotify-playback-v1` (`OFFLINE_PLAYBACK_CACHE`) — ephemeral prefetch warmup (LRU-pruned).

On **native** (Capacitor), media bytes go to the **filesystem** (`Directory.Data/offline-media/<songId>/<kind>.<ext>`) instead of the Cache API, and the record carries `nativeFiles`.

A single **serial download pump** (`processDownloadQueue`) drains queued records one at a time, with retry, stall-timeout, and a priority queue for just-tapped songs.

---

## 1. Core types

### `DownloadScope`
```ts
type DownloadScope = "home" | "liked" | `playlist:${string}` | `song:${string}`;
```
The *reason* a song is pinned. A record can be pinned by multiple scopes simultaneously (e.g. liked AND on a playlist). This is the reference-counting key: removing one scope only deletes the file when `pinnedBy` becomes empty.

- `"home"` — pinned by the Home page bulk-download.
- `"liked"` — pinned by Liked Songs (and autoDownloadLiked).
- `` `playlist:${id}` `` — pinned because it's in a downloaded playlist.
- `` `song:${id}` `` — pinned as an individual track download.

### `OfflineDownloadStatus`
```ts
type OfflineDownloadStatus = "queued" | "downloading" | "downloaded" | "failed";
```

### `OfflineDownloadRecord` (stored in `downloads_v2`)
```ts
type OfflineDownloadRecord = {
  songId: string;
  song: PlayerSong;            // full canonical song snapshot
  audioUrl: string;           // original remote audio URL (web cache key)
  imageUrl: string;           // original remote cover URL
  lyricsUrl?: string;
  nativeFiles?: NativeOfflineFiles;   // present only on native; per-kind file refs
  accountScope?: string;      // normalized account id; part of the composite key
  deviceId?: string;          // which device queued/owns this download
  status: OfflineDownloadStatus;
  progress: number;           // 0..1
  size: number;               // total bytes downloaded
  error?: string;
  pinnedBy: DownloadScope[];  // reference-counting set
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  verifiedAt?: number;
};
```
Note: `song` (a full `PlayerSong`) is embedded so the library entry can be reconstructed offline. The `audioUrl`/`imageUrl`/`lyricsUrl` top-level fields duplicate the song's URLs and act as the Cache API lookup keys on web.

### `NativeOfflineAsset` / `NativeOfflineFiles` (capacitor-offline.ts)
```ts
type NativeOfflineAssetKind = "audio" | "image" | "lyrics";
type NativeOfflineAsset = {
  kind: NativeOfflineAssetKind;
  originalUrl: string;   // remote URL it was downloaded from
  path: string;          // relative path under Directory.Data, e.g. "offline-media/<songId>/audio.flac"
  uri: string;           // absolute file:// (or capacitor) URI from Filesystem.getUri/stat
  size: number;
  contentType?: string;
};
type NativeOfflineFiles = Partial<Record<NativeOfflineAssetKind, NativeOfflineAsset>>;
```

### `OfflineApiSnapshot` (api_snapshots)
```ts
type OfflineApiSnapshot<T = unknown> = {
  url: string;          // full URL incl. ?auth=<scope> query — the store key
  data: T;              // parsed JSON body
  etag?: string | null;
  fetchedAt: number;
  updatedAt: number;
};
```

### `OfflineMutation` (mutations) — discriminated union on `type`
```ts
type OfflineMutationStatus = "queued" | "syncing" | "failed" | "auth-required";

type OfflineMutation =
  | { id; type:"like";             accountScope?; status; attempts; error?; createdAt; updatedAt;
      payload: { songId: string; nextLiked: boolean; song?: PlayerSong } }
  | { id; type:"playlist-reorder"; accountScope?; status; attempts; error?; createdAt; updatedAt;
      payload: { playlistId: string; songIds: string[] } }
  | { id; type:"song-edit";        accountScope?; status; attempts; error?; createdAt; updatedAt;
      payload: { songId; title; artist; coverFile?: File; lyricsFile?: File; lyricsText?: string } };
```
⚠ The `song-edit` payload holds raw `File` objects (`coverFile`, `lyricsFile`). **IndexedDB can store `File`/`Blob` structured clones; AsyncStorage/SQLite cannot.** See porting hazards.

### Status enums for store state
```ts
type OfflineSyncStatus         = "idle" | "syncing" | "failed" | "auth-required";
type OfflineVerificationStatus = "idle" | "checking" | "ok" | "repair-needed" | "failed";
```

---

## 2. Zustand store: `useOfflineStore`

### Full state shape (`OfflineState`)
```ts
{
  hydrated: boolean;
  online: boolean;                              // mirrors navigator.onLine
  records: Record<string, OfflineDownloadRecord>;   // keyed by songId (in-memory, current account only)
  pendingMutations: number;
  syncStatus: OfflineSyncStatus;
  syncError: string | null;
  storageUsage: number | null;                 // navigator.storage.estimate().usage
  storageQuota: number | null;
  persistentStorage: boolean | null;           // navigator.storage.persist() result
  nativeStorage: boolean;                       // Capacitor.isNativePlatform()
  verificationStatus: OfflineVerificationStatus;
  verificationCheckedAt: number | null;
  verifiedDownloads: number;
  missingDownloads: number;
  verificationError: string | null;
  autoDownloadLiked: boolean;
  // actions:
  setAutoDownloadLiked(enabled): void;
  hydrate(): Promise<void>;
  queueDownloads(songs: PlayerSong[], scope: DownloadScope): Promise<void>;
  removeDownload(songId): Promise<void>;
  removeScope(scope): Promise<void>;
  unpinScope(songId, scope): Promise<void>;
  retryFailedDownloads(): Promise<void>;
  clearDownloads(): Promise<void>;
  clearPlaybackCache(): Promise<void>;
  verifyDownloads(): Promise<void>;
  prefetchUpcoming(queue: PlayerSong[], currentIndex: number): Promise<void>;
  syncMutations(): Promise<void>;               // === syncOfflineMutations
  refreshStorage(): Promise<void>;
}
```

**Invariant:** `records` is keyed by **songId only**, NOT the composite key, and only ever holds records for the *current* `accountScope`. The composite `[accountScope, songId]` key lives in IDB; the in-memory map is single-account. Switching accounts (`setOfflineAccountScope`) rebuilds `records` from IDB for the new scope.

**Invariant:** `records` is **capped** at `MAX_DOWNLOAD_RECORDS_IN_MEMORY = 420` via `capRecordsInMemory` (keeps the 420 most-recently-`updatedAt`). Hydration loads at most `HYDRATE_DOWNLOAD_RECORD_LIMIT = 160` downloaded + 40 downloading + 40 queued + 40 failed. Because of this cap, the *synchronous* selectors can mis-report scopes with >cap songs — see §8 for the async IDB-backed selectors that fix it.

### Module-level constants (timings / caps)
```ts
DB_NAME = "spotify_offline_v1";  DB_VERSION = 3;
LEGACY_DOWNLOAD_STORE = "downloads";  DOWNLOAD_STORE = "downloads_v2";
API_SNAPSHOT_STORE = "api_snapshots"; MUTATION_STORE = "mutations";
DOWNLOAD_INDEX_ACCOUNT_UPDATED_AT = "accountScope_updatedAt";              // index ["accountScope","updatedAt"]
DOWNLOAD_INDEX_ACCOUNT_STATUS_UPDATED_AT = "accountScope_status_updatedAt";// index ["accountScope","status","updatedAt"]
OFFLINE_MEDIA_CACHE = "spotify-media-v1";  OFFLINE_PLAYBACK_CACHE = "spotify-playback-v1";
OFFLINE_ACCOUNT_SCOPE_STORAGE_KEY = "spotify_offline_account_scope";   // localStorage
OFFLINE_DEVICE_ID_STORAGE_KEY     = "spotify_offline_device_id";       // localStorage
AUTO_DOWNLOAD_LIKED_STORAGE_KEY   = "spotify_auto_download_liked";     // localStorage ("1"/"0")
OFFLINE_SYNC_EVENT = "spotify-offline-sync";  // window CustomEvent name
PLAYBACK_WARM_BYTES = 512*1024;            PLAYBACK_WARM_TIMEOUT_MS = 4000;
DOWNLOAD_STALL_TIMEOUT_MS = 30000;         DOWNLOAD_CACHE_WRITE_TIMEOUT_MS = 60000;
DOWNLOAD_RETRY_ATTEMPTS = 3;               DOWNLOAD_RETRY_DELAY_MS = 1000;  // delay *= attempt
STALE_DOWNLOADING_MS = 2*60*1000;          STALE_SYNCING_MUTATION_MS = 60*1000;
MUTATION_REQUEST_TIMEOUT_MS = 30000;       MAX_MUTATION_ATTEMPTS = 5;
HYDRATE_DOWNLOAD_RECORD_LIMIT = 160;       MAX_DOWNLOAD_RECORDS_IN_MEMORY = 420;
```

### Module-level mutable singletons (concurrency guards)
```ts
let dbPromise; hydrateStarted; listenersAttached;
let downloadPumpRunning; downloadPumpRerunRequested;   // pump re-entrancy
let syncRunning; prefetchRunning;
const priorityDownloadQueue: string[] = [];            // just-tapped song ids
let currentOfflineAccountScope; currentOfflineDeviceId;
let quietVerificationStarted;                           // one-shot launch sweep guard
```

---

## 3. Account scoping ( `[accountScope, songId]` keying )

`accountScope` = a normalized account id string. Anonymous/unknown collapses to `"anonymous"`; the literal `"loading"` is treated as anonymous; missing record scope is treated as `"legacy"`.

Key functions:
- `normalizeOfflineAccountScope(scope)` → trimmed value, or `"anonymous"` if empty/`"loading"`.
- `getOfflineAccountScope()` → current scope (read from localStorage on init).
- `setOfflineAccountScope(scope)` → on change: persist to localStorage, then if hydrated rebuild `records` for the new account, refresh storage, kick the pump + mutation sync.
- `downloadRecordKey(songId, scope?)` → `[normalizeOfflineAccountScope(scope), songId]` — **the IDB composite primary key.**
- `scopedDownloadRecord(record, fallback)` → ensures `record.accountScope` is set/normalized before write.
- `recordAccountScope(record)` → `record.accountScope ? normalize(...) : "legacy"`.
- `isOfflineRecordForAccount(record, scope?)` → guard that a record belongs to a given account.
- `currentAccountRecords(records[])` / `currentAccountMutations(mutations[])` → filter to current account.

The **D1 store name** (`downloads_v2`) uses `keyPath: ["accountScope", "songId"]`. Two indexes on `["accountScope","updatedAt"]` and `["accountScope","status","updatedAt"]` make paged + status-filtered + size-total reads cheap per account.

⚠ The in-memory map is keyed by songId only, so two accounts that both downloaded the same song share **one** in-memory slot at a time (whichever account is active). IDB keeps them distinct.

**Mutations** are also account-scoped (`mutation.accountScope`), set at enqueue time via `getOfflineAccountScope()`; sync only processes the current account's mutations.

**API snapshots** are account-scoped by URL convention: `snapshotAccountScope(url)` reads the `?auth=<scope>` query param. Mutation-driven snapshot patches only touch snapshots whose `auth` scope matches.

---

## 4. The IndexedDB layer

`openOfflineDb()` (exported, shared with offline-api-snapshots.ts so a `DB_VERSION` bump can't desync the two modules):
- Opens `spotify_offline_v1` v3.
- `onupgradeneeded`: creates `downloads_v2` (keyPath `["accountScope","songId"]`) + its two indexes; creates `api_snapshots` (keyPath `"url"`); creates `mutations` (keyPath `"id"`).
- `onsuccess`: sets `db.onversionchange` to close + null the cached promise; runs `migrateLegacyDownloadStore` (one-time copy from legacy `downloads` store into `downloads_v2`, scoping each record) before resolving.
- `onblocked`: rejects (another tab holds an old version).

Generic helpers: `idbGet`, `idbGetAll`, `idbPut`, `idbDelete`, (`idbClear` in snapshots module). All wrap a transaction in a Promise.

**Paged reads** (the in-memory cap workaround):
- `readDownloadRecordsForAccount({ scope?, status?, offset?, limit?, direction? })` → opens a cursor on the appropriate index, skips `offset`, collects up to `limit` (clamped 1..500, default 100), default direction `"prev"` (newest first). Returns `OfflineDownloadRecordPage { records, total, offset, limit, hasMore }`.
- `countDownloadRecordsForAccount(...)` → `index.count(range)`.
- `downloadRangeForAccount(scope, status?)` → an `IDBKeyRange.bound` over the account (and optional status) partition.
- `readDownloadedRecordsPage(...)` (exported) → page of `status:"downloaded"` records.
- `readDownloadRecordsByStatus(status, limit, dir)`, `readFirstDownloadRecordByStatus(status, dir)`.
- `readHydrateDownloadRecords()` → loads (downloading 40 + queued 40, asc) + (failed 40, desc) + (downloaded 160, desc), dedupes, sorts by `updatedAt` desc, slices to 420.
- `readDownloadedBytesTotal(scope)` (exported) → cursor-sums `size` of all downloaded records for the account (so total survives the in-memory cap).

State sync helpers:
- `recordsById(records[])` → `{ [songId]: scopedRecord }`.
- `capRecordsInMemory(map)` → trims to 420 newest by `updatedAt`.
- `mergeOfflineDownloadRecords(records[])` (exported) → merge into store state, capped.
- `setRecordState(record)` → put into in-memory `records` (capped).
- `persistRecord(record)` → `idbPut(DOWNLOAD_STORE)` + `setRecordState`.
- `persistDownloadResult(working, patch)` → **re-reads** the latest IDB record before writing the pump's terminal result, to avoid clobbering a concurrent `queueDownloads` that added a scope to `pinnedBy` while the download was in flight. If the record vanished mid-download (user cancelled), it deletes any written native files and drops the in-memory entry instead of resurrecting it. Merges `pinnedBy` as a union.

---

## 5. The serial download pump (`processDownloadQueue`)

**One song downloads at a time.** Re-entrancy guarded by `downloadPumpRunning`; a call while running sets `downloadPumpRerunRequested` so the pump re-runs once after finishing. Returns early if `isNetworkUnavailable()`.

Flow per pump run:
1. Requeue any stale/interrupted `downloading` records (see §5.2).
2. Loop: pick next queued record via `readNextQueuedDownloadRecord()` →
   - **Priority first**: `readPriorityQueuedDownloadRecord()` drains `priorityDownloadQueue` (FIFO of just-tapped song ids; `enqueuePriorityDownloadIds` moves an id to the back if re-added). Skips entries that are no longer queued / not this account.
   - Else `readFirstDownloadRecordByStatus("queued", "prev")` — newest-queued first.
3. Bail mid-loop if `isNetworkUnavailable()`.
4. **Foreign-device quarantine** (§7): if `record.deviceId !== getOfflineDeviceId()`, mark it `failed` with the "queued on another device" error and continue (cap 20 quarantines per pump run to avoid spinning).
5. Mark record `downloading`, persist.
6. For each cacheable asset (`songAssetUrlEntries`: audio, image, lyrics — same-origin, deduped):
   - **Native** (`isNativeOfflineStorageAvailable()`): `downloadAssetToNative` → fetch blob (stall-timed) → `saveNativeOfflineAsset` → record under `nativeFiles[kind]`.
   - **Web**: `cacheDurableUrl(url)` → stream into `spotify-media-v1`; then *also* `saveCachedAssetToNative` (no-op on web).
   - `onProgress` updates `progress` (capped 0.98 mid-flight), `size`, `updatedAt` live.
7. On success: `persistDownloadResult(working, { status:"downloaded", progress:1, size, verifiedAt:now, ... })`.
8. On error: if `isTransientNetworkError` → set back to `"queued"` + error `"Waiting for connection"` and **break** the loop (wait for online event); else → `"failed"` with the error message.
9. After each item: `refreshStorage()`.

### 5.1 Download fetch internals
- **Web durable** (`cacheUrl` → `cacheDurableUrlOnce` → `cacheDurableUrl`):
  - `fetch(absoluteUrl, { credentials:"include", cache:"reload", headers:{ "x-spotify-offline-download":"1" }, signal })`.
  - Streams `response.body` via reader; `resetStallTimer()` on each chunk (`DOWNLOAD_STALL_TIMEOUT_MS = 30s` → `controller.abort()` if no chunk).
  - Writes a cloned stream into the cache concurrently; stamps `x-spotify-offline-cached-at` header.
  - Retries up to `DOWNLOAD_RETRY_ATTEMPTS = 3` with `DOWNLOAD_RETRY_DELAY_MS * attempt` backoff.
  - On `QuotaExceededError` only: `prunePlaybackCache()` (delete oldest ~half of `spotify-playback-v1` by `x-spotify-offline-cached-at`) + `pruneRuntimeCaches()` (delete `spotify-v\d+-runtime` caches), then retry once.
- **Native** (`fetchDownloadBlob` → `downloadAssetToNative` → `saveNativeOfflineAsset`):
  - Same fetch+stall pattern, but accumulates chunks into a `Blob` rather than the Cache API (the Cache API rejects non-http request URLs under `capacitor://localhost`).
  - `saveNativeOfflineAsset` has a 3-tier write strategy (see §6).

### 5.2 Interruption recovery
- `requeueInterruptedDownloadRecords(records, force?)`: foreign queued/downloading → quarantine; own `downloading` older than `STALE_DOWNLOADING_MS = 2min` (or `force`) → reset to `queued`.
- `recoverInterruptedDownloads(force?)`: reads up-to-80 `downloading`, requeues, merges to state (skips if pump running).
- Called on `online` event, `visibilitychange→visible`, and at hydrate (with `force=true`).

---

## 6. Native file storage (`capacitor-offline.ts`)

Root dir: `Directory.Data` + `offline-media/<safeSongId>/<kind><ext>`.
- `safePathSegment(v)` = `encodeURIComponent(...).replace(/%/g,"_").slice(0,96)`.
- `extensionForAsset(kind,url,blob)` — extension from URL, else from blob MIME (jpg/png/webp/gif/m4a/mp3/flac/wav…), else `.lrc`(lyrics)/`.jpg`(image)/`.bin`.

`saveNativeOfflineAsset({songId,kind,url,blob})` — 3-tier write:
1. **Audio + absolute http url:** `Filesystem.downloadFile({url, ...})` straight to disk (avoids double-buffering huge FLACs). Cross-checks written size vs the validated blob size; mismatch → throw (caught error body).
2. **Chunked append:** `writeBlobInChunks` → `Filesystem.writeFile` (first) + `Filesystem.appendFile` in `NATIVE_APPEND_CHUNK_BYTES = 4MB` base64 chunks (bounds peak memory).
3. **Last resort:** single base64 `Filesystem.writeFile`.
- For `kind==="image"`: `assertValidImageBlob` (magic-number sniff via `looksLikeImageBytes` — catches HTTP error bodies persisted as covers: bodies start with `{`/`<`, never a valid image header).

`verifyNativeOfflineAsset(asset)` — `Filesystem.stat`; size>0; for images, fetch the web URL and re-sniff the header bytes. (WKWebView answers local reads with **status 0** — treated as success.)

`deleteNativeOfflineFiles(files)` — `Filesystem.deleteFile` per asset.

URL helpers:
- `nativeOfflineAssetWebUrl(asset)` → `Capacitor.convertFileSrc(asset.uri)` (produces a `/_capacitor_file_/…` URL).
- `isCapacitorFileUrl(v)` → contains `/_capacitor_file_/`.

### ⚠ Blob materialization for seekable playback (goes away in RN)
WKWebView's scheme handler marks `_capacitor_file_` media as **non-byte-range-accessible** and silently drops seeks. To make native offline seeking work, the app:
- `fetchNativeOfflineAudioBlob(url)` → fetch the local file → wrap as a typed `Blob` (correct audio MIME via `offlineAudioMime`).
- `acquireNativeOfflineAudioObjectUrl(src)` → `URL.createObjectURL(blob)`, cached in a `Map`, aggressively revoked (`releaseNativeOfflineAudioObjectUrl`) because object URLs pin 100–300MB FLACs in memory. At most two alive at once (dual-element crossfade).

**In React Native this entire blob:/object-URL dance disappears.** `expo-av`/`expo-audio` plays a `file://` URI directly and supports seeking natively. The native audio MIME guessing (`offlineAudioMime`, `AUDIO_MIME_BY_EXTENSION`) is also unneeded — keep only the extension logic for file naming.

---

## 7. Foreign-device quarantine

Each install gets a stable `deviceId` (`device:<uuid>`) persisted to localStorage. Records carry `deviceId` (who queued them). The OfflineDownload D1 mirror means a record queued on one device can sync down to another. The pump refuses to *process* a foreign queued/downloading record:
- `canProcessDownloadOnThisDevice(record)` = `record.deviceId === getOfflineDeviceId()`.
- Foreign queued/downloading → `quarantineForeignQueuedDownloadRecord`: set `failed`, error `"Download was queued on another device. Tap download to save it here."`. The user must re-tap download (which re-stamps `deviceId` via `queueDownloads`/`retryFailedDownloads`).

Port note: keep this. Generate a per-install device id (`expo-application` `getAndroidId`/`getIosIdForVendorAsync`, or a UUID in SecureStore/AsyncStorage).

---

## 8. Selectors / playback resolution (exported helpers)

- `getSongDownloadState(record)` → status or `"none"`.
- `getScopeDownloadState(records, songs, scope)` → `downloaded|downloading|failed|partial|none` (synchronous, in-memory — may under-report past the cap).
- `readScopeDownloadState(songs, scope)` (async) → authoritative, reads each song from IDB.
- `scopeDownloadStateFromRecords(...)` — shared logic: filters by `pinnedBy.includes(scope)`.
- `readDownloadedBytesTotal(scope)` (async) — total bytes (see §4).
- `formatBytes(value)` — B/KB/MB/GB/TB formatter.
- `resolveOfflinePlaybackSong(song)` → if a downloaded record exists for the current account, swap the song's URLs to the offline copies.
- `resolveOfflineDownloadRecordSong(record, song)`:
  - **Native + nativeFiles.audio:** returns the song with `source:"offline"`, `audioUrl = convertFileSrc(nativeFiles.audio.uri)`, `imageUrl = nativeFiles.image` (with `networkImageUrl` kept as a remote fallback for corrupt local covers), `lyricsUrl` from `nativeFiles.lyrics`.
  - **Native without nativeFiles:** returns the song unchanged.
  - **Web:** returns `preferOfflinePlaybackSong({...})` with the record's `audioUrl`/`imageUrl`/`lyricsUrl` (served from the Cache API via the SW / patched fetch).
- `sanitizePersistedPlayerSong(song)` — strips/repairs `_capacitor_file_` URLs from persisted playback snapshots after reinstall (a missing capacitor file image never fires `onerror` in WKWebView, wedging the cover). Swaps in the canonical download record's song if available, else strips device-local image/lyrics URLs (falls back to `networkImageUrl`/`/apple-icon.png`).

⚠ `canCacheSong(song)` = not a browser-local song AND `sameOriginCacheableUrl(song.audioUrl)`. `sameOriginCacheableUrl` rejects `blob:`/`data:` and cross-origin (compares against `location.origin`). **This same-origin gate must be redefined for RN** — there's no `location.origin`; the app talks to a configured backend base URL.

---

## 9. API snapshots (`offline-api-snapshots.ts`)

Public API used by `src/client/api.ts`:
- `readOfflineApiSnapshot<T>(url)` → snapshot or undefined.
- `writeOfflineApiSnapshot<T>(url, data, etag?, fetchedAt?)` → store JSON + ETag.
- `removeOfflineApiSnapshots(match?)` → clear all, or delete by string-prefix / RegExp / predicate.

Snapshots are keyed by full URL (incl. `?auth=<scope>`), so they're naturally account-partitioned. ETags let `api.ts` send `If-None-Match` and reuse the snapshot on `304`.

**Offline mutation → snapshot patching** (in offline.ts): when a mutation is queued, `updateSnapshotsForMutation` walks every snapshot of the matching account scope and optimistically patches the cached JSON so the UI reflects the change while offline:
- `like` → `updateLikedIds` (mutates `likedSongIds`/`likes` arrays) + for `/api/liked`, `updateLikedSongs` (insert/remove the song object).
- `playlist-reorder` → `reorderPlaylistPayload` (re-sort `songs` by the new id order) on `/api/playlist/<id>`.
- `song-edit` → `updateSongInPayload` (patch title/artist in any `songs[]` or `song`).
- Helpers: `snapshotPath(url)`, `snapshotAccountScope(url)`, `cloneJsonLike` (`structuredClone` w/ JSON fallback).

---

## 10. Mutation queue (offline outbox)

- `queueOfflineMutation(mutation)` (exported) — stamps `id`, `accountScope`, `status:"queued"`, `attempts:0`, timestamps; `idbPut(MUTATION_STORE)`; patches snapshots; refreshes count; dispatches `spotify-offline-sync` window event; kicks `syncMutations`.
- `syncOfflineMutations()` (exported as `syncMutations`):
  - Re-entrancy guarded by `syncRunning`; bails if offline.
  - `requeueStaleSyncingMutations` — `syncing` rows older than `STALE_SYNCING_MUTATION_MS = 60s` → back to `queued` (crash recovery, mirrors download requeue).
  - Filters out `syncing` and terminally-failed (`failed && attempts >= MAX_MUTATION_ATTEMPTS = 5`); sorts by `createdAt` asc.
  - Only flips `syncStatus:"syncing"` when there's real work (avoids a status-pill flash on every cold start).
  - Per mutation: mark `syncing`, `attempts++`; `performMutation`; on success `idbDelete`; on error classify: `401|403` → `"auth-required"` (sets sync status, dispatches event, **stops** the loop), else `"failed"` (with "gave up after N attempts" once it hits the cap).
- `performMutation(mutation)` (the actual network calls — **all relative-URL fetches**, see hazards):
  - `like` → `fetch("/api/likes", { method: nextLiked?"POST":"DELETE", body: {songId}, credentials:"include", cache:"no-store" })`.
  - `playlist-reorder` → `fetch("/api/playlist/<id>/reorder", { method:"POST", body:{songIds} })`.
  - `song-edit` → `PATCH /api/songs/<id>` `{title,artist}`, then if cover/lyrics present, `POST /api/songs/<id>/assets` with `FormData` (`image`, `lyricsFile`, `lyricsText`).
  - All use `mutationFetch` (30s `AbortController` timeout). Errors carry `.status`.
- `mutationCount()` → count of current-account mutations not `syncing`.

Consumer (`src/store/likes.ts`): on a failed like POST, `queueOfflineMutation({ type:"like", payload:{songId,nextLiked,song} })` and treat as success (202). The like is also reflected in the local liked map + API cache.

---

## 11. autoDownloadLiked

- Persisted in localStorage `spotify_auto_download_liked` (`"1"`/`"0"`); `setAutoDownloadLiked` writes it + sets state.
- **Queue on like** (`src/store/likes.ts` `syncAutoDownloadLiked`): when `autoDownloadLiked` is on, a like → `queueDownloads([song], "liked")`; an unlike → `unpinScope(songId, "liked")`. Fire-and-forget; never blocks/fails the like toggle.
- **Backfill on enable** (`src/components/OfflineSettings.tsx` `handleAutoDownloadLikedChange`): `setAutoDownloadLiked(true)` then `fetch("/api/liked")` → `queueDownloads(payload.songs, "liked")`. Guarded against the user toggling back off mid-fetch; if the fetch fails (offline) the next enable retries.

---

## 12. Launch verify / repair

- **hydrate()** (idempotent via `hydrateStarted`): attaches browser listeners; loads records (`readHydrateDownloadRecords`), pending count, storage estimate, requests persistent storage; force-requeues interrupted; sets state. Then via `scheduleBackgroundOfflineWork` (requestIdleCallback / 1s timeout): kicks the pump, kicks mutation sync, and schedules `quietVerifyDownloadedRecords` after **12s**.
- **quietVerifyDownloadedRecords()** — native-only, one-shot (`quietVerificationStarted`). For each downloaded record, `verifyOrRepairRecord`; if not OK, set `status:"queued"` (error "Offline file damaged; queued for repair") and kick the pump. **Never touches the user-facing `verificationStatus`** (no "checking" flash on launch).
- **verifyDownloads()** (the explicit Settings button) — flips `verificationStatus:"checking"`, verifies every downloaded record, requeues missing ones, sets `verificationStatus` to `ok`/`repair-needed`/`failed` + `verifiedDownloads`/`missingDownloads`.
- **verifyOrRepairRecord(record)** — per asset: native → `verifyNativeOfflineAsset`; if it fails but the web Cache copy is valid, re-save cached→native (self-heal); web → `verifyCachedAsset` (cache hit + non-zero size/blob). Returns `{ok, record}`, stamping `verifiedAt`.

---

## 13. Diagnostics (`offline-diagnostics.ts`)

`readOfflineDiagnostics()` → `{ checkedAt, online, serviceWorker{supported,controlled,registrationState}, caches[]{name,entries,estimatedBytes,byteEntries}, indexedDb{available,apiSnapshots,downloads,mutations,error?}, playbackState{saved,pendingSync,updatedAt} }`.
- Reads SW registration state, Cache API sizes (sums `content-length`), IDB store counts (opens **existing** DB read-only, aborts if upgrade needed), and playback-state localStorage keys.
- `sameCacheRequest(a,b)` — compares normalized cache keys.
- ⚠ Re-declares the store-name constants locally (`DB_NAME`, `DOWNLOAD_STORE`, etc.) — keep these in sync if renamed during the port. Almost all of this (SW, Cache API) is web-only and either drops or becomes expo-file-system/SQLite stat calls in RN.

---

## 14. Server-side mirror (D1) — `db-schema.ts` / `db-types.ts`

`OfflineDownload` table (cloud copy of pins, synced via `/api/offline-downloads`-style routes):
```sql
"OfflineDownload" ( id, userId, songId, songJson TEXT, scopesJson TEXT,
                    createdAt, updatedAt,
                    UNIQUE(userId, songId) )
-- index idx_offlinedownload_userId_updatedAt
```
`OfflineDownloadRow = { id, userId, songId, songJson, scopesJson, createdAt, updatedAt }`.
- `songJson` = serialized `PlayerSong`; `scopesJson` = serialized `DownloadScope[]` (== `pinnedBy`).
- This is how a download pinned on one device shows up (and gets quarantined) on another. Unchanged by the port — the RN client hits the same API.

Related tables used by the offline flow: `Like`, `LikeBackfill`, `PlaybackState` (with `deviceId`, `clientUpdatedAt`), `PlayEvent`. `storage-keys.ts` (`normalizeStorageKey`, `inferContentTypeFromKey`) is server R2-path tooling, not client offline.

---

## 15. PORTING HAZARDS (web-only primitives → RN/Expo)

### Storage substrate (the big one)
- **IndexedDB (`downloads_v2`, `api_snapshots`, `mutations`) → expo-sqlite.** Recreate three tables:
  - `downloads` PK `(accountScope, songId)`, with indexes on `(accountScope, updatedAt)` and `(accountScope, status, updatedAt)` to preserve the paged/status/total cursor reads. Store `song`/`nativeFiles`/`pinnedBy` as JSON-TEXT columns.
  - `api_snapshots` PK `url`, columns `data`(JSON TEXT), `etag`, `fetchedAt`, `updatedAt`.
  - `mutations` PK `id`. **`song-edit` File payloads can't be JSON-serialized** — persist `coverFile`/`lyricsFile` as file URIs (expo-file-system cache paths) instead of `File` objects, and reconstruct multipart from the URI at sync time (`FormData` with `{ uri, name, type }` in RN).
  - All the bespoke cursor logic (`openCursor`, `IDBKeyRange.bound`, `direction:"prev"`) becomes `SELECT … WHERE accountScope=? [AND status=?] ORDER BY updatedAt DESC LIMIT ? OFFSET ?` and `COUNT(*)`/`SUM(size)` queries — much simpler.
- **Cache API (`spotify-media-v1`, `spotify-playback-v1`) → expo-file-system.** On web, web downloads went to the Cache API and native went to the filesystem. **In RN there is only the filesystem.** Drop the entire Cache-API code path (`cacheUrl`, `cacheDurableUrl`, `deleteCachedUrls`, `prunePlaybackCache`, `pruneRuntimeCaches`, `verifyCachedAsset`, `readCachedAssetBlob`, `saveCachedAssetToNative`, `OFFLINE_MEDIA_CACHE`/`OFFLINE_PLAYBACK_CACHE`). Use `FileSystem.documentDirectory` for durable downloads, `cacheDirectory` for prefetch warmup, and `FileSystem.createDownloadResumable` (gives native streaming + progress + the stall behavior you'd otherwise hand-roll). `getInfoAsync` replaces `verifyCachedAsset`/`stat`.
- **localStorage (`spotify_offline_account_scope`, `spotify_offline_device_id`, `spotify_auto_download_liked`) → AsyncStorage** (or SecureStore for device id). All three reads/writes are synchronous in the source (`readStoredOfflineAccountScope`, etc.); AsyncStorage is async — hoist them into an async init/bootstrap so the module-level `currentOfflineAccountScope`/`currentOfflineDeviceId` are seeded before use.

### Web-only primitives that must be rewritten or removed
- **`blob:` / `URL.createObjectURL` / `revokeObjectURL`** (capacitor-offline.ts audio object-URL cache): **gone in RN.** expo-av/expo-audio plays a `file://` URI directly and seeks natively. Delete `acquireNativeOfflineAudioObjectUrl`/`releaseNativeOfflineAudioObjectUrl`/`fetchNativeOfflineAudioBlob`/`nativeOfflineAudioObjectUrls` and the MIME-guessing — keep only file-path/extension logic.
- **`Capacitor.convertFileSrc` / `/_capacitor_file_/` / WKWebView scheme handler quirks** (`nativeOfflineAssetWebUrl`, `isCapacitorFileUrl`, `sanitizePersistedPlayerSong`'s capacitor-URL stripping): all WKWebView-specific. In RN, store and play the raw `file://` URI; the seek/byte-range workaround and the status-0 handling are moot. `sanitizePersistedPlayerSong` still matters conceptually (after reinstall, file URIs are dead) — rewrite it to check `FileSystem.getInfoAsync(uri).exists` and fall back to the remote URL.
- **Relative-URL `fetch(...)`** everywhere: `/api/likes`, `/api/playlist/<id>/reorder`, `/api/songs/<id>`, `/api/songs/<id>/assets`, `/api/liked`, plus the media fetches resolved via `new URL(value, location.origin)`. **RN `fetch` has no origin** — every URL must be absolutized against a configured backend base URL. `resolveUrl`, `sameOriginCacheableUrl`, `canCacheSong`, `snapshotPath`/`snapshotAccountScope` (which use `location.origin`/`http://spotify.local`) all need the base-URL injected.
- **`credentials: "include"` cookie auth:** RN fetch does not share a cookie jar with a webview. Auth must move to an explicit token (Authorization header / signed URL). Every `performMutation` call and the download fetches rely on the session cookie today.
- **Service Worker** (diagnostics + the implicit SW that served web Cache API media): **no SW in RN.** On web the SW intercepted media requests and served from `spotify-media-v1`; in RN you point the player at the local file directly. Drop `getServiceWorkerDiagnostics` and the SW assumptions.
- **`navigator.onLine` / `online`/`offline`/`visibilitychange` events** (`attachBrowserListeners`, `isNetworkUnavailable`, `shouldSkipSpeculativeMediaFetch`): replace with `@react-native-community/netinfo` (and `AppState` for foreground/visibility). `navigator.connection.saveData/effectiveType` (data-saver gate in prefetch) → NetInfo `details.isConnectionExpensive`/cellular checks.
- **`navigator.storage.estimate()` / `.persist()`** (`estimateStorage`, `requestPersistentStorage`, `storageUsage`/`storageQuota`/`persistentStorage`): no web Storage Manager. Use `FileSystem.getFreeDiskStorageAsync()`/`getTotalDiskCapacityAsync()` (or sum your own downloaded bytes via the SQLite `SUM(size)` query, which the code already has in `readDownloadedBytesTotal`). Persistent storage is implicitly durable in app document dir — drop `persist()`.
- **`window.dispatchEvent(new CustomEvent("spotify-offline-sync"))` + `window.addEventListener`**: replace with a Zustand subscription, an event emitter, or just rely on store state changes. No `window`/`document`.
- **`requestIdleCallback`** (`scheduleBackgroundOfflineWork`): not in RN. Use `InteractionManager.runAfterInteractions` or a `setTimeout`.
- **`structuredClone`** (`cloneJsonLike`): available in modern RN (Hermes) but has a JSON fallback already — fine.
- **`crypto.randomUUID`** (`randomId`): RN needs `expo-crypto` `randomUUID()` or the existing fallback.
- **`FileReader` / `readAsDataURL` base64 chunking** (`blobToBase64`, `writeBlobInChunks`): with `expo-file-system` you write the downloaded file directly (`createDownloadResumable`) — no base64 round-trip needed. Keep `looksLikeImageBytes`/`assertValidImageBlob` (read the first bytes via `FileSystem.readAsStringAsync({ encoding: Base64, length: 16 })` or a small range) to preserve the poisoned-cover detection.
- **`AbortController` stall timers**: supported in RN, but `createDownloadResumable` gives native progress; you can keep a stall timer that calls `.cancelAsync()`.

### Logic that ports cleanly (keep the design)
- Account scoping `[accountScope, songId]`, `pinnedBy` reference counting, the serial pump + priority queue, retry/stall semantics (re-expressed with FileSystem), the mutation outbox state machine, foreign-device quarantine, autoDownloadLiked, verify/repair, the in-memory cap + paged reads (trivial with SQL `LIMIT/OFFSET`), the snapshot-patch-on-mutation optimistic UI, and the D1 server mirror are all platform-agnostic and should be reimplemented as-is.
