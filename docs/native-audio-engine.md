# Native iOS audio engine

## Why

On iOS the web player routes **all** playback through a Web Audio `AudioContext`
(`PlayerBar.tsx` → `decideWebAudioMode()` forces it on, both `<audio>` elements are
wired through `createMediaElementSource` at mount). This was done so the crossfade
can ramp gain (iOS makes `HTMLMediaElement.volume` read-only).

That design makes **locked-screen playback impossible**:

1. The app declared **no** `UIBackgroundModes: audio`, so iOS suspended the
   WebView's audio the moment the screen locked. (Primary cause of "goes silent
   when locked".)
2. Even with that capability, iOS **suspends the `AudioContext`** in the
   background — so Web-Audio-routed audio is silent when locked regardless.
3. The crossfade gain ramp lives on the Web Audio thread and keeps running after
   the element is paused; resuming lands mid-ramp → "pause flashes and the verse
   repeats".

You can't crossfade via Web Audio on a locked iOS screen — Apple won't keep the
context alive. The fix is a **native AVFoundation engine**: iOS playback,
background session, lock-screen controls, and the crossfade ramp all run in
native code that the OS keeps alive while audio plays.

## Architecture

The JS player keeps **all orchestration** (queue, shuffle/repeat, podcast resume,
scrobble, sleep timer, *when* to crossfade). The native plugin owns **audio
output**: two AVPlayer "decks" (A/B) for crossfade, the `AVAudioSession`, the
native crossfade volume ramp, and `MPNowPlayingInfoCenter` /
`MPRemoteCommandCenter` for the lock screen.

```
PlayerBar.tsx (JS orchestration)
  └─ on iOS native → drives ─┐
                             ▼
   AudioEngine TS bridge (src/lib/native-audio.ts)
                             ▼  (Capacitor)
   AudioEnginePlugin.swift  ── deck A: AVPlayer ─┐
     AVAudioSession(.playback)                   ├─► hardware (background-safe)
     MPNowPlayingInfo + RemoteCommandCenter      │
     native equal-power crossfade ramp ── deck B: AVPlayer ─┘
```

Desktop/Android are **unchanged**: they fade via `audio.volume` and have no
"locked" state that kills audio. The native path is gated on
`Capacitor.isNativePlatform() && iOS`.

## Plugin API (`AudioEngine`)

Two decks identified by `"A"` / `"B"`, mirroring `audioARef` / `audioBRef`.

| Method | Purpose |
|---|---|
| `configure()` | Activate `AVAudioSession(.playback)`, register remote commands. Call once. |
| `prepare({ deck, id, url, startAt? })` | Load a deck with a track (http(s) / HLS m3u8 / `file://`). AVPlayer plays HLS and local files natively — no hls.js, no blob workaround. |
| `play({ deck })` / `pause({ deck })` / `stop({ deck })` | Transport. |
| `seek({ deck, position })` | Accurate seek (zero tolerance). |
| `setVolume({ deck, volume })` | Immediate level (cancels any ramp). |
| `setRate({ deck, rate })` | Podcast speed. |
| `crossfade({ from, to, durationMs, peak })` | Native equal-power ramp: `from` → 0, `to` → `peak`. Runs on a dispatch timer that fires in the background. |
| `setActiveDeck({ deck })` | Which deck drives `time` events + now-playing elapsed time. |
| `setNowPlaying({ title, artist, album, artworkUrl?, duration? })` | Lock-screen metadata. |
| `updateNowPlaying({ position, rate, playing })` | Lock-screen elapsed/rate/state. |
| `release({ deck })` | Tear down a deck. |

Events (via `addListener`):

| Event | Payload | Maps to (web equivalent) |
|---|---|---|
| `time` | `{ deck, currentTime, duration }` | `timeupdate` |
| `loaded` | `{ deck, duration }` | `loadedmetadata` / `durationchange` |
| `ended` | `{ deck }` | `ended` |
| `playing` / `waiting` | `{ deck }` | `playing` / `waiting` |
| `error` | `{ deck, message }` | `error` |
| `remote` | `{ action: 'play'\|'pause'\|'next'\|'prev'\|'seek', value? }` | lock-screen buttons → `play`/`pause`/`next`/`previous`/`onSeek` |

## Integration plan (next milestone)

A small `NativeAudioElement` adapter (TS) implements the subset of
`HTMLAudioElement` that `PlayerBar` uses (`src`, `currentTime`, `duration`,
`volume`, `playbackRate`, `paused`, `play()`, `pause()`, `addEventListener` for
`timeupdate`/`loadedmetadata`/`ended`/`durationchange`/`playing`/`waiting`/
`seeked`/`error`), delegating to the plugin. On iOS native:

- `audioARef`/`audioBRef` point to adapters instead of `<audio>` elements; no
  `<audio>` JSX, no `ensureWebAudioGraph`, no hls.js, no native-offline blob.
- `decideWebAudioMode()` → `false` (volume via adapter → `setVolume`).
- `startCrossfade()` → `AudioEngine.crossfade(...)` instead of the JS interval
  (background-safe ramp).
- Offline tracks pass the raw `file://` uri (not `Capacitor.convertFileSrc`'s
  `capacitor://`, which AVPlayer can't load).
- `useMediaSession` is disabled on native; the plugin owns now-playing and
  forwards remote-command events to `play`/`pause`/`next`/`previous`/`onSeek`.

## Test plan (on-device, each milestone)

1. **Background audio**: play a track, lock the phone → audio continues; the
   lock-screen seeker tracks real playback; play/pause/skip on the lock screen
   work.
2. **Offline**: download a song, play it, lock → continues.
3. **Crossfade**: enable crossfade, let a track end while locked → smooth fade,
   no silence, no repeated segment.
4. **Podcasts**: speed + resume point survive.
5. **HLS radio**: plays; no crossfade (expected).

## Status

- [x] Milestone 0 — foundation: plugin + `UIBackgroundModes` + TS bridge (compiles, not yet wired)
- [ ] Milestone 1 — wire core playback (load/play/pause/seek/time/ended + lock screen); test background audio
- [ ] Milestone 2 — native crossfade
- [ ] Milestone 3 — parity polish (podcast rate/resume, offline file uris, interruptions)
