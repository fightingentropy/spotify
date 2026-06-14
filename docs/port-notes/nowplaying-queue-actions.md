# Port Notes — Now Playing / Queue / Track Actions

Reconstruction-grade reference for porting the now-playing surface to Expo / React Native (NativeWind + Zustand). Covers six source files plus the cross-cutting state and CSS they depend on. Every Tailwind class string is quoted verbatim. Web-only primitives are flagged inline and summarized at the end.

Files documented:
- `src/components/NowPlayingSheet.tsx`
- `src/components/QueueSheet.tsx`
- `src/components/TrackActionsMenu.tsx`
- `src/components/MarqueeText.tsx`
- `src/lib/playback-gesture.ts`
- `src/lib/use-modal-dialog.ts`

Shared dependencies pulled in for context (signatures + invariants only): `src/store/player.ts`, `src/types/player.ts`, `src/lib/player-song.ts`, `src/lib/haptics.ts`, `src/client/styles.css` (the `wf-*` utility classes + keyframes).

---

## 0. Shared building blocks the implementer must port first

### 0.1 `PlayerSong` type (`src/types/player.ts`)
```ts
type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
  networkImageUrl?: string;   // remote-cover fallback when imageUrl is a device-local file
  audioUrl: string;
  lyricsUrl?: string;
  description?: string;       // podcast episode description
  link?: string;
  createdAt?: string;
  duration?: number;
  audioBitDepth?: number;
  audioSampleRate?: number;
  source?: "server" | "browser-local" | "picked-file" | "radio" | "podcast" | "offline";
  localPath?: string;
  writable?: boolean;
  staged?: boolean;           // Discover Top-50 track not yet in library
  discoverTrackId?: string;   // Spotify track id for /api/discover/promote
};
```

### 0.2 `usePlayerStore` (Zustand) — full state shape (`src/store/player.ts`)
State fields read/written by the components below:
```ts
queue: PlayerSong[];
currentIndex: number;          // -1 when nothing loaded
currentSong: PlayerSong | null;
playHistory: number[];         // queue indices visited, for previous() under shuffle
playFuture: number[];          // redo stack: indices to revisit (top = last element)
shuffleRemaining: number[];    // shuffle pool, indices not yet played this cycle
isPlaying: boolean;
volume: number;                // 0..1
isMuted: boolean;
shuffle: boolean;
repeatMode: "off" | "one" | "all";
crossfadeEnabled: boolean;
crossfadeSeconds: number;      // 0..12
playbackRate: number;          // 0.5..3, applied to podcast playback only
sleepTimerEndsAt: number | null;   // epoch ms; in-memory only, never persisted
sleepAtEndOfTrack: boolean;
```

Actions used by these components (exact signatures):
- `play(): void` — sets `isPlaying: true`
- `pause(): void` — sets `isPlaying: false`
- `toggle(): void`
- `next(): void`
- `previous(): void`
- `toggleShuffle(): void` — flips shuffle, clears `playHistory`/`playFuture`, rebuilds `shuffleRemaining`, persists to `localStorage["spotify_shuffle_enabled"]`
- `cycleRepeatMode(): void` — order is `off -> all -> one -> off`, persists to `localStorage["spotify_repeat_mode"]`
- `setPlaybackRate(rate: number): void` — clamps to 0.5..3, persists to `localStorage["spotify_playback_rate"]`
- `startSleepTimer(minutes: number): void` — `sleepTimerEndsAt = Date.now() + minutes*60000`, clears `sleepAtEndOfTrack`
- `setSleepAtEndOfTrack(): void` — `sleepTimerEndsAt = null`, `sleepAtEndOfTrack = true`
- `cancelSleepTimer(): void` — clears both
- `addToQueue(song): void` — appends; if shuffle, also pushes new index into `shuffleRemaining`; if queue empty, sets current but leaves paused
- `playNext(song): void` — inserts at `currentIndex + 1`; remaps history/future/remaining indices; under shuffle also pushes the inserted index onto `playFuture`
- `removeFromQueue(index): void` — no-op for `index === currentIndex` or out of range; remaps all index arrays via `remapQueueIndices(..., -1)`
- `advanceToIndex(index, options?: { fromFuture?: boolean; preservePlayState?: boolean }): void` — jump to a queue index; under shuffle consumes a `playFuture` entry iff `fromFuture && playFuture.top === index`, else treats as fresh pick (clears `playFuture`, drops `index` from `shuffleRemaining`)

Exported helpers used in the UI:
- `formatPlaybackRate(rate): string` -> `` `${rate}×` `` (note: real `×` U+00D7, not `x`)
- `nextPlaybackRate(rate): number` — cycles `PLAYBACK_RATE_CYCLE = [1, 1.25, 1.5, 1.75, 2, 0.75]`
- `sleepTimerRemainingMinutes(endsAt, now = Date.now()): number` -> `Math.max(1, Math.ceil((endsAt - now) / 60000))`

**PORTING HAZARD (store):** every persisted setting (`shuffle`, `volume`, `muted`, `repeatMode`, `crossfadeEnabled`, `crossfadeSeconds`, `playbackRate`) reads/writes `localStorage` synchronously inside lazy initializers and setters with `typeof window !== "undefined"` guards. In RN there is no `localStorage`. Replace each `readStoredX`/`writeStoredX` with `AsyncStorage` (async — so seed defaults synchronously then hydrate) or `expo-secure-store`/MMKV (sync, preferred to keep the lazy-init pattern). `sleepTimerEndsAt`/`sleepAtEndOfTrack` are intentionally in-memory and need no persistence.

**INVARIANT:** the QueueSheet "Up Next" ordering must match `next()` exactly — under shuffle, the redo stack (`playFuture`, top first) is consumed before the shuffle pool (`shuffleRemaining`). See §2.4.

### 0.3 Offline resolver (`src/client/offline.ts`)
`resolveOfflinePlaybackSong(song)` returns the same song unless a *downloaded* offline record exists for `song.id` and the current account, in which case it swaps `audioUrl`/`imageUrl`/`lyricsUrl` to device-local URLs and sets `networkImageUrl` to the remote cover fallback. Every component below resolves the song through this before rendering covers / dispatching playback. The selector dependency is always `offlineRecords` / `state.records[song.id]` (so memo recomputes when downloads change).
**PORTING:** offline records and their `nativeFiles` web URLs are Capacitor-filesystem specific. For Expo, back this with `expo-file-system` document-directory URIs; the resolver's *contract* (swap URLs when downloaded) stays the same.

### 0.4 Haptics (`src/lib/haptics.ts`)
`impactLight()` and `selectionTap()` are async, no-op unless `isNativeCapacitorApp()`, dynamically import `@capacitor/haptics`, and never throw. Used on play/pause toggle, cover-swipe commit, opening the actions sheet, and running an action.
**PORTING:** replace with `expo-haptics` (`Haptics.impactAsync(ImpactFeedbackStyle.Light)`). Keep the "never break a tap" try/catch.

### 0.5 `wf-*` CSS classes (`src/client/styles.css`) — needed to reproduce the look/animation
These class names appear verbatim in the JSX. NativeWind has no `@keyframes`/CSS-var animation; reproduce with `react-native-reanimated` / `Animated`.

- `body.wf-now-playing-open { overflow: hidden; }` — global scroll lock while any sheet open. **HAZARD: no `<body>` in RN; the sheets are full-screen modals so a scroll lock is implicit. Drop entirely.**
- `.wf-pressable` — `transform: translateZ(0)` + transitions on transform/bg/border/shadow/opacity 160–180ms. `:active:not(.wf-list-row)` -> `transform: scale(0.985)`.
- `.wf-control-button` — same transitions (adds `color`). `:active` -> `scale(0.985)`. (This is the press-shrink on every icon button.)
- `.wf-list-row` — `transition: background-color 170ms, opacity 170ms`.
- `.wf-sheet-backdrop` — `transition: opacity 280ms ease`.
- `.wf-now-playing-panel` — `transition: transform 360ms cubic-bezier(0.16,1,0.3,1), opacity 260ms, border-color 260ms; will-change: transform, opacity`.
  - `.wf-now-playing-panel[data-open="false"]` — close uses `cubic-bezier(0.4,0,1,1)` for transform with a 120ms opacity delay (glides off instead of blinking).
- `.wf-now-playing-art` — entrance animation `wf-cover-settle 520ms cubic-bezier(0.16,1,0.3,1) both` (`from { opacity:0; translateY(14px) scale(0.965) } to { opacity:1; translateY(0) scale(1) }`).
- Reduced-motion media query zeroes all of the above; honor `useReducedMotion()` in RN.

Marquee classes (see §4):
```css
.wf-marquee { overflow: hidden; white-space: nowrap; max-width: 100%; min-width: 0; }
.wf-marquee-inner { display: inline-block; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.wf-marquee-active .wf-marquee-inner { max-width: none; overflow: visible; animation: wf-marquee-scroll var(--wf-marquee-duration, 9s) linear infinite; animation-delay: 1.5s; }
.wf-marquee-active { mask-image: linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent); }  /* + -webkit- */
@keyframes wf-marquee-scroll {
  0%, 12% { transform: translateX(0); }
  78%, 92% { transform: translateX(calc(-1 * var(--wf-marquee-distance, 0px))); }
  100% { transform: translateX(0); }
}
```

---

## 1. `NowPlayingSheet.tsx` — full-screen now-playing surface

### 1.1 Props
```ts
{
  open: boolean;
  escapeDisabled?: boolean;   // true while the QueueSheet is stacked on top; suspends this sheet's Escape + focus trap
  onClose: () => void;
  onOpenQueue: () => void;
  song: PlayerSong;
  isPlaying: boolean;
  currentTime: number;        // seconds
  duration: number;           // seconds
  onSeek: (value: number) => void;
}
```
Owner is `PlayerBar.tsx` (passes live `currentTime`/`duration`/`onSeek` from the audio engine; this sheet does NOT own the audio element).

### 1.2 Store / data sources
- `usePlayerStore`: `play, pause, next, previous, shuffle, repeatMode, toggleShuffle, cycleRepeatMode, sleepTimerEndsAt, sleepAtEndOfTrack, playbackRate, setPlaybackRate, startSleepTimer, setSleepAtEndOfTrack, cancelSleepTimer`.
- `useLikesStore`: `toggleLike, likedSongIds (likedLookup), pending (pendingLookup), hydrated (likesHydrated)`.
- `useOfflineStore`: `records` (drives `resolveOfflinePlaybackSong`).
- `useLyrics(id, lyricsUrl, enabled)` from `src/lib/credits` — prefetched whenever `open && lyricsAvailable`.
- `parseCredits(artist)` -> `[{ name, role }]` (desktop credits card only).

### 1.3 Local state / refs
- `showLyrics` (bool), `sleepMenuOpen` (bool), `setSleepTimerTick` (UI-only 30s ticker to refresh the remaining-minutes label).
- `touchStartYRef`, `swipeDismissAllowedRef`, `scrollContainerRef`, `panelRef`.
- Cover-swipe: `coverSwipeRef = { startX, startY, axis: "x"|"y"|null, dx }`, `coverDragX` (number, live translateX), `coverSwiping` (bool).

Derived:
- `liveStream = isRadioSong(song)`, `podcastEpisode = isPodcastSong(song)`, `showLibraryActions = !liveStream && !podcastEpisode`.
- `songIsLiked`, `likePending`, `podcastDescription`.
- `progress = duration > 0 ? clamp(0..100, currentTime/duration*100) : 0`.
- `lyricsAvailable = !!lyricsSong.lyricsUrl`, `lyricsViewOpen = showLyrics && lyricsAvailable`.
- `sleepTimerActive = sleepTimerEndsAt != null || sleepAtEndOfTrack`.
- `sleepTimerRemaining` via `sleepTimerRemainingMinutes`.
- `sleepTimerTitle` = `Sleep timer: ${n} min left` | `Sleep timer: end of track` | `Sleep timer`.

### 1.4 Component tree (rendered)
```
div  (fixed overlay; aria-hidden={!open})
├── button  (backdrop, desktop-only — hidden on mobile)
└── section[role=dialog][data-open]  (the sliding panel; onTouchStart/End = swipe-to-dismiss)
    ├── div (scrollContainerRef, scrollable)
    │   └── div (padding wrapper, flex col)
    │       ├── div  HEADER ROW
    │       │   ├── button  ChevronDown (collapse/close)
    │       │   └── div  header actions (right)
    │       │       ├── [showLibraryActions] OfflineSongDownloadButton + Like button (Heart)
    │       │       ├── [lyricsAvailable] Lyrics toggle (MicVocal)
    │       │       ├── Sleep-timer button (Moon + active dot)
    │       │       └── Queue button (ListMusic)
    │       ├── div  CENTER (flex-1, centered)
    │       │   ├── div  "Now Playing" eyebrow
    │       │   ├── [lyricsViewOpen] <LyricsPanel/>  ELSE  cover (swipeable) <CoverImage/>
    │       │   ├── div  title/artist (two <MarqueeText/>)
    │       │   ├── [liveStream] LIVE bar  ELSE  scrubber (<input type=range>) + time labels
    │       │   └── div  TRANSPORT ROW (shuffle | prev/play/next | repeat)
    │       └── [showLibraryActions] Credits card (desktop-only)  |  [podcastEpisode] Podcast card w/ speed chip
    ├── button  sleep-timer backdrop (inside section)
    └── div[role=dialog]  SLEEP-TIMER bottom sheet
```

### 1.5 Verbatim className strings

Root overlay (uses `cn()` helper = clsx/tailwind-merge):
```
fixed inset-0 z-50 transition
```
+ conditional `pointer-events-auto` (open) / `pointer-events-none` (closed).

Backdrop button:
```
wf-sheet-backdrop absolute inset-0 bg-black/60 transition-opacity lg:block
```
+ `opacity-100`/`opacity-0`, + `hidden lg:block`. **NOTE: backdrop is desktop-only; on mobile the panel fills the screen.**

Panel `<section>`:
```
wf-now-playing-panel absolute overflow-hidden bg-background
```
+
```
inset-0 lg:inset-auto lg:left-0 lg:right-0 lg:top-14 lg:bottom-[84px] lg:mx-auto lg:max-w-3xl lg:border lg:border-black/10 lg:dark:border-white/10 lg:bg-background/95 lg:backdrop-blur-lg lg:rounded-t-2xl
```
+ open -> `translate-y-0 opacity-100`, closed -> `translate-y-full opacity-0 lg:translate-y-8 lg:opacity-0`.
(On mobile the open/close is a vertical slide of the whole screen.)

Scroll container:
```
h-full overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:pt-0 lg:pb-0
```

Padding wrapper:
```
p-4 sm:p-6 min-h-full flex flex-col
```

Header row:
```
flex items-center justify-between mb-4 lg:mb-4
```

Collapse button (ChevronDown size=24):
```
wf-control-button h-11 w-11 -ml-1 rounded-full grid place-items-center active:bg-black/10 dark:active:bg-white/10 touch-manipulation
```

Header actions container:
```
-mr-1 flex items-center gap-1
```

OfflineSongDownloadButton (passed className):
```
wf-control-button h-11 w-11 text-foreground/70 active:bg-black/10 dark:active:bg-white/10
```

Like button (Heart size=22):
```
h-11 w-11 rounded-full grid place-items-center touch-manipulation
wf-control-button
```
+ `opacity-60` when `likePending`, else `active:bg-black/10 dark:active:bg-white/10`; + `text-emerald-500` when liked else `text-foreground/70`. Heart icon gets `fill-emerald-500 text-emerald-500` when liked. `disabled={!likesHydrated || likePending}`.

Lyrics toggle (MicVocal size=22):
```
wf-control-button h-11 w-11 rounded-full grid place-items-center active:bg-black/10 dark:active:bg-white/10 touch-manipulation
```
+ `text-emerald-500` (open) / `text-foreground/70`. `aria-pressed={lyricsViewOpen}`.

Sleep-timer button (Moon size=20):
```
wf-control-button relative h-11 w-11 rounded-full grid place-items-center active:bg-black/10 dark:active:bg-white/10 touch-manipulation
```
+ `text-[#1ed760]` (active) / `text-foreground/70`. Active-dot `<span>`:
```
absolute bottom-1.5 h-1 w-1 rounded-full bg-[#1ed760] transition-opacity
```
+ `opacity-100`/`opacity-0`.

Queue button (ListMusic size=22):
```
wf-control-button h-11 w-11 rounded-full grid place-items-center text-foreground/70 active:bg-black/10 dark:active:bg-white/10 touch-manipulation
```

Center column:
```
flex-1 flex flex-col justify-center gap-6 lg:gap-5 max-w-md mx-auto w-full
```

"Now Playing" eyebrow:
```
-mb-2 text-center text-xs uppercase tracking-wide opacity-70
```

LyricsPanel (when lyrics open) className:
```
mx-auto aspect-square w-full shadow-2xl shadow-black/30
```
(same square footprint as the art so toggling never reflows).

Cover wrapper (swipeable) — outer div has inline `style`:
```js
transform: coverDragX ? `translateX(${coverDragX}px)` : undefined,
transition: coverSwiping ? "none" : "transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)",
touchAction: "pan-y",
```
className: `mx-auto w-full`. Inner art frame:
```
wf-now-playing-art w-full shadow-2xl shadow-black/30 rounded-2xl overflow-hidden
```
CoverImage (src `song.imageUrl || "/apple-icon.png"`, `networkSrc=song.networkImageUrl`, width/height 1200, `loading="eager"`):
```
w-full aspect-square object-cover
```

Title/artist block: `text-center lg:text-left`, then:
- `<MarqueeText text={song.title} className="text-2xl sm:text-3xl font-bold leading-tight" />`
- `<MarqueeText text={song.artist} className="text-lg opacity-80 mt-1" />`

Live-stream bar (radio): outer `space-y-2`; track `h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10`; fill `h-full w-full bg-emerald-500` + `animate-pulse` when playing; labels row `flex justify-between text-xs font-semibold text-emerald-400` with `<span>LIVE</span><span>Radio</span>`.

### 1.6 Scrubber (non-radio)
Container `space-y-2`. `<input type="range">`:
- `min={0} max={Math.max(0, duration)} step={0.1} value={currentTime}`
- `onChange` -> `onSeek(Number(event.target.value))`
- className:
```
w-full h-1 appearance-none rounded-full bg-black/10 dark:bg-white/10 accent-emerald-500 touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500
```
- inline `style.background` = linear-gradient filled to `${progress}%` with `rgb(16 185 129)` then `rgba(255,255,255,0.18)`.
Time labels row: `flex justify-between text-xs tabular-nums opacity-70` with `formatTime(currentTime)` / `formatTime(duration)`.

**PORTING:** `<input type=range>` does not exist in RN. Use `@react-native-community/slider` (or reanimated PanGesture). The gradient fill is the played portion — emulate via slider `minimumTrackTintColor=#10b981` (= `rgb(16 185 129)`) and `maximumTrackTintColor=rgba(255,255,255,0.18)`. Keep `formatTime` from `src/lib/utils`.

### 1.7 Transport row (the deliberate-gap layout)
Outer: `flex items-center justify-between px-2`. Three slots: shuffle (far left), the prev/play/next group (center), repeat (far right). The center group is its own flex with a real gap so a Next tap drifting left can't hit play/pause.

Shuffle button (Shuffle size=20):
```
wf-control-button relative h-11 w-11 rounded-full grid place-items-center touch-manipulation
```
+ `text-emerald-500` (on) / `text-foreground/70`. Active-dot span:
```
absolute bottom-1.5 h-1 w-1 rounded-full bg-emerald-500 transition-opacity
```
+ `opacity-100`/`opacity-0`.

Center group:
```
flex items-center gap-7
```
- Previous (SkipBack size=24) -> `onClick={previous}`:
```
wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation
```
- **Big play/pause** (size=26) -> `onClick={handleTogglePlayback}`:
```
wf-control-button h-14 w-14 rounded-full grid place-items-center bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 touch-manipulation
```
  Icon: `<Pause size={26}/>` when playing else `<Play size={26} className="translate-x-[2px]"/>` (the optical-center nudge).
- Next (SkipForward size=24) -> `onClick={next}`:
```
wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation
```

Repeat button (Repeat size=20) -> `onClick={cycleRepeatMode}`:
```
wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation
```
+ `text-emerald-500` when `repeatMode !== "off"` else `text-foreground/70`.
**NOTE:** repeat has NO distinct icon for `one` vs `all` — it only colors green when not off. The repeat-one *behavior* is enforced in `PlayerBar`, not here.

Key sizes to preserve: side controls **h-11 w-11 (44px)**, big play **h-14 w-14 (56px)**, center gap **gap-7 (28px)**.

`handleTogglePlayback()`: `impactLight()`; if playing -> `pause()`; else `requestImmediatePlayback(song)` then `play()`.

### 1.8 Credits card (desktop-only, `showLibraryActions`)
Wrapper `hidden lg:block lg:mt-5 space-y-4`; card `rounded-xl border border-black/10 dark:border-white/10 p-4 hidden lg:block`; header `font-medium mb-3` ("Credits"); list `space-y-3`; row `flex items-start justify-between gap-3` with name `font-medium`, role `text-sm opacity-70`, and `CheckCircle2 size={16} className="opacity-50 mt-1"`. **Mobile renders nothing here.** Likely skip for the RN port (or relocate).

### 1.9 Podcast card + speed control (`podcastEpisode`)
Wrapper:
```
mt-6 rounded-xl border border-black/10 p-4 dark:border-white/10 lg:mt-5
```
Row `flex items-center gap-3`. Icon chip `grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-fuchsia-500/15 text-fuchsia-200` with `Podcast size={18}`. Text block `min-w-0 flex-1` -> "Podcast Episode" (`font-medium`) + `song.artist` (`text-sm opacity-70`).
**Speed chip** -> `onClick={() => setPlaybackRate(nextPlaybackRate(playbackRate))}`:
```
wf-control-button h-9 shrink-0 rounded-full border border-black/15 px-3 text-sm font-semibold tabular-nums active:bg-black/5 dark:border-white/20 dark:active:bg-white/5 touch-manipulation
```
Label = `formatPlaybackRate(playbackRate)` e.g. `1.5×`. Tap cycles `1 → 1.25 → 1.5 → 1.75 → 2 → 0.75 → 1` (`PLAYBACK_RATE_CYCLE`). Range overall 0.75–2 in the UI (store clamps 0.5–3). Description (if present): `mt-3 line-clamp-4 text-sm leading-6 opacity-75`.

### 1.10 Sleep-timer bottom sheet (stacked inside the section)
`SLEEP_TIMER_MINUTE_OPTIONS = [5, 15, 30, 45, 60]` (constant at top of file). Plus an "End of track" option and (when active) "Turn off timer".

Inner backdrop button (`onClick` -> `setSleepMenuOpen(false)`):
```
absolute inset-0 z-30 cursor-default bg-black/60 transition-opacity
```
+ `opacity-100` (open) / `pointer-events-none opacity-0`. `tabIndex` toggles 0/-1.

Sheet `<div role=dialog>`:
```
absolute inset-x-0 bottom-0 z-40 rounded-t-2xl border-t border-black/10 bg-background pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-2xl transition-transform duration-300 dark:border-white/10
```
+ `translate-y-0` (open) / `pointer-events-none translate-y-full`.
Grab handle: `mx-auto mt-2 h-1 w-9 rounded-full bg-black/20 dark:bg-white/20`.
Header block `px-6 pb-1 pt-3 text-center`: title `text-sm font-semibold` ("Sleep timer") + subtitle `mt-0.5 text-xs` (+ `text-[#1ed760]` when active else `opacity-60`) reading `Music stops in ${n} min` / `Music stops at the end of this track` / `Stop the music after a while`.
Options container `px-3 pt-1`. Each minute option button:
```
wf-control-button flex h-12 w-full items-center rounded-lg px-3 text-[15px] active:bg-black/5 dark:active:bg-white/5 touch-manipulation
```
label `${minutes} minutes`; `onClick` -> `startSleepTimer(minutes); setSleepMenuOpen(false)`.
"End of track" button (same base, adds `justify-between` + `text-[#1ed760]` when `sleepAtEndOfTrack`):
```
wf-control-button flex h-12 w-full items-center justify-between rounded-lg px-3 text-[15px] active:bg-black/5 dark:active:bg-white/5 touch-manipulation
```
shows `<Check size={18}/>` when selected; `onClick` -> `setSleepAtEndOfTrack(); setSleepMenuOpen(false)`.
"Turn off timer" (only when `sleepTimerActive`) in a top-bordered wrapper `mt-1 border-t border-black/10 px-3 pt-1 dark:border-white/10`; button:
```
wf-control-button flex h-12 w-full items-center justify-center rounded-lg px-3 text-[15px] font-semibold text-[#1ed760] active:bg-black/5 dark:active:bg-white/5 touch-manipulation
```
`onClick` -> `cancelSleepTimer(); setSleepMenuOpen(false)`.

**Sleep-timer enforcement is NOT in this component** — the comment says expiry is handled in `PlayerBar`'s `timeupdate` handler + an 8s sync interval. This sheet only configures the store. Port the same split.

### 1.11 Interactions / effects (NowPlayingSheet)
1. **Escape key** (`useEffect`, skipped if `!open || escapeDisabled`): Escape closes the sleep menu first if open, else calls `onClose`. **HAZARD: `window.addEventListener("keydown")` — no keyboard on mobile; drop, or wire RN `BackHandler` (Android back button) to the same close-sleep-menu-then-close logic.**
2. **30s ticker** (`window.setInterval`, only while `open && sleepTimerEndsAt != null`) to refresh the remaining-min label. **HAZARD: `window.setInterval` — use plain `setInterval` in RN.**
3. **Body scroll lock** (`document.body.classList.add/remove("wf-now-playing-open")`, with a guard checking `document.querySelector('.wf-now-playing-panel[data-open="true"]')` so the lock survives while a stacked sheet is open). **HAZARD: `document`/DOM query — irrelevant in RN; sheets are full-screen modals. Drop.**
4. **Like** (`handleToggleLike`): no-op unless `showLibraryActions && likesHydrated && !likePending`; `await toggleLike(song.id, !songIsLiked, song)`; if result `!ok && status===401` -> `navigate("/signin")`. **HAZARD: `react-router-dom` `useNavigate` — replace with Expo Router / React Navigation.**
5. **Focus trap** via `useModalDialogFocus(open, panelRef, { enabled: !escapeDisabled })` — see §6. **Not needed in RN.**
6. **Swipe-down-to-dismiss** (whole panel): `handleTouchStart` records `touchStartY`; allowed only when scroll container is at top (`scrollTop <= 0`) AND the touch did not start on a `<input type=range>` (so dragging the scrubber down can't close). `handleTouchEnd`: if allowed and `endY - startY > 80` -> `onClose()`. **HAZARD: `TouchEvent`, `event.target instanceof HTMLInputElement`, `scrollContainerRef.scrollTop` are web. Reimplement with reanimated `Gesture.Pan()` + `ScrollView` `onScroll` offset, or a bottom-sheet lib (`@gorhom/bottom-sheet`).**
7. **Swipe-to-change-track on the artwork** (mobile): see §1.12.

### 1.12 Cover swipe-to-change-track (detailed)
`COVER_SWIPE_COMMIT_PX = 64`.
- `handleCoverTouchStart`: store `{startX, startY, axis:null, dx:0}`, `coverSwiping=true`.
- `handleCoverTouchMove`: compute `dx,dy`; if `axis===null`, wait until `|dx|>=8 || |dy|>=8` then lock `axis = |dx|>|dy| ? "x" : "y"`. If not `"x"`, bail (lets vertical swipe-to-dismiss/scroll win). If `"x"`: set `swipeDismissAllowedRef.current=false` (cancel dismiss), store `dx`, `setCoverDragX(dx)` so the art tracks the finger.
- `handleCoverTouchEnd` (also onTouchCancel): clear ref, `coverSwiping=false`, `setCoverDragX(0)`. If `axis==="x"`: `dx <= -64` -> `impactLight(); next()`; `dx >= +64` -> `impactLight(); previous()`. (Swipe **left = next**, **right = previous**.) Note `dx===0` rest snaps back via the 0.28s cubic-bezier transition.
**PORTING:** reimplement with reanimated horizontal `Gesture.Pan()`; lock axis the same way (8px threshold, |dx|>|dy|), commit at ±64px, translate the cover with a shared value, snap back with a spring/timing of ~280ms.

---

## 2. `QueueSheet.tsx` — playback queue (stacks on top of NowPlayingSheet)

### 2.1 Props
```ts
{ open: boolean; onClose: () => void; }
```

### 2.2 Store / data
- `usePlayerStore`: `queue, currentIndex, currentSong, shuffle, shuffleRemaining, playFuture, removeFromQueue`. Reads `usePlayerStore.getState()` directly in `handlePlayAt` for `advanceToIndex`.
- `useOfflineStore.records` for cover resolution.
- `requestImmediatePlayback` on tap-to-jump.

### 2.3 Local refs/state
`touchStartYRef`, `swipeDismissAllowedRef`, `scrollContainerRef`, `panelRef`. `useModalDialogFocus(open, panelRef)` (always enabled — this sheet owns the trap when on top). Same Escape `useEffect` (closes on Escape) and same body-scroll-lock `useEffect` as NowPlayingSheet (same DOM hazards).

### 2.4 Up-next ordering (`upNext = useMemo<QueueEntry[]>`) — INVARIANT
```ts
type QueueEntry = { song: PlayerSong; queueIndex: number };
```
- **Linear (not shuffle):** `queue.slice(currentIndex + 1)` mapped to `{ song, queueIndex: currentIndex + 1 + offset }`.
- **Shuffle:** dedup via a `seen` Set; `pushIndex(i)` skips out-of-range / `currentIndex` / already-seen. Push order: **first** `playFuture` *from top* (`for i = playFuture.length-1 .. 0`), **then** every index in `shuffleRemaining` (array order). This exactly mirrors `next()` (redo stack before pool). Deps: `[currentIndex, playFuture, queue, shuffle, shuffleRemaining]`.

### 2.5 Component tree
```
div (fixed overlay)
├── button backdrop (desktop-only)
└── section[role=dialog][data-open]  (slide panel, swipe-down-to-dismiss)
    └── div (scroll container)
        └── div (padding)
            ├── header row: ChevronDown (close) | "Queue" eyebrow | spacer (h-11 w-11)
            └── list wrapper
                ├── [currentSong && currentIndex>=0]  "Now playing" eyebrow + highlighted row (non-removable)
                ├── "Next up" eyebrow
                └── upNext.length===0 ? "Nothing queued" : space-y-1 list of rows
```

### 2.6 Verbatim classNames
Root, backdrop, panel `<section>`, scroll container, padding wrapper, header row, ChevronDown button: **identical to NowPlayingSheet** (same `wf-now-playing-panel` etc.) — EXCEPT the scroll container's bottom padding:
```
h-full overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+1rem)] lg:pt-0 lg:pb-0
```
Header: "Queue" eyebrow `text-xs uppercase tracking-wide opacity-70`; right spacer `h-11 w-11 -mr-1` (aria-hidden, balances the close button).
List wrapper: `max-w-md mx-auto w-full lg:max-w-none`.
Section eyebrows ("Now playing" / "Next up"): `text-xs uppercase tracking-wide opacity-70 mb-2` (the "Next up" one adds `mt-6`).
Empty state: `text-sm opacity-60 px-2 py-2` ("Nothing queued").
List container: `space-y-1`.

### 2.7 Row renderer (`renderRow(entry, { highlighted?, removable? })`)
`removable` defaults true; current row passes `{ highlighted: true, removable: false }`.
Row container:
```
wf-list-row group flex items-center gap-3 rounded-lg px-2 py-2
```
+ `bg-emerald-500/10` (highlighted) / `hover:bg-black/5 hover:dark:bg-white/5`.
Tap target (the song button, `disabled={highlighted}`, `onClick` -> `handlePlayAt(entry.queueIndex)`):
```
wf-pressable flex min-w-0 flex-1 items-center gap-3 rounded-md bg-transparent text-left focus:outline-none touch-manipulation
```
Cover wrapper `relative h-12 w-12 shrink-0 overflow-hidden rounded`; CoverImage `fill sizes="48px" loading="lazy"` class `wf-song-cover object-cover`.
Text block `min-w-0 flex-1`: title `block truncate text-sm font-medium` (+ `text-emerald-500` when highlighted); artist `block truncate text-xs opacity-70`.
**Remove (X) button** (only when `removable`), `onClick` -> `removeFromQueue(entry.queueIndex)`, `X size={18}`:
```
wf-control-button h-9 w-9 shrink-0 rounded-full grid place-items-center text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10 touch-manipulation
```

### 2.8 `handlePlayAt(queueIndex)` (tap-to-jump) — INVARIANT
Reads `usePlayerStore.getState()`. If no `target` at index, bail. `requestImmediatePlayback(resolveOfflinePlaybackSong(target))`. Then:
```ts
const fromFuture = state.shuffle && state.playFuture[state.playFuture.length - 1] === queueIndex;
state.advanceToIndex(queueIndex, fromFuture ? { fromFuture: true } : undefined);
```
So tapping the *very next* shuffle entry (top of redo stack) consumes only that entry; tapping anything else is a fresh pick that clears the redo stack.

### 2.9 Swipe-down-to-dismiss
Same as NowPlayingSheet but simpler (no scrubber exception): allowed iff `scrollTop <= 0`; commit if `endY - startY > 80`. Same web hazards.

---

## 3. `TrackActionsMenu.tsx` — exports `TrackActionsButton` + portaled bottom sheet

### 3.1 `TrackActionsButton` props
```ts
{
  song: PlayerSong;
  liked?: boolean;            // default false
  likePending?: boolean;      // default false
  canLike?: boolean;          // default false — gates "Remove" vs "Save" label
  onToggleLike?: (songId, nextLiked) => void | Promise<void>;
  showQueue?: boolean;        // default true — gates Play next / Add to queue
  showLike?: boolean;         // default true — gates the like row
  className?: string;         // styling for the trigger ... button
  iconSize?: number;          // default 18
}
```
Renders nothing (`return null`) if there's no like action AND no queue actions (`!hasLikeAction && !hasQueueActions`), where `hasLikeAction = showLike && !!onToggleLike`, `hasQueueActions = showQueue`.

Trigger button (MoreHorizontal, `aria-haspopup="dialog"`, `onClick=handleOpen` which `stopPropagation()` + `impactLight()` + `setOpen(true)`):
```
wf-control-button grid shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500
```
+ caller `className`. When `open`, renders `<TrackActionsSheet>`.

### 3.2 `TrackActionsSheet` — `createPortal(..., document.body)`
**HAZARD: `createPortal` + `document.body` are web-only.** In RN use a `Modal`/`@gorhom/bottom-sheet` or a top-level portal host (`@gorhom/portal`).
**HAZARD: `if (typeof document === "undefined") return null;` guard — drop.**

Store/data: `addToQueue`, `playNext` from player store; `useOfflineStore.records[song.id]` -> `resolveOfflinePlaybackSong` for the header cover. `useModalDialogFocus(true, panelRef)` (always-on while mounted).

Animation/lifecycle:
- `SHEET_TRANSITION_MS = 260`.
- Mounts off-screen (`visible=false`), then `requestAnimationFrame(() => setVisible(true))` flips it on so the slide-up runs. **HAZARD: `requestAnimationFrame` — exists in RN but prefer reanimated entering animation.**
- `close()`: guarded by `closingRef`; `setVisible(false)` then `window.setTimeout(onClose, 260)` so the exit animation finishes before unmount. **Mirror with reanimated exiting + onClose callback.**
- Escape closes (`window.addEventListener("keydown")`, `stopPropagation()`). **HAZARD web; wire Android `BackHandler`.**
- Body scroll-lock with the same `.wf-now-playing-panel[data-open="true"]` guard. **Drop in RN.**
- Swipe-down-to-dismiss: `handleTouchStart`/`handleTouchEnd`, commit if `endY - startY > 60` (note: **60px** here vs 80px in the full sheets). **Reimplement w/ Pan gesture.**

`runAction(action)`: `impactLight(); action(); close();`.

### 3.3 Structure & verbatim classNames
Portal root: `fixed inset-0 z-[80]` (`role="presentation"`).
Backdrop button (`onClick` -> stopPropagation + close):
```
absolute inset-0 bg-black/60 transition-opacity duration-300
```
+ `opacity-100`/`opacity-0`.
Sheet `<section role=dialog>` (`onClick` stopPropagation; touch handlers):
```
absolute inset-x-0 bottom-0 mx-auto w-full max-w-md
rounded-t-3xl border-t border-white/10 bg-background text-white
shadow-[0_-16px_50px_rgba(0,0,0,0.55)] outline-none
pb-[calc(env(safe-area-inset-bottom)+0.5rem)]
transition-transform duration-[260ms] ease-out will-change-transform motion-reduce:transition-none
```
+ `translate-y-0` (visible) / `translate-y-full`.
**NOTE:** this sheet is hard-coded dark (`text-white`, `border-white/10`) regardless of theme.
Grab handle: `mx-auto mt-2.5 h-1 w-9 rounded-full bg-white/25`.
Header row `flex items-center gap-3 px-5 pb-4 pt-3`: cover wrapper `relative h-12 w-12 shrink-0 overflow-hidden rounded`; CoverImage `fill sizes="48px" loading="lazy"` class `wf-song-cover object-cover`; text `min-w-0` -> title `truncate text-sm font-semibold`, artist `truncate text-xs text-white/60`.
Divider: `mx-5 border-t border-white/10`.
Action list wrapper: `px-2 py-2`.

### 3.4 The three actions (conditional)
- If `showQueue`:
  - **Play next** — `ListStart size={20}` — `runAction(() => playNext(song))`.
  - **Add to queue** — `ListEnd size={20}` — `runAction(() => addToQueue(song))`.
- If `showLike && onToggleLike`:
  - **Save to / Remove from Liked Songs** — `Heart size={20}` (`fill-emerald-500 text-emerald-500` when `liked`). Label logic: `!canLike` -> "Save to Liked Songs"; else `liked` -> "Remove from Liked Songs"; else "Save to Liked Songs". `disabled={likePending}`. `onClick` -> `runAction(() => void onToggleLike(song.id, !liked))`.

`ActionRow({ icon, label, onClick, disabled })` button:
```
flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left text-[15px] font-medium text-white/90
transition hover:bg-white/10 active:bg-white/10 focus:outline-none focus-visible:bg-white/10
touch-manipulation disabled:cursor-wait disabled:opacity-60
```
Icon slot: `grid h-6 w-6 shrink-0 place-items-center text-white/70`. Label: `min-w-0 truncate`. `onClick` always `stopPropagation()` first.

---

## 4. `MarqueeText.tsx`

Props: `{ text: string; className?: string }`.
Behavior: single-line; if text overflows its container, slowly scrolls to the end, holds, returns, loops. Stays a plain truncated ellipsized line when it fits (so layout never reflows).

Mechanics:
- Refs: `containerRef` (div), `textRef` (span).
- `useEffect` (dep `[text]`): bail if `typeof ResizeObserver === "undefined"`. `measure()` computes `overflow = span.scrollWidth - container.clientWidth`; `setDistance(overflow > 8 ? overflow : 0)`. Observes BOTH container and span via a `ResizeObserver`; disconnects on cleanup.
- `active = distance > 0`.
- `durationSeconds = Math.max(7, distance / 28 + 4)` (constant scroll speed regardless of length).
- Container class: `cn("wf-marquee", active && "wf-marquee-active", className)`.
- Inner `<span class="wf-marquee-inner">` gets, when active, CSS vars `--wf-marquee-distance: ${distance}px` and `--wf-marquee-duration: ${durationSeconds}s`.
- Keyframes/mask: see §0.5. Hold/timing baked into keyframe percentages (0–12% start hold, 78–92% end hold, 100% back). 1.5s animation-delay before first run.

**PORTING HAZARD:** `ResizeObserver`, `scrollWidth`/`clientWidth`, CSS keyframes, and `mask-image` are all web-only. RN reimplementation: measure text width via `onLayout` / `onTextLayout` (or a hidden `Text` + `measure`), compare to container width; if overflow, drive a `translateX` loop with `react-native-reanimated` `withRepeat(withSequence(...))` matching the hold percentages; gradient edge-fade via `expo-linear-gradient` `MaskedView` (or `react-native-masked-view`). When it fits, render a plain `<Text numberOfLines={1} ellipsizeMode="tail">`.

---

## 5. `playback-gesture.ts`

```ts
export const PLAYBACK_GESTURE_EVENT = "spotify:playback-gesture";
export type PlaybackGestureDetail = { audioUrl: string };
export function requestImmediatePlayback(song: PlayerSong | null | undefined): void;
```
`requestImmediatePlayback`: bails if `typeof window === "undefined"` or no `song?.audioUrl`. Resolves via `resolveOfflinePlaybackSong(song)`; bails if no resolved `audioUrl`. Dispatches `window.dispatchEvent(new CustomEvent(PLAYBACK_GESTURE_EVENT, { detail: { audioUrl } }))`.

**Why it exists:** iOS WebView only lets you start/resume audio synchronously *inside a user gesture*. The consumer in `PlayerBar.tsx` (`onPlaybackGesture`, registered via `window.addEventListener(PLAYBACK_GESTURE_EVENT, ...)`) reacts on the same tick to activate the audio session, build/resume the Web Audio graph, and load+play the source — work that must happen synchronously in the gesture, separate from the async Zustand `play()`. NowPlayingSheet (play button + cover-swipe) and QueueSheet (tap-to-jump) call it; so does `playback-warm.ts`.

**PORTING HAZARD (significant):** this entire pattern is a workaround for the browser-audio-in-gesture restriction and uses `window` + `CustomEvent` (web-only). In Expo there is no `<audio>`/Web Audio gesture restriction — `expo-av`/`expo-audio` plays from anywhere. **Recommended:** delete this event bridge and have the play/jump handlers call the RN audio engine's `play(url)` directly. If you keep an event bus, use a plain emitter (`mitt`/Node `EventEmitter`), not `CustomEvent`.

---

## 6. `use-modal-dialog.ts` — `useModalDialogFocus`

```ts
useModalDialogFocus(open: boolean, panelRef: RefObject<HTMLElement|null>, options?: { enabled?: boolean }): void
```
`enabled` defaults true. When `open && enabled`: on next `requestAnimationFrame`, focuses the first focusable descendant (or the panel). Installs a `keydown` Tab-trap (wraps focus first<->last inside the panel; preventDefault if no focusable). On cleanup: cancels the RAF, removes the listener, and restores focus to the previously-focused element. Focusable selector:
```
a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])
```
Stacking: NowPlayingSheet passes `{ enabled: !escapeDisabled }` so it yields the trap to the QueueSheet when the queue is on top; QueueSheet and TrackActionsSheet always enable it.

**PORTING HAZARD:** entirely web a11y (`document.activeElement`, `.focus()`, `querySelectorAll`, Tab key, `window.addEventListener`). RN has no DOM focus or Tab traversal. **Drop this hook.** RN `Modal` already traps interaction; for accessibility use `accessibilityViewIsModal` (iOS) and `importantForAccessibility="no-hide-descendants"` on siblings (Android). The `escapeDisabled`/stacking concept maps to "only the topmost RN modal handles the Android back button."

---

## 7. Cross-cutting porting hazards (summary checklist)
1. **`localStorage` in `store/player.ts`** — all persisted prefs (shuffle/volume/muted/repeat/crossfade/playbackRate). Swap to MMKV/`expo-secure-store` (sync) or `AsyncStorage` (async + sync seed).
2. **`window` / `document` / `document.body` / `classList`** — Escape & body-scroll-lock effects in all three sheets, focus trap, gesture event bridge. None exist in RN; remove or remap (Android `BackHandler`, RN `Modal`).
3. **`createPortal(document.body)`** (TrackActionsSheet) — use `@gorhom/portal` / RN `Modal`.
4. **`CustomEvent` + `window.dispatchEvent`/`addEventListener` for playback** (`playback-gesture.ts`, consumed in PlayerBar) — the iOS-gesture workaround is unnecessary in Expo; call the audio engine directly or use a plain emitter.
5. **`<input type="range">` scrubber** — `@react-native-community/slider` (`minimumTrackTintColor` `#10b981`, `maximumTrackTintColor` `rgba(255,255,255,0.18)`).
6. **`ResizeObserver` + `scrollWidth`/`clientWidth` + CSS `@keyframes` + `mask-image`** (MarqueeText) — measure via `onLayout`/`onTextLayout`, animate via reanimated, edge-fade via MaskedView.
7. **Touch gestures via raw `TouchEvent` + `scrollTop`/`event.target instanceof HTMLInputElement`** (swipe-down-to-dismiss everywhere; swipe-to-change-track on cover) — reimplement with `react-native-gesture-handler` Pan gestures; keep the exact thresholds: dismiss commit **80px** (sheets) / **60px** (actions menu), cover axis-lock at **8px**, cover commit at **±64px**, dismiss only when scroll offset ≤ 0 and not on the scrubber.
8. **CSS transitions / `cubic-bezier` / `will-change` / `env(safe-area-inset-*)`** — port `wf-*` animation curves to reanimated timings (durations/curves quoted in §0.5); safe-area via `react-native-safe-area-context`.
9. **`react-router-dom` `useNavigate`** (NowPlayingSheet like-401 -> `/signin`) — Expo Router / React Navigation.
10. **Capacitor haptics** (`@capacitor/haptics`) — `expo-haptics`.
11. **Theme inconsistency to preserve:** the TrackActions sheet is hard-coded dark (`text-white`, `bg-background`, `border-white/10`), unlike the now-playing/queue sheets which use `text-foreground`/`dark:` variants.
12. **`accent-emerald-500` and the `text-[#1ed760]` (sleep) vs `text-emerald-500` (shuffle/repeat/like) split** — note two different greens are used: `#1ed760` (Spotify green, sleep-timer active states) and Tailwind `emerald-500`/`#10b981` (shuffle, repeat, like, scrubber, big play button). Reproduce both exactly.

---

## 8. Behavior parity quick-reference
- Swipe **left** on cover = next track; **right** = previous (commit at ±64px, axis-locked at 8px, haptic on commit).
- Swipe **down** anywhere on the now-playing/queue panel (when scrolled to top, not on scrubber) = close (>80px). Actions menu closes at >60px.
- Play button: haptic + `requestImmediatePlayback(song)` + `play()` (or `pause()`).
- Sleep timer options: **5 / 15 / 30 / 45 / 60 minutes**, **End of track**, plus **Turn off timer** when active. Enforcement lives in PlayerBar, not here.
- Podcast speed chip cycle: **1 → 1.25 → 1.5 → 1.75 → 2 → 0.75 → 1**.
- Queue "Up Next" mirrors `next()`: shuffle plays `playFuture` (top first) then `shuffleRemaining`; linear is `queue` after `currentIndex`.
- Tap a queue row to jump (`advanceToIndex`, consuming the redo-stack top iff it's the tapped index); X removes (`removeFromQueue`, no-op on the current row, which has no X).
- TrackActions: Play next / Add to queue (when `showQueue`), Save/Remove Liked (when `showLike && onToggleLike`); trigger hidden entirely if neither applies.
