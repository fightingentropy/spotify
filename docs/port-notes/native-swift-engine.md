# Native Swift Audio Engine — Port Notes (Expo Custom Native Module Template)

Source of truth: `ios/App/App/AudioEnginePlugin.swift` (510 lines).
This is the iOS-native AVFoundation playback engine. It is currently a **Capacitor plugin** (`CAPPlugin, CAPBridgedPlugin`). For the Expo port it must become an **Expo Module** (`ExpoModulesCore`, `Module` definition + `EventEmitter`). This document maps it 1:1 so the Expo implementer can reconstruct it without reading the Swift.

> Design intent (from the file's own header comment): The JS player (`PlayerBar.tsx`) keeps **all orchestration** — queue, scrobble, podcast resume, and the decision of *when* to crossfade. This plugin **only owns audio output** so playback survives a locked screen. It manages: two AVPlayer "decks" (A/B) for crossfade, the `AVAudioSession`, the equal-power crossfade ramp, and the lock-screen Now Playing info + remote commands. Companion doc: `docs/native-audio-engine.md`.

---

## 1. Why native (the whole reason this module exists)

iOS plays audio via a **native `AVPlayer`**, NOT the WebView `<audio>` element. The `<audio>` element does not reliably keep playing / crossfading when the screen is locked or the app is backgrounded. The native engine + `UIBackgroundModes: audio` keeps audio alive on lock screen and enables locked-screen crossfade. **This entire module is the load-bearing reason the iOS app can crossfade and play with the screen off. Do not "simplify" it back to `expo-av` / `<Audio>` — you lose dual-deck crossfade and reliable background audio.**

There is also a legacy/alternate path ("M1a") where audio still plays from the WebView `<audio>` element and the native side only activates the `AVAudioSession` (`activateSession`) to keep that alive in background. The Expo port should target the **full native deck path**, not M1a.

---

## 2. Architecture overview

### 2.1 Dual-deck (A/B) AVPlayer design

- Two independent decks, keyed `"A"` and `"B"` in a `decks: [String: Deck]` dictionary.
- Each `Deck` owns its **own `AVPlayer`** (one player per deck — NOT one player swapping items). This is what makes crossfade possible: both decks can play simultaneously with independent volumes.
- One deck is the **active deck** (`activeDeck: String`, default `"A"`). The active deck is the one whose `time` events drive the UI clock. The inactive deck is used to **prefetch + warm up the next track** so the crossfade has something to fade *into*.
- A crossfade fades the `from` deck's volume down and the `to` deck's volume up simultaneously, then **swaps `activeDeck` to the `to` deck** on completion ("deck swap on commit").
- After a crossfade completes, the JS layer typically calls `prepare` again on the now-free deck to load the *next-next* track. (The Swift doesn't auto-rotate; JS drives which deck loads what.)

`Deck` fields (per-deck state to replicate in the Expo module):

| Field | Type | Meaning |
|---|---|---|
| `id` | `String` | `"A"` or `"B"` |
| `player` | `AVPlayer` | the deck's player; created with `volume = 1.0`, `automaticallyWaitsToMinimizeStalling = true` |
| `item` | `AVPlayerItem?` | current item |
| `songId` | `String?` | app-level track id passed in via `prepare`'s `id` param |
| `desiredRate` | `Float = 1.0` | playback rate to use when playing (for podcasts/speed) |
| `wantsPlaying` | `Bool = false` | "should be playing" intent — used to auto-start once the item becomes ready |
| `volume` | `Float = 1.0` | the deck's logical volume (mirrored to `player.volume`) |
| `startAt` | `Double = 0` | seconds to seek to once ready (podcast resume) |
| `timeObserver` | `Any?` | periodic time observer token |
| `statusObs` | `NSKeyValueObservation?` | KVO on `item.status` |
| `rateObs` | `NSKeyValueObservation?` | KVO on `player.timeControlStatus` |
| `endObserver` | `NSObjectProtocol?` | `AVPlayerItemDidPlayToEndTime` notification token |
| `lastDuration` | `Double = 0` | last known duration in seconds |

### 2.2 The 8s prefetch

> NOTE: The literal "8 seconds before end → start prefetch/crossfade" decision lives in the **JS layer** (`PlayerBar.tsx`), NOT in this Swift file. This module exposes the primitives JS needs to implement it: `prepare` (load next track onto the idle deck — the prefetch), `play` (warm/start it), and `crossfade` (the actual ramp). The Swift contribution to prefetch is:
> - `prepare` loads an `AVPlayerItem` with `automaticallyWaitsToMinimizeStalling = true` so by the time JS asks for the crossfade the next deck is buffered.
> - JS listens to the active deck's `time` event (`currentTime` / `duration`), and when `duration - currentTime <= ~8s` it (a) `prepare`s the next track on the idle deck if not already done, then (b) calls `crossfade`.
> When porting, keep the 8s window logic in the RN/JS player; the native module just needs to make `prepare` + `crossfade` cheap and correct.

### 2.3 Equal-power volume ramp on a native timer

The crossfade ramp runs on a **`DispatchSourceTimer`** (`rampTimer`), NOT a JS `setInterval` — so it keeps ticking on a locked screen / backgrounded app where JS timers are throttled or suspended. This is the second load-bearing reason for native code.

Ramp specifics (reproduce exactly):
- Timer source: `DispatchSource.makeTimerSource(queue: .main)`, `schedule(deadline: .now(), repeating: 0.033)` → **~30 fps (33 ms tick)**.
- Elapsed time computed from `DispatchTime.now().uptimeNanoseconds` deltas (monotonic clock), divided to ms — NOT from tick count, so it stays accurate even if ticks are dropped.
- `progress = clamp(elapsedMs / durationMs, 0, 1)`.
- **Equal-power curve:**
  - `outGain = cos(progress * 0.5 * π)`  (1 → 0)
  - `inGain  = sin(progress * 0.5 * π)`  (0 → 1)
  - `from.volume = startFrom * outGain` (where `startFrom` is the from-deck's volume captured at ramp start)
  - `to.volume = peak * inGain`
- On `progress >= 1`: cancel ramp, force `from` to volume 0 + pause it + `wantsPlaying = false`, force `to` to `peak`, set `activeDeck = to.id`, emit `crossfadeComplete`.
- Only **one ramp at a time**: `cancelRamp()` is called at the start of `crossfade`, and also by `prepare`, `pause`, `seek`, and `setVolume` (any of these cancels an in-flight crossfade).

### 2.4 Deck swap on commit

The `activeDeck` variable is reassigned to the `to` deck **only at ramp completion** (inside the timer handler when `progress >= 1`), not when the crossfade starts. There is also an explicit `setActiveDeck` JS method to force the active deck (used by JS for non-crossfade transitions). `activeDeck` gates which deck's `time` events the UI listens to (see `emitTime`).

---

## 3. JS Events emitted (`notifyListeners(name, data)`) — ALL 9

In Capacitor these are delivered via `notifyListeners`. In **Expo Modules**, replace with a declared `Events("...")` list + `sendEvent(name, payload)`, and JS subscribes via `addListener`. Payload field names below are exact and must be preserved (the JS player keys off them).

| # | Event name | Payload (exact keys) | Fires when |
|---|---|---|---|
| 1 | `time` | `{ deck: String, currentTime: Double, duration: Double }` | Periodic time observer, every **0.25 s** (`CMTime(0.25, 600)`), per deck. **Gated:** only emitted if `deck.id == activeDeck` OR that deck's `timeControlStatus == .playing` (so a paused idle deck stays silent, but a deck that's actively crossfading-in still reports). `currentTime` from `player.currentTime().seconds` (skipped if not finite). `duration` from `item.duration.seconds` if numeric+finite else `0`. |
| 2 | `loaded` | `{ deck: String, duration: Double }` | KVO on `item.status` transitions to `.readyToPlay`. Duration computed from `item.duration` (0 if not numeric/finite) and cached to `deck.lastDuration`. After this fires, the engine applies `startAt` seek (if `> 0.5`) and auto-starts playback if `wantsPlaying`. |
| 3 | `ended` | `{ deck: String }` | `AVPlayerItemDidPlayToEndTime` notification for that deck's item (natural end of track). |
| 4 | `seeked` | `{ deck: String, currentTime: Double }` | Completion handler of `seek(...)` (the JS-requested seek). `currentTime` = the requested position (the clamped `position` arg). |
| 5 | `error` | `{ deck: String, message: String }` | KVO on `item.status` transitions to `.failed`. `message` = `localizedDescription` + `" [domain code]"` + (if present) `" under(domain code)"` from `NSUnderlyingErrorKey`. Verbose on purpose for diagnosing 403/redirect/codec failures. |
| 6 | `crossfadeComplete` | `{ from: String, to: String }` | Ramp timer reaches `progress >= 1`. Emitted once per crossfade. Active deck has already been swapped to `to` at this point. |
| 7 | `playing` | `{ deck: String }` | KVO on `player.timeControlStatus == .playing` (audio actually started flowing). |
| 8 | `waiting` | `{ deck: String }` | KVO on `player.timeControlStatus == .waitingToPlayAtSpecifiedRate` (buffering/stall). The `default:` case (`.paused`) emits nothing. |
| 9 | `remote` | `{ action: String }` for play/pause/toggle/next/prev/interruption; `{ action: "seek", value: Double }` for scrubber | Lock-screen / Control-Center / headphone remote commands AND audio-session interruptions (see §5). `action` ∈ `"play" | "pause" | "toggle" | "next" | "prev" | "seek"`. For `"seek"`, `value` = `event.positionTime` (seconds). |

**Porting note:** The JS side maps `remote` actions to its own queue logic. `next`/`prev` only have meaning because JS owns the queue — the native module never advances tracks on its own; it just forwards the button press as a `remote` event.

---

## 4. Methods exposed to JS (the JS-callable API surface)

All methods are Capacitor `@objc func name(_ call: CAPPluginCall)` returning a Promise. Params are read off `call` (`getString`/`getDouble`/`getBool`). In Expo, each becomes an `AsyncFunction("name") { (args...) in ... }`. Almost every body dispatches to `DispatchQueue.main.async` (AVPlayer + MediaPlayer must be touched on main).

The registered method list (from `pluginMethods`), in order:
`configure`, `activateSession`, `prepare`, `play`, `pause`, `stop`, `seek`, `setVolume`, `setRate`, `crossfade`, `setActiveDeck`, `setNowPlaying`, `updateNowPlaying`, `releaseDeck`.

> The user's prompt mentions `load`/`prepareNext` by their generic names. Mapping: **`load` == `prepare`** (loads a URL onto a deck). There is no separate `prepareNext`; "prepare next" is just `prepare` called on the idle deck. There is no separate `toggle` method — toggle arrives only as a `remote` event and JS decides play vs pause.

| Method | Params (exact keys, types, defaults) | Returns | Behavior / notes |
|---|---|---|---|
| `configure` | none | Promise (resolve) | Idempotent. Calls `ensureConfigured()`: creates decks A & B, wires per-deck observers, configures `AVAudioSession`, sets up remote commands, sets up interruption observer. Guarded by `configured` flag. Also called automatically in `load()` during bridge init, so decks exist before first `prepare`. |
| `activateSession` | none | Promise | Just sets `AVAudioSession` to `.playback` + active. Legacy M1a path (WebView `<audio>` still plays; this keeps it alive in background). |
| `prepare` (≈ JS `load`) | `deck: String` (req), `url: String` (req), `id: String?`, `startAt: Double = 0` | Promise; rejects `"deck not configured"` / `"missing url"` / `"bad url"` | Loads a track onto a deck. URL handling: if it starts with `/` → `URL(fileURLWithPath:)` (local file); else `URL(string:)`; else reject. Cancels any ramp, tears down old item/end-observer, creates `AVPlayerItem(url:)`, `replaceCurrentItem`, restores `player.volume = deck.volume`, installs `status` KVO + `DidPlayToEndTime` observer. Sets `deck.songId`, `deck.startAt`, resets `lastDuration`. **Does not start playback** unless `wantsPlaying` already true (auto-start happens on `loaded`). |
| `play` | `deck: String` (req) | Promise; rejects `"deck not configured"` | Sets `wantsPlaying = true`, calls `startPlayback`. `startPlayback`: re-asserts `.playback` session (or re-activates), then `player.playImmediately(atRate: desiredRate)` if rate ≠ 1, else `player.play()`. (If item not yet ready, `wantsPlaying` causes auto-start on `loaded`.) |
| `pause` | `deck: String` (req) | Promise; rejects if no deck | `wantsPlaying = false`, `cancelRamp()`, `player.pause()`. |
| `stop` | `deck: String` (req) | Promise; rejects if no deck | `teardownDeck`: pause, `replaceCurrentItem(nil)`, invalidate `statusObs`, remove end observer, clear `item`/`songId`, `wantsPlaying = false`. |
| `releaseDeck` | `deck: String` (req) | Promise (always resolves, even if deck missing) | Same `teardownDeck` as `stop` but never rejects — safe cleanup. |
| `seek` | `deck: String` (req), `position: Double = 0` (clamped `>= 0`) | Promise; rejects if no deck | `cancelRamp()`, `player.seek(to:, toleranceBefore: .zero, toleranceAfter: .zero)` (exact seek), emits `seeked` in completion. |
| `setVolume` | `deck: String` (req), `volume: Double = 1.0` (clamped 0…1, cast to `Float`) | Promise; rejects if no deck | `cancelRamp()`, sets `deck.volume` and `player.volume`. (Cancels in-flight crossfade.) |
| `setRate` | `deck: String` (req), `rate: Double = 1.0` (→ `Float`) | Promise; rejects if no deck | Sets `desiredRate`. If player not paused, applies `player.rate = rate` live. Used for podcast playback speed. |
| `crossfade` | `from: String` (req), `to: String` (req), `durationMs: Double = 4000` (clamped `>= 1`), `peak: Double = 1.0` (clamped `>= 0`, → `Float`) | Promise; rejects `"bad decks"` if either deck id unknown | The equal-power ramp (§2.3). Captures `from.volume` as `startFrom`, zeroes `to`, sets `to.wantsPlaying = true`, `startPlayback(to)`, starts the 33 ms timer, swaps `activeDeck` + emits `crossfadeComplete` on completion. |
| `setActiveDeck` | `deck: String?` | Promise | Sets `activeDeck` (no main-thread dispatch — trivial assignment). Used for non-crossfade hard cuts so the UI clock follows the right deck. |
| `setNowPlaying` | `title: String = ""`, `artist: String = ""`, `album: String = ""`, `duration: Double = 0`, `artworkUrl: String?` | Promise | Sets the full `MPNowPlayingInfoCenter.nowPlayingInfo` dict (see §6). Kicks off async artwork download. |
| `updateNowPlaying` | `position: Double = 0`, `rate: Double = 1`, `playing: Bool = false` | Promise | Merges position + rate into existing now-playing dict; sets `playbackState` to `.playing`/`.paused`. Called frequently by JS to keep the lock-screen scrubber in sync. |

### Internal helpers (not JS-exposed, but needed to reconstruct):
- `ensureConfigured()` — one-time setup (see `configure`).
- `configureSession()` — `setCategory(.playback, mode: .default, options: [])` + `setActive(true)`; logs on failure.
- `setupDeckObservers(deck)` — installs the 0.25 s periodic time observer (`emitTime`) and the `timeControlStatus` KVO (`playing`/`waiting`).
- `startPlayback(deck)` — session re-assert + play (rate-aware).
- `teardownDeck(deck)` — full deck cleanup.
- `cancelRamp()` — cancels + nils `rampTimer`.
- `loadArtwork(urlString)` — `URLSession.shared.dataTask` → `UIImage` → `MPMediaItemArtwork` merged into now-playing on main.
- `setupRemoteCommands()` — wires `MPRemoteCommandCenter` (see §6).
- `emitRemote(action)` — `notifyListeners("remote", ["action": action])`.
- `setupInterruptionObserver()` / `handleInterruption(_:)` — audio session interruptions (see §5).
- `deck(call)` — resolve deck from `call.getString("deck")`.
- `emitTime(deck)` — gated `time` event.

---

## 5. AVAudioSession interruption observer (auto-pause/resume on calls/Siri)

- Registered in `setupInterruptionObserver()` via `NotificationCenter` on `AVAudioSession.interruptionNotification`, object = `AVAudioSession.sharedInstance()`.
- `handleInterruption(_:)` reads `AVAudioSessionInterruptionTypeKey`:
  - `.began` (phone call, Siri, another app grabbed audio) → `emitRemote("pause")` — i.e. emits a `remote` event with `action: "pause"`. **The native side does NOT pause the player itself**; it tells JS to pause so JS state stays the source of truth.
  - `.ended` → checks `AVAudioSessionInterruptionOptionKey` for `.shouldResume`; if present, `emitRemote("play")`. If `.shouldResume` not set, does nothing (don't auto-resume).
- **Porting:** in Expo, register the same observer in the module's `OnCreate`/`OnStartObserving` (or eagerly in the `Module` init), and forward as the `remote` event. Keep the "tell JS, don't act" contract — JS owns transport.

---

## 6. Lock-screen integration

### 6.1 MPNowPlayingInfoCenter

`setNowPlaying` builds the dict (initial elapsed/rate are 0 because playback hasn't asserted yet):
```
MPMediaItemPropertyTitle              = title
MPMediaItemPropertyArtist             = artist
MPMediaItemPropertyAlbumTitle         = album
MPNowPlayingInfoPropertyElapsedPlaybackTime = 0.0
MPNowPlayingInfoPropertyPlaybackRate        = 0.0
MPMediaItemPropertyPlaybackDuration   = duration   // only if duration > 0
```
Then `MPNowPlayingInfoCenter.default().nowPlayingInfo = info` and async artwork load.

Artwork (`loadArtwork`): downloads `artworkUrl` with `URLSession.shared.dataTask`, builds `MPMediaItemArtwork(boundsSize:)` returning the `UIImage`, **merges** it into the existing now-playing dict on the main thread (guards that `nowPlayingInfo` still exists). Failures are silently ignored.

`updateNowPlaying` (called continuously by JS):
```
info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
info[MPNowPlayingInfoPropertyPlaybackRate]        = playing ? rate : 0.0
MPNowPlayingInfoCenter.default().nowPlayingInfo = info
MPNowPlayingInfoCenter.default().playbackState   = playing ? .playing : .paused
```

### 6.2 MPRemoteCommandCenter wiring (`setupRemoteCommands`)

Each command adds a target closure that emits a `remote` event and returns `.success`, then is explicitly `isEnabled = true`:

| Command | Emits |
|---|---|
| `playCommand` | `remote` `{action:"play"}` |
| `pauseCommand` | `remote` `{action:"pause"}` |
| `togglePlayPauseCommand` | `remote` `{action:"toggle"}` |
| `nextTrackCommand` | `remote` `{action:"next"}` |
| `previousTrackCommand` | `remote` `{action:"prev"}` |
| `changePlaybackPositionCommand` | casts event to `MPChangePlaybackPositionCommandEvent`; returns `.commandFailed` if cast fails; else `remote` `{action:"seek", value: event.positionTime}` and `.success` |

All six enabled. Note `seek` uses the same `remote` event as the buttons but with a `value` field — JS must branch on `action`.

---

## 7. Porting to Expo — concrete mapping & HAZARDS

### 7.1 Capacitor → Expo Module skeleton
```swift
import ExpoModulesCore
import AVFoundation
import MediaPlayer
import UIKit

public class AudioEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AudioEngine")
    Events("time","loaded","ended","seeked","error","crossfadeComplete","playing","waiting","remote")
    OnCreate { /* ensureConfigured(): build decks, observers, session, remote cmds, interruption obs */ }
    AsyncFunction("configure") { ... }
    AsyncFunction("activateSession") { ... }
    AsyncFunction("prepare") { (deck: String, url: String, id: String?, startAt: Double?) in ... }
    AsyncFunction("play") { (deck: String) in ... }
    AsyncFunction("pause") { (deck: String) in ... }
    AsyncFunction("stop") { (deck: String) in ... }
    AsyncFunction("seek") { (deck: String, position: Double) in ... }
    AsyncFunction("setVolume") { (deck: String, volume: Double) in ... }
    AsyncFunction("setRate") { (deck: String, rate: Double) in ... }
    AsyncFunction("crossfade") { (from: String, to: String, durationMs: Double?, peak: Double?) in ... }
    AsyncFunction("setActiveDeck") { (deck: String) in ... }
    AsyncFunction("setNowPlaying") { (title: String?, artist: String?, album: String?, duration: Double?, artworkUrl: String?) in ... }
    AsyncFunction("updateNowPlaying") { (position: Double?, rate: Double?, playing: Bool?) in ... }
    AsyncFunction("releaseDeck") { (deck: String) in ... }
  }
}
```
- Replace `notifyListeners(name, data:)` → `sendEvent(name, payload)`. JS subscribes with `module.addListener(name, cb)` (declare `Events(...)`; optionally `OnStartObserving`/`OnStopObserving`).
- Replace `CAPPluginCall` getters with typed Expo function args; keep the **same defaults/clamps** (volume 0…1, durationMs ≥ 1, peak ≥ 0, position ≥ 0).
- Keep every body's `DispatchQueue.main.async` — AVPlayer/MediaPlayer are main-thread only. Expo `AsyncFunction` runs off the JS thread, so the main dispatch is still required.

### 7.2 Required iOS config (carry over to Expo / app.json)
- **`UIBackgroundModes: ["audio"]`** in `Info.plist` — without it, audio dies in background and the whole native engine is pointless. In Expo set via `ios.infoPlist.UIBackgroundModes` or `expo-av`/`expo-audio` background-audio config plugin, or a custom config plugin.
- `AVAudioSession` category `.playback`, mode `.default`. Activated in `configureSession` and re-asserted in `startPlayback`.

### 7.3 PORTING HAZARDS (read before writing RN code)
1. **`expo-av` / `<Audio>` cannot do this.** Standard Expo audio = one sound at a time, no dual-deck simultaneous playback, no native equal-power ramp, no background-safe 33 ms timer. You MUST ship a **custom native module** (this file, re-skinned for Expo) — there is no JS-only or `expo-av` substitute. This is the #1 risk: do not try to fake crossfade by overlapping two `expo-av` Sounds driven by JS `setInterval` — the JS timer is throttled/suspended on lock screen and the crossfade will stutter or freeze.
2. **The crossfade timer must stay native (`DispatchSourceTimer`, main queue).** Driving volume from JS is the trap. Keep `volume` ramping inside Swift; JS only calls `crossfade(...)` once and waits for `crossfadeComplete`.
3. **Capacitor-specific symbols to drop:** `CAPPlugin`, `CAPBridgedPlugin`, `CAPPluginMethod`, `CAPPluginCall`, `@objc(...)`/`jsName`/`pluginMethods`, `load()`, `notifyListeners`. Replace per §7.1. The `@objc` on `handleInterruption` (selector target) stays.
4. **URL scheme branch.** `prepare` treats a leading `/` as a **local file path** (`fileURLWithPath`). If the RN/Expo side passes file URIs as `file://...`, that branch won't match (it expects a bare absolute path). Decide the contract: either keep passing bare `/var/.../x.mp3`, or extend the branch to also accept `file://`. Local downloaded tracks (offline cache) depend on this.
5. **Event delivery + threading.** `sendEvent` from Expo is fine off-main, but all the AVPlayer observation callbacks already run on `.main` here — preserve that. The periodic time observer queue is `.main`; KVO and notification observers post on `.main`.
6. **`activeDeck` gating of `time` events.** If you forget the gate (`deck.id == activeDeck || timeControlStatus == .playing`), the UI clock will jump between decks during/after a crossfade. Reproduce the gate exactly.
7. **Now Playing artwork is fetched with `URLSession` natively** — that's fine (not a web primitive), but the artwork URL must be a real https URL reachable by the device, and failures are swallowed. If artwork comes from a signed/cookie-auth endpoint, the bare `URLSession` request won't carry app cookies; pass a pre-authorized/public artwork URL.
8. **Remote/interruption contract is "notify JS, don't act."** The native module never advances the queue, never toggles play state on its own (except it forcibly pauses the `from` deck at crossfade end). All transport decisions come back through the `remote` event and JS re-issues `play`/`pause`/`prepare`/`crossfade`. Keep this — it's why state stays consistent.
9. **`configure` is idempotent but must run before first `prepare`.** Capacitor's `load()` guaranteed this. Expo `OnCreate` is the equivalent hook; if you instead rely on the JS first call, ensure `configure` is awaited before any `prepare`.
10. **No web APIs anywhere in this file** — it's pure native, so nothing here breaks in RN by itself. The breakage risk is entirely on the JS side that *replaces* the Web Audio / `<audio>` orchestration in `PlayerBar.tsx` (the 8s window, scrobble, queue) to call this module instead. That JS rewrite is out of scope for this file but is where the relative-fetch / Web-Audio hazards live.

---

## 8. End-to-end track-change sequence (so JS author knows the call order)

1. App start: `configure()` (or auto via `OnCreate`).
2. First track: `setActiveDeck("A")` → `prepare(deck:"A", url, id, startAt)` → `setNowPlaying(...)` → `play("A")`. Listen for `loaded`/`playing`; drive UI from `time`. Pump `updateNowPlaying(position, rate, playing)` periodically.
3. As track A approaches end (JS sees `time` with `duration - currentTime <= ~8s`): `prepare(deck:"B", nextUrl, nextId)` (prefetch onto idle deck).
4. At the crossfade point: `crossfade(from:"A", to:"B", durationMs, peak)`. Engine starts B, ramps, swaps `activeDeck` to B, emits `crossfadeComplete`.
5. On `crossfadeComplete`: update Now Playing for the new track; `releaseDeck("A")` (or reuse A for the next prefetch).
6. Repeat, alternating A/B.
7. Lock-screen buttons / call interruptions arrive as `remote` events; JS reacts by issuing the matching transport calls.
