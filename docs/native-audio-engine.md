# Native audio engine

The Expo app uses a native dual-deck AVFoundation engine on iOS and React Native
Track Player on Android. The browser has its own HTML audio/Web Audio player;
there is no Capacitor playback path.

## Ownership

`mobile/src/audio/engine.ts` selects the platform engine after the offline store
has hydrated. JavaScript owns queue order, shuffle/repeat, crossfade scheduling,
playback history, cross-device resume, podcast progress, and sleep timers.

On iOS, `mobile/src/audio/engine-native.ts` drives the typed bridge in
`mobile/modules/audio-engine/index.ts`. The bridge loads the Expo native module
lazily so Android can import the dispatcher without trying to load an iOS module.
`mobile/modules/audio-engine/ios/AudioEngineModule.swift` owns:

- Two AVPlayer decks, A and B, and the active-deck identity.
- The playback AVAudioSession and background audio output.
- Equal-power volume ramps that run natively during crossfade.
- Now Playing metadata and lock-screen/headphone remote commands.
- Deck loading, buffering, errors, interruptions, and transport events.

`app.json` declares the iOS audio background mode. Android registers its Track
Player playback service in `mobile/src/audio/register.ts`; its engine is in
`engine-rntp.ts` and does not provide overlapping dual-deck crossfade.

## State and media

The native bridge exposes deck preparation, transport, seeking, volume/rate,
crossfade, active-deck selection, Now Playing updates, and release operations.
See its TypeScript interfaces and Swift AsyncFunction definitions for the exact
contract instead of maintaining another API signature list here.

The engine identifies native events by both song and deck so late events from an
outgoing track cannot advance the new track. Playback resolves local downloads
first, retains the canonical queue across connectivity changes, and refreshes
remote sources through the shared playback-continuity flow.

Native playback receives signed remote URLs or device-local `file://` URLs.
Preserve signed query parameters when making remote URLs absolute. Never route
native audio through browser blobs or strip media signatures.

## Verification

Run the native type, lint, and test commands in [mobile/README.md](../mobile/README.md)
after changes. For engine changes, build the native app and check:

1. Play, pause, seek, next/previous, and late events after a rapid track change.
2. Background/locked-screen audio and lock-screen/headphone controls.
3. Crossfade with both tracks audible, including pause/resume during the ramp.
4. Downloaded playback and transitions between online and offline sources.
5. Podcast speed/resume and non-crossfading radio streams.

Use the integrated simulator for routine checks. Background audio and physical
remote controls require a separate device check; a passing static test or build
does not establish that result.
