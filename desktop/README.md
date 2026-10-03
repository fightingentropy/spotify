# Spotify desktop

Local Rust/egui desktop client named Spotify, based on Spotifast 0.11.2, connected
to the same StreamArena music API as our website and mobile app. See [UPSTREAM.md](UPSTREAM.md) for source
provenance and the retained MIT license.

## Run

Requirements: Rust 1.98+, a working native audio output, and FFmpeg. On this Mac,
FFmpeg is already installed by Homebrew. On another Mac, `brew install ffmpeg`.
The native player resolves `ffmpeg` from PATH and standard Homebrew locations.

From the repository root:

```sh
bun run desktop:dev
bun run desktop:check
bun run desktop:build
```

The build produces `desktop/dist/Spotify.app` on macOS. It uses Erlin's installed
Developer ID certificate and is not notarized for public distribution. On another
Mac, set `SPOTIFY_CODESIGN_IDENTITY` to a persistent code-signing identity in its
Keychain. The build fails if the chosen identity is unavailable; it does not fall
back to ad-hoc signing. FFmpeg is an external dependency; the build does not
bundle or download another executable.

Sign in with your existing music account. The app defaults to
`https://music.streamarena.xyz`. For local API development, set
`STREAMARENA_API_URL=http://127.0.0.1:5176` before launching. Session cookies are
scoped to that origin and saved in the operating system's credential store;
passwords are not saved. Each native app has a separate profile from Spotifast.

The first launch after switching from an ad-hoc build may ask for access to the
existing Keychain item once more. Choose **Always Allow** in that macOS prompt.
Later updates signed with the same Developer ID team and bundle identity should
retain that approval. Complete password prompts locally on the Mac.

## Integration

- Home listening history and most-played tracks, All Songs, Liked Songs, playlists.
- Library/catalog search, albums, artists and catalog playlists from our API.
- Centered global search with a shortcut hint; Cmd+K on macOS or Ctrl+K elsewhere
  focuses it. Cmd/Ctrl+F and `/` remain available.
- Native play/pause, queue, seeking, volume, shuffle/repeat and media controls.
- Playback starts as soon as decoding is ready. Prepared catalog tracks reuse
  valid media URLs; Opus/Ogg streams skip end-of-file probes on a fresh play,
  while seeking and expired or missing files keep their recovery paths.
- Catalog staging uses the server's existing SpotiFLAC / YouTube fallback.
- Click the playing artwork or title to open Now Playing, with artwork, song
  details, Lyrics and Queue tabs. Escape dismisses it; expanded lyrics stay in
  the same window on macOS.
- Comfortable and Compact density in Settings applies across browsing and
  library views. Library options groups view, sort and search controls.
- Pages, the player bar and expanded lyrics use the selected theme's neutral
  backgrounds; changing songs does not recolor the interface.
- Preparing tracks and pending library saves have explicit progress feedback.
- Lyrics and artwork come from our music data.
- On macOS, the compact-mode button or Cmd+Shift+M switches to a native menu-bar
  player and removes the app from the Dock and app switcher while playback
  continues. Click the Spotify menu-bar icon for an artwork-led popover with
  live progress, seeking, volume, likes, shuffle/repeat, and playback controls.
  Escape or clicking outside dismisses it; **Open desktop app** restores the
  full window and Dock icon. A fresh app launch opens the desktop. Other
  platforms retain the Winamp mini player.
- Native themes, an explicit player Visualizer menu and keyboard shortcuts.

The website and mobile app remain separate clients of the same service. Spotify
Connect, Spotify account authorization, upstream self-updates, and unsupported
Spotify-only library shelves are not exposed. MilkDrop is an optional upstream
build feature; the standard build keeps the in-player spectrum and waveform
without downloading MilkDrop presets.
