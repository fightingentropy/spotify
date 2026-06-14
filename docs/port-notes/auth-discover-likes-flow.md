# Port Notes — Auth Context, Discover-Keep, Likes Store, Podcast Progress, Haptics

Reconstruction-grade reference for porting the auth/likes/discover flow from the
Vite + React 19 + Zustand + Capacitor web app to Expo / React Native.

Files covered (all absolute paths in repo root `/Users/erlinhoxha/Developer/spotify`):

- `src/client/auth.tsx` — auth context/provider + endpoints
- `src/client/discover-keep.ts` — Discover "keep" promotion flow
- `src/store/likes.ts` — Zustand likes store (optimistic toggle, offline fallback, local songs)
- `src/client/podcast-progress.ts` — podcast resume/finish persistence
- `src/lib/haptics.ts` — Capacitor haptics wrappers

Supporting symbols quoted from `src/client/api.ts` and `src/client/offline.ts` where the
store depends on them.

---

## 0. Cross-cutting RN porting hazards (read first)

Every file below assumes a **browser**. The single biggest porting theme:

1. **Relative `fetch()` URLs everywhere** (`fetch("/api/auth/session")`, `fetch("/api/likes")`,
   `fetch("/api/discover/promote")`, `fetch("/api/profile/image")`, `fetch("/api/auth/signin")`,
   etc.). RN has **no origin** — `fetch("/api/...")` throws / fails. **Every relative URL must be
   prefixed with an absolute API base URL** (e.g. `${API_BASE}/api/...`). This is pervasive.
2. **Cookie auth (`credentials: "include"`)**. The web app authenticates with an HTTP-only session
   cookie set by the server. RN `fetch` does not automatically persist/attach cookies the way a
   browser does. Port to either (a) a cookie jar that survives app restarts (e.g.
   `@react-native-cookies/cookies` + an interceptor), or (b) a token returned by signin stored in
   secure storage and sent as `Authorization`. Auth is **cookie-based, not signed-URL based**.
3. **`localStorage`** is used as the durable cache for: cached auth user, signed-out flag,
   local liked song ids, podcast progress map. Replace with `AsyncStorage` (async!) or MMKV.
   Note this changes sync reads (`readCachedAuthUser`, `readLocalLikedSongIds`, `readProgressMap`)
   into async reads — store initialization that currently runs synchronously in
   `useState(() => ...)` / `create(...)` must be reworked to hydrate after mount.
4. **`window` / `navigator` / `document` / `caches` / `navigator.serviceWorker`** — none exist in RN.
   Used for: online/offline detection (`navigator.onLine`), the `online` event listener, service
   worker cache messaging, the Cache Storage API (profile image warming), `window.location.*`,
   `window.addEventListener` for the custom auth-required event, `window.setTimeout`/`clearTimeout`
   (fine, but `window.` prefix must be dropped).
5. **`@capacitor/haptics`** dynamic import — replace with `expo-haptics`.
6. **`File` / `FormData` / `FileReader`** for profile image upload — replace with Expo
   ImagePicker + `FormData` (RN supports a different FormData file shape: `{ uri, name, type }`).
7. **CustomEvent / window event bus** (`API_AUTH_REQUIRED_EVENT`, `online` event,
   `OFFLINE_SYNC_EVENT`) — replace with a JS EventEmitter / Zustand subscription / RN
   `NetInfo` for connectivity.

---

## 1. Auth context/provider — `src/client/auth.tsx`

React Context provider exposing auth state + actions. Wraps the app; consumed via `useAuth()`.

### 1.1 Exported types

```ts
export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;       // may be null, a same-origin URL, or the hardcoded "/profile.jpg"
  emailVerified: boolean;
};
```

```ts
type AuthContextValue = {
  user: AuthUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  refresh: (options?: { showLoading?: boolean }) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateProfileImage: (file: File) => Promise<void>;   // File → must change for RN
  resendVerification: () => Promise<void>;
};
```

Exports: `AuthProvider` (component), `useAuth()` (hook — throws "useAuth must be used within AuthProvider" if no provider).

### 1.2 Constants (verbatim)

```ts
const CACHED_AUTH_USER_KEY = "spotify_cached_auth_user";            // localStorage key: JSON of AuthUser
const CACHED_AUTH_SIGNED_OUT_KEY = "spotify_auth_signed_out";       // localStorage key: "1" when explicitly signed out
const ERLIN_PROFILE_IMAGE_URL = "/profile.jpg";                     // owner's hardcoded avatar (relative!)
const SESSION_REFRESH_TIMEOUT_MS = 2_500;                           // 2.5s session-check timeout
const PROFILE_IMAGE_CACHE = "spotify-media-v1";                     // Cache Storage bucket name (web-only)
const LOCAL_OFFLINE_AUTH_USER: AuthUser = {
  id: "local-mac-mini",
  email: "erlin@spotify.local",
  name: "Erlin",
  image: ERLIN_PROFILE_IMAGE_URL,
  emailVerified: true,
};
```

### 1.3 EXACT auth endpoints and their quirks

All use **cookie auth** (`credentials: "include"`), all relative URLs.

| Method & Path | Request body | Success response | Status codes / quirks |
|---|---|---|---|
| `GET /api/auth/session` | none. `cache: "no-store"`, aborted after **2.5s** via AbortController + Promise.race | `{ user?: AuthUser \| null }` (JSON) | `401`/`403` ⇒ treated as signed-out (clears caches, sets `unauthenticated`). Other non-OK ⇒ throws, falls back to cached user. On timeout the AbortController aborts and the catch falls back to cached user. |
| `POST /api/auth/signin` | `{ email, password }` JSON, header `content-type: application/json` | `{ user?: AuthUser }` (JSON). Cookie set server-side. | Non-OK **or** missing user ⇒ throws `data.error \|\| "Invalid email or password"`. |
| `POST /api/auth/signout` | none | **204 No Content** (no body expected) | Fire-and-forget: wrapped in `.catch(() => null)` — failure is ignored, local state cleared regardless. |
| `POST /api/auth/resend-verification` | none | OK (body unused) | Non-OK ⇒ throws `data.error \|\| "Failed to resend verification email"`. |
| `POST /api/profile/image` | **Two shapes** (see below) | `{ user?: AuthUser }` JSON | Non-OK or missing user ⇒ throws `data.error \|\| "Failed to update profile image"`. |

**Verify email is a 302 redirect (server-side, not called from this file):** the email link hits a
verify endpoint that responds **302 redirect** back into the app (not JSON). Client just calls
`refresh()`/`resendVerification()`; the actual verification click is handled by the browser
following the redirect. In RN there is no in-app browser redirect handler by default — porting the
verify-email link click requires a deep link / universal link handler that, on return, triggers
`refresh()`.

**Profile image — two request shapes (native vs web):**
```ts
// Native Capacitor app (isNativeCapacitorApp()): CapacitorHttp bridge mangles multipart,
// so it uploads base64 JSON instead:
fetch("/api/profile/image", {
  method: "POST", credentials: "include",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ image: <base64 no-prefix>, filename: file.name, contentType: file.type }),
});
// Web: multipart FormData with field name "image":
const form = new FormData(); form.append("image", file);
fetch("/api/profile/image", { method: "POST", credentials: "include", body: form });
```
PORTING: In RN, FormData file upload works (`{ uri, name, type }`), so the **web (multipart)** path
is the natural target, BUT the server already accepts the base64-JSON shape (because native already
uses it) — base64-JSON is the safest/most reliable RN path. `fileToBase64()` (lines 7–18) uses
`FileReader.readAsDataURL` and strips the `data:...;base64,` prefix (slices after first comma) — in
RN use `expo-file-system` `readAsStringAsync(uri, { encoding: Base64 })` or ImagePicker `base64`.

### 1.4 Cached user / signed-out flag (localStorage-backed)

- `readCachedAuthUser()` → reads `CACHED_AUTH_USER_KEY` JSON, runs through `coerceAuthUser`, falls
  back to `readLocalOfflineAuthUser()`. **Sync localStorage read** (must become async in RN).
- `writeCachedAuthUser(user, { signedOut })` → on user: writes JSON, removes signed-out flag.
  On null + `signedOut:true`: removes user, sets `CACHED_AUTH_SIGNED_OUT_KEY = "1"`. On null without
  signedOut: just removes user (does NOT set signed-out flag — important: a failed refresh shouldn't
  mark the user explicitly signed-out).
- `readLocalOfflineAuthUser()` → returns the hardcoded `LOCAL_OFFLINE_AUTH_USER` **only when** the
  hostname is local (`localhost`, `127.0.0.1`, `::1`, `[::1]`, or `*.local`) **and** the signed-out
  flag is not set. This is a self-hosting convenience (owner on the Mac-mini LAN is auto-authed
  offline). **RN port: this whole `window.location.hostname` branch is meaningless** — decide
  whether to keep an offline-owner fallback at all (likely drop it, or gate on the configured API
  base host).
- `coerceAuthUser(value)` — validation/normalization. Requires `id` and `email` to be strings or
  returns null. `name` → string or null. `image` → stored image if non-empty string, else
  `defaultAuthUserImage()`. **`emailVerified` defaults to `true` when absent** (`!== false`) — only
  an explicit `false` from the server marks unverified (so older cached users / local owner never get
  falsely nagged).
- `defaultAuthUserImage(email, name)` — returns `ERLIN_PROFILE_IMAGE_URL` ("/profile.jpg") when name
  is "erlin"/"erlin hoxha" or email local-part is "erlin"/"erlinhoxha"; else null. Owner-specific
  hardcode.

### 1.5 Session refresh (`fetchSession` + `refresh`)

`fetchSession()` (lines 177–196): `fetch("/api/auth/session", { credentials:"include", cache:"no-store", signal })`
raced against a `window.setTimeout` of **2_500 ms** that aborts the controller and rejects with
`"Session check timed out"`. Always clears the timeout in `finally`.

`refresh(options?)` (lines 208–242) — the core state machine:
1. Captures `generation = authGenerationRef.current`; `isStale()` re-checks it after each await.
   **Invariant:** any authoritative state change (sign in/out, forced logout via auth-required
   event) increments `authGenerationRef`, so a slow in-flight refresh **bails** instead of
   resurrecting a just-signed-out user.
2. If `isKnownOffline()` (`navigator.onLine === false`): set user from cache, set status
   authenticated/unauthenticated, return (no network).
3. If `options.showLoading`: set status `"loading"`.
4. `await fetchSession()`. If stale → return.
5. `401`/`403` → `invalidateApiCache()`, `clearServiceWorkerApiCache()`,
   `writeCachedAuthUser(null,{signedOut:true})`, user=null, status=`unauthenticated`.
6. other non-OK → throw → catch falls back to cached user.
7. OK → parse `{ user }`, `coerceAuthUser`, `writeCachedAuthUser(nextUser,{signedOut:!nextUser})`,
   set user + status.
8. catch (network error/timeout): if stale return; else fall back to cached user + derived status.

`initialAuthStatus(user)` → `"authenticated"` if cached user present, else `"unauthenticated"` if
known-offline, else `"loading"`. This is the **initial status before first refresh** — gives instant
UI from cache.

### 1.6 Provider effects (mount lifecycle)

- `useState(() => readCachedAuthUser())` for `initialUser`; `user`/`status` seeded from it. **In RN
  this sync init breaks** (AsyncStorage is async). Port: start `loading` and hydrate in an effect.
- Effect: `void refresh()` on mount.
- Effect: `window.addEventListener("online", () => refresh())` — RN: use `NetInfo` reconnect.
- Effect: `warmProfileImage(user?.image)` whenever image changes — **web-only** (service worker
  postMessage + Cache Storage API prefetch of the avatar). RN: drop or replace with an
  `Image.prefetch(uri)` / expo-image disk cache warm.
- Effect: listens for `API_AUTH_REQUIRED_EVENT` (`"spotify:api-auth-required"`, dispatched by
  `api.ts` on a `401`). Handler bumps generation, invalidates caches, writes signed-out, sets
  user=null / status=unauthenticated. **This is the global "your cookie expired, force logout"
  path.** RN: replace the window CustomEvent with an app-level emitter that the api layer fires.
- Effect: `setOfflineAccountScope(user?.id ?? status)` — keeps the offline store's per-account
  cache namespace in sync (so account A's offline data never bleeds into account B).
- Effect: when `user?.id` changes, calls `useLikesStore.getState().resetRemote()` — **clears all
  remote likes on account switch / logout** (keeps only local-song likes). Critical cross-store
  invariant: porting must preserve "switching accounts wipes the previous account's likes".

### 1.7 Actions

- `signIn(email, password)` — POST signin; on success bumps generation, invalidates caches, writes
  cached user, `setOfflineAccountScope(nextUser.id)`, sets state authenticated.
- `signOut()` — bumps generation, POST signout (ignored on failure), invalidates caches,
  `writeCachedAuthUser(null,{signedOut:true})`, `setOfflineAccountScope("unauthenticated")`, clears
  state. **Local-first: state is cleared even if the network call fails.**
- `updateProfileImage(file)` — see §1.3. On success updates cached user + warms image.
- `resendVerification()` — POST; throws on non-OK.

### 1.8 Web-only helpers to rewrite/drop in RN

- `warmProfileImage` / `sameOriginUrl` — Cache Storage + service worker. DROP or replace with
  `expo-image` prefetch.
- `clearServiceWorkerApiCache` — posts `{ type:"CLEAR_RUNTIME_CACHE" }` to the SW. DROP (no SW in RN).
- `isKnownOffline` — `navigator.onLine`. Replace with `NetInfo`.
- `readLocalOfflineAuthUser` — `window.location.hostname` LAN check. DROP/reconsider.

---

## 2. Discover-keep — `src/client/discover-keep.ts`

Single export. "Keeping" a staged Discover track (liking, adding to playlist, or downloading) must
first **promote** it out of the Mac-mini's hidden `.discover` staging cache into the real library,
because you can't like/own a song that isn't scanned into the library yet.

```ts
export async function promoteStagedSong(song: PlayerSong): Promise<PlayerSong | null>
```

Logic:
- If `!song.discoverTrackId` → return `song` unchanged (it's already a real library song; not staged).
- Else `POST /api/discover/promote` (cookie auth), JSON body:
  ```json
  { "trackId": song.discoverTrackId, "finalId": song.id }
  ```
  - `finalId` exists for **idempotency**: if the track was already promoted (no longer staged), the
    server returns the existing library song instead of re-creating.
- Response: a `PlayerSong` JSON. Considered valid only if `promoted.id` AND `promoted.audioUrl` are
  present.
- On success: `usePlayerStore.getState().replaceStagedSong(song.id, promoted)` — swaps the library
  copy into the current player queue so subsequent loads use the stable id + library `audioUrl`.
- Returns: the promoted song, the original (if not staged), or `null` on `!res.ok` / bad payload /
  thrown error. **Callers MUST abort the keep action when null** (the likes store does — see §3.6).

### Endpoint summary

| Method & Path | Body | Response | Failure |
|---|---|---|---|
| `POST /api/discover/promote` | `{ trackId: string, finalId: string }` | `PlayerSong` (must have `id` + `audioUrl`) | non-OK / bad payload → `null`; idempotent on already-promoted |

PORTING HAZARDS: relative URL + cookie auth (§0). `usePlayerStore.replaceStagedSong` is a cross-store
call — ensure the player store is ported. The `discoverTrackId` field on `PlayerSong` is the staging
marker.

---

## 3. Likes store — `src/store/likes.ts` (COMPLETE)

Zustand store. `"use client"` directive at top (Next-ism, irrelevant in RN — drop). This store is
the most logic-dense file; document fully.

### 3.1 State shape

```ts
type LikesState = {
  likedSongIds: Record<string, true>;   // set-as-object: liked id -> true. Includes BOTH remote and local-song likes.
  pending: Record<string, true>;        // ids with an in-flight toggle (POST/DELETE not yet resolved)
  hydrated: boolean;                     // becomes true after first mergeInitial / any toggle
  mergeInitial: (ids: string[]) => void;
  resetRemote: () => void;
  toggleLike: (songId: string, nextLiked: boolean, song?: PlayerSong) => Promise<LikeToggleResult>;
};

type LikeToggleResult = { ok: boolean; status: number; error?: string };
```

Initial state: `likedSongIds: readLocalLikedSongIds()` (sync localStorage read at module init —
**hazard, see §3.7**), `pending: {}`, `hydrated: false`.

### 3.2 Constant + helpers

```ts
const LOCAL_LIKED_SONG_IDS_KEY = "spotify_local_liked_song_ids";   // localStorage array of local song ids
```

- `removeKey(source, key)` — returns new object without `key` (or the same ref if absent).
- `isLocalSongId(songId)` — **`songId.startsWith("browser-local:") || songId.startsWith("picked-file:")`**.
  These are user's own local files (uploaded via browser / file picker) — they have **no server
  record**, so their likes are persisted **only in localStorage**, never sent to `/api/likes`.
- `readLocalLikedSongIds()` — parses the localStorage array, keeps only entries passing
  `isLocalSongId`. Returns `Record<string,true>`. (`window` guard → `{}`.)
- `writeLocalLikedSongIds(map)` — writes back **only** the keys passing `isLocalSongId`
  (filters out remote ids so the local store never persists server-backed likes).

### 3.3 `syncAutoDownloadLiked(songId, nextLiked, song)` — auto-download-on-like

Fire-and-forget; must never block/fail the like toggle.
- Reads `useOfflineStore.getState()`. If `!offline.autoDownloadLiked` → no-op.
- If `nextLiked` and a `song` object is provided → `void offline.queueDownloads([song], "liked")`
  (pins it for offline under the `"liked"` scope).
- If `!nextLiked` → `void offline.unpinScope(songId, "liked")`.
- Signatures: `queueDownloads(songs: PlayerSong[], scope: DownloadScope) => Promise<void>`,
  `unpinScope(songId: string, scope: DownloadScope) => Promise<void>`. Scope literal: `"liked"`.

### 3.4 `mergeInitial(ids)` — hydrate from server list (merge, don't clobber)

Builds `next`:
1. Carry over all existing **local-song** likes (`isLocalSongId`) from current state.
2. Add every valid string id from the incoming server `ids`.
3. **Preserve in-flight optimistic toggles:** for each id in `pending`, apply the optimistic
   direction from `current` over the incoming list — if `current[id]` keep it, else delete it. This
   stops a hydrate from clobbering a like/unlike the server doesn't know about yet.
4. Diffs `current` vs `next` (length change or any new key). Only `set` if changed; if unchanged but
   not yet hydrated, set `hydrated:true`.

Invariant: `mergeInitial` is **additive + optimistic-safe**; it never drops a local-song like and
never reverts a pending optimistic change.

### 3.5 `resetRemote()` — drop all server likes (on account switch/logout)

- Rebuilds `likedSongIds` keeping **only local-song** ids.
- `writeLocalLikedSongIds(next)`, then `set({ likedSongIds: next, pending: {}, hydrated: true })`.
- Called by the auth provider's account-change effect (§1.6).

### 3.6 `toggleLike(songId, nextLiked, song?)` — THE optimistic toggle (full flow)

Returns `LikeToggleResult`. Step by step:

1. **Guard invalid id** → `{ ok:false, status:400, error:"Invalid song id" }`.
2. **Guard already-pending** (`pending[songId]`) → `{ ok:false, status:0, error:"Like is still updating" }`.
   (Prevents double-fire while a toggle is in flight.)
3. **No-op guard:** if `prevLiked === nextLiked` → `{ ok:true, status:200 }` (nothing to do).
4. `void impactLight()` — haptic on every real toggle (see §5).
5. **Local-song branch** (`isLocalSongId(songId)`): update `likedSongIds` (add/remove), set
   `hydrated:true`, `writeLocalLikedSongIds(...)`. Return `{ ok:true, status:200 }`. **No network.**
6. **Optimistic update (remote):** immediately set `likedSongIds` to reflect `nextLiked`, add
   `songId` to `pending`, `hydrated:true`. UI heart responds instantly even before the network /
   promote round-trip.
7. **Discover keep / promote** (only when `nextLiked && song?.discoverTrackId`):
   - `const promoted = await promoteStagedSong(song)` (§2).
   - If `promoted` is null → **roll back** (`likedSongIds` to `prevLiked`, remove from `pending`) and
     return `{ ok:false, status:502, error:"Couldn't save this track" }`.
   - If `promoted.id !== songId` (id changed on promotion) → **move the optimistic like onto the new
     id**: remove old id from `likedSongIds`+`pending`, add `promoted.id` to both. Then reassign
     local vars `song = promoted; songId = promoted.id;` so the rest of the flow uses the new id.
8. **Capture account scope BEFORE the await:** `const accountScope = getOfflineAccountScope()`.
   Invariant: reading it after the fetch could patch the **wrong account's** caches if the user
   switched accounts mid-request.
9. **Network:** `fetch("/api/likes", { method: nextLiked ? "POST" : "DELETE", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ songId }), credentials:"include", cache:"no-store" })`.
   - **Not OK:** roll back to `prevLiked`, remove from `pending`. Try to parse `{ error }` from body
     for the message. Return `{ ok:false, status: response.status, error: message }`.
   - **OK:** remove from `pending` (keep optimistic like), `patchLikeApiCache(songId, nextLiked, song, accountScope)`,
     `syncAutoDownloadLiked(...)`. Return `{ ok:true, status: response.status }`.
10. **catch (network failure / offline)** — OFFLINE-MUTATION-QUEUE FALLBACK:
    - `await queueOfflineMutation({ type:"like", payload:{ songId, nextLiked, song } })` (IndexedDB
      queue in `offline.ts`). On success: remove from `pending`, `patchLikeApiCache(...)`,
      `syncAutoDownloadLiked(...)`, return **`{ ok:true, status:202 }`** (202 = "queued, will sync").
      **Keeps the optimistic like** — the queue replays it when back online.
    - If queueing itself throws → **roll back** to `prevLiked`, remove from `pending`, return
      `{ ok:false, status:0, error: <message or "Failed to update like"> }`.

### 3.7 Likes-store PORTING HAZARDS (explicit)

- **`fetch("/api/likes")` is a RELATIVE URL** (line ~190). Called from a Zustand store outside React.
  This is the marquee hazard called out in the task. In RN it must become
  `fetch(\`${API_BASE}/api/likes\`, …)`. Same for the cookie reliance (`credentials:"include"`).
- **`impactLight()` Capacitor haptics import hazard:** `toggleLike` calls `impactLight()` from
  `@/lib/haptics`, which **dynamically `import("@capacitor/haptics")`** (§5). Even though it's
  guarded by `isNativeCapacitorApp()`, the **bundler still resolves the import**. In an Expo bundle
  `@capacitor/haptics` does not exist → must be swapped for `expo-haptics`. Do not leave the
  Capacitor import path in the RN tree.
- **`localStorage` (sync)** for local-song likes: `readLocalLikedSongIds()` runs at module-eval time
  inside `create(...)`. AsyncStorage is async → seed `{}` and hydrate after mount, or use MMKV
  (sync) to preserve the current behavior.
- **`queueOfflineMutation` → IndexedDB** (`offline.ts` uses `idbPut(MUTATION_STORE, …)`). RN has no
  IndexedDB; the offline queue must be reimplemented (AsyncStorage/SQLite/MMKV). It also dispatches
  a `window` CustomEvent (`OFFLINE_SYNC_EVENT`) and uses an AbortController-based `mutationFetch`.
- **`patchLikeApiCache(songId, nextLiked, song, accountScope)`** (from `api.ts`) — surgically
  patches the in-memory `apiCache` entries for paths `"/api/home"`, `"/api/liked"`, `"/api/likes"`,
  and any `"/api/playlist/*"`, but **only entries whose auth scope matches `accountScope`**. For
  `/api/liked` it also splices the full song object into the liked list. This in-memory cache layer
  must be ported alongside (or replaced by your RN data cache, e.g. React Query, with equivalent
  optimistic cache mutation).
- **Cross-store calls:** `useOfflineStore.getState()`, `usePlayerStore.getState()` (via
  promoteStagedSong), `getOfflineAccountScope()`. Port those stores together.

---

## 4. Offline / API symbols this flow depends on (quoted from source)

For the implementer, the exact contracts the above relies on:

- `API_AUTH_REQUIRED_EVENT = "spotify:api-auth-required"` (`api.ts:27`); dispatched on a `401` via
  `window.dispatchEvent(new CustomEvent(API_AUTH_REQUIRED_EVENT, { detail: { url } }))` (`api.ts:176`).
- `invalidateApiCache(match?: string | RegExp | ((url: string) => boolean)): void` (`api.ts:357`).
- `patchLikeApiCache(songId, nextLiked, song?, accountScope?): void` (`api.ts:273`) — see §3.7.
- `getOfflineAccountScope(): string` (`offline.ts:257`); `setOfflineAccountScope(scope: string | null | undefined): void` (`offline.ts:1454`).
- `queueOfflineMutation(mutation): Promise<OfflineMutation>` (`offline.ts:1663`) — fills in
  `id/status:"queued"/attempts:0/createdAt/updatedAt/accountScope`, `idbPut`s to `MUTATION_STORE`,
  updates snapshots, dispatches `OFFLINE_SYNC_EVENT`, kicks `syncMutations()`.
- `useOfflineStore` actions: `autoDownloadLiked: boolean`, `queueDownloads(songs, scope)`,
  `unpinScope(songId, scope)`. `DownloadScope` includes `"liked"`.

---

## 5. Haptics — `src/lib/haptics.ts`

Thin wrapper over Capacitor Haptics, lazily imported.

```ts
type HapticsModule = typeof import("@capacitor/haptics");
let hapticsModule: Promise<HapticsModule> | null = null;
function loadHaptics() { hapticsModule ??= import("@capacitor/haptics"); return hapticsModule; }

export async function impactLight(): Promise<void>   // guard isNativeCapacitorApp(); Haptics.impact({ style: ImpactStyle.Light })
export async function selectionTap(): Promise<void>  // selectionStart() → selectionChanged() → selectionEnd()
```

- Both no-op when `!isNativeCapacitorApp()`.
- Both swallow all errors ("Haptics must never break a tap").
- `impactLight` is called by the likes toggle (§3.6 step 4).

**PORTING:** Replace the entire module with `expo-haptics`:
`impactLight` → `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)`;
`selectionTap` → `Haptics.selectionAsync()`. Drop `isNativeCapacitorApp()` gating (or gate on
`Platform.OS !== "web"` if you ship web). Keep the try/catch "never throw" contract.

---

## 6. Podcast progress — `src/client/podcast-progress.ts`

Pure module that persists per-episode resume positions in `localStorage`.

### 6.1 Type + constants (verbatim)

```ts
export type PodcastEpisodeProgress = { time: number; duration: number; updatedAt: number };

export const PODCAST_PROGRESS_STORAGE_KEY = "spotify_podcast_progress";   // localStorage key (map id->progress)
export const PODCAST_PROGRESS_MAX_ENTRIES = 200;                          // LRU cap, evict oldest by updatedAt
export const PODCAST_FINISHED_TAIL_SECONDS = 30;                          // within 30s of end ⇒ finished
export const PODCAST_SHORT_EPISODE_SECONDS = 60;                          // episodes ≤60s use ratio rule
export const PODCAST_SHORT_EPISODE_FINISHED_RATIO = 0.95;                 // short episode finished at ≥95%
```

### 6.2 Write / resume / finish thresholds

- `isEpisodeFinished(progress)`:
  - `duration <= 0` → `false`.
  - **Short episode** (`duration <= 60s`): finished when `time >= duration * 0.95`.
  - **Normal episode** (`duration > 60s`): finished when `time > duration - 30`.
  - Purpose: resume should not restart a completed episode at its very end (outro/credits), and very
    short episodes have no meaningful tail so they need ~full playback to count finished.
- `readEpisodeProgress(id): PodcastEpisodeProgress | null` — `null` for empty id / missing entry.
- `readAllEpisodeProgress(): Record<string, PodcastEpisodeProgress>` — whole map.
- `writeEpisodeProgress(id, time, duration)`:
  - Guards: `!id` or `time` not finite or `time < 0` → no-op.
  - `duration`: uses given duration only if finite and `> 0`, else keeps the existing entry's
    duration, else `0`. `updatedAt = Date.now()`.
- `markEpisodeFinished(id)` — only if an entry exists with `duration > 0`; sets `time = duration`,
  bumps `updatedAt`.
- `clearEpisodeProgress(id)` — deletes the entry if present.

### 6.3 Storage internals + eviction

- `readProgressMap()` — JSON-parse `localStorage[KEY]`; rejects non-object/array; validates each
  entry via `coerceProgress` (time/duration finite & ≥0, updatedAt finite). Any failure → `{}`.
- `writeProgressMap(map)` — if entries > **200**, sort by `updatedAt` desc and truncate to 200
  (drops least-recently-updated). Serializes back to localStorage.
- `coerceProgress` enforces: `time` number/finite/≥0; `duration` number/finite/≥0; `updatedAt`
  number/finite.

### 6.4 PORTING HAZARDS

- **All persistence is sync `localStorage`** + `window` guard. Replace with AsyncStorage (async — the
  currently-sync `readEpisodeProgress`/`writeEpisodeProgress` callers must adapt) or MMKV (sync,
  drop-in). Keep the 200-entry LRU eviction and the same JSON map shape (`{ [id]: {time,duration,updatedAt} }`).
- No network — purely local; no cookie/auth concerns. The thresholds (30s tail, 60s short cutoff,
  0.95 ratio, 200 cap) are the load-bearing constants to preserve exactly.

---

## 7. Quick port checklist for this slice

- [ ] Define `API_BASE` and prefix EVERY relative `fetch("/api/...")` (auth, likes, discover, profile).
- [ ] Replace cookie auth (`credentials:"include"`) with an RN cookie jar or token scheme.
- [ ] Swap `@capacitor/haptics` → `expo-haptics` in `haptics.ts` (and ensure no Capacitor import
      survives in the bundle path of `likes.ts`).
- [ ] Replace `localStorage` (auth cache, signed-out flag, local liked ids, podcast map) with
      AsyncStorage/MMKV; rework sync `useState(() => …)` / `create(…)` seeding into post-mount hydration.
- [ ] Replace `navigator.onLine` + `online` event + `CustomEvent` bus with `NetInfo` + a JS emitter.
- [ ] Drop service-worker / Cache Storage profile-image warming; use `expo-image` prefetch if desired.
- [ ] Reimplement the IndexedDB offline mutation queue (`offline.ts`) on RN storage.
- [ ] Port `usePlayerStore.replaceStagedSong`, `useOfflineStore` (autoDownloadLiked/queueDownloads/
      unpinScope/account scope), and `api.ts` `patchLikeApiCache`/`invalidateApiCache` (or replace
      with React Query optimistic cache updates).
- [ ] Preserve the auth `generation` staleness guard and the `resetRemote()`-on-account-switch invariant.
- [ ] Handle verify-email **302** via deep link / universal link → call `refresh()` on return.
