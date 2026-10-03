# Native music client

The mobile app uses Expo SDK 57, React Native 0.86, Expo Router, NativeWind,
and Zustand. It connects to the same authenticated APIs as the browser.
See [client parity](../docs/client-parity.md) for shared workflows and platform
differences, and [library saves](../docs/library-saves.md) for download fallback.

## Development

Install the root dependencies with `bun install --frozen-lockfile`, then:

```bash
cd mobile
npm ci
npm run ios
# or: npm run android
```

A native development build is required; Expo Go cannot load the local audio
and background-download modules. Reuse the simulator configured in
[AGENTS.md](../AGENTS.md) for routine iOS work.

`app.json`, `plugins/`, and `modules/` are the native build inputs. The generated
`ios/` and `android/` directories are ignored. Make durable configuration changes
in those inputs, then regenerate with `npm run prebuild` when necessary.
`npm ci` also runs the compatibility patches in `scripts/` for the installed
Expo and Track Player versions.
After a fresh install, run `pod install` from `ios/` before invoking
`xcodebuild` directly so CocoaPods regenerates native dependency files.

The API origin is selected by `src/lib/config.ts`. Preserve every query parameter
on signed media URLs when making them absolute; native audio and download tasks
do not share the API client's cookie handling.

## Implementation

- Routes live in `src/app/`; shared navigation and player sheets mount from
  `src/app/_layout.tsx`.
- `src/audio/engine.ts` selects the native dual-deck engine on iOS and Track
  Player on Android. See [native audio](../docs/native-audio-engine.md).
- `src/store/offline.ts` coordinates account-scoped downloads, playback cache,
  verification, and mutation replay. `src/lib/offline-db.ts` stores records in
  SQLite; MMKV stores synchronous settings and API snapshots.
- `modules/background-downloads/` uses URLSession on iOS and WorkManager on
  Android so transfers can continue outside the foreground JavaScript runtime.
- `src/lib/import-queue.ts` persists import work. `src/lib/connectivity.ts`
  combines native network hints with actual API reachability.
- Portable behavior lives in `../packages/shared/src/` and is resolved through
  `metro.config.js` and the TypeScript path aliases.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```

Run `bun run check` from the repository root for the web build, shared tests,
and unused-code checks across both clients. Static checks and a simulator build
do not prove a signed installation or physical-device playback; report those
checks separately when doing native release work.
