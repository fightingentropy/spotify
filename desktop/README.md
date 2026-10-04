# Spotify desktop

Local Rust/egui desktop client named Spotify, based on Spotifast 0.11.2, connected
to the same StreamArena music API as our website and mobile app. See [UPSTREAM.md](UPSTREAM.md) for source
provenance and the retained MIT license.

## Run

Requirements: Rust 1.98+, a working native audio output, and FFmpeg. Local file
exports also use `ffprobe`; `brew install ffmpeg` supplies both on macOS. The
app resolves these tools from standard Homebrew locations and PATH. Library-only
downloads run on the music server and do not require local export tools.

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

## Radio and podcasts

**Radio** opens the same live stations as the website, including Dromos 89.8 and
BBC Radio 1. Both continuous audio and HLS use the native playback engine. The
player shows a live indicator instead of a seek bar; resuming rejoins the live
broadcast.

**Podcasts** contains the website's curated shows, with artwork, descriptions,
recent episodes, dates, and durations. Refresh a show to fetch its current feed.
Episode progress is saved locally per account and survives app restarts; it is
not synced between devices. The catalogue comes from `/api/listening`, and feeds
and podcast media use the existing music API endpoints.

## Downloads

Open **Downloads** in the sidebar. Search for music or paste a Spotify song,
album, playlist, or artist link; filter the result and choose tracks before
starting. Album order is kept, and long lists are virtualized.
Search songs, albums, artists, or playlists with paginated results. Spotify share
links are expanded only through Spotify hosts. Track source checks distinguish a
catalog match from verified download availability; they never promise an untested
quality. Save covers, lyrics, or artist portraits/header/gallery without fetching
audio, with an optional maximum-resolution artwork preference.

- **This Mac** writes files to the chosen folder (initially
  `~/Music/Spotify Downloads`). **Music library** saves through our API for all
  clients. **Mac + library** does both, retaining a successful destination if the
  other fails so a retry only repeats the unfinished part.
- Choose Auto or a specific source, a requested CD/Hi-Res/Atmos quality, and whether
  to allow YouTube fallback. Availability depends on the configured server
  sources. History reports the measured codec, sample rate, bit depth or bitrate,
  and source for local exports; a requested quality is not a guarantee.
- **Original quality** keeps the source codec with the original sample rate by
  default. Optional FLAC, ALAC, MP3, Opus, AAC, WAV, AIFF, bitrate, and resampling settings
  are under **Format & metadata**. Encoding lossy audio as FLAC
  or increasing its sample rate does not recover detail.
- Local options include fourteen independent metadata switches, artist separators,
  full dates or years, embedded artwork/lyrics, track/album ReplayGain tags,
  cover/lyrics sidecars, M3U8 playlists, and download reports. Naming presets and
  custom templates support `{artist}`, `{artists}`, `{album}`, `{title}`, `{track}`,
  `{total_tracks}`, `{disc}`, `{total_discs}`, `{year}`, `{date}`, `{album_artist}`,
  `{isrc}`, `{upc}`, `{playlist}`, `{creator}`, `{category}`, and `{id}`. `{year}` uses
  four digits; `{date}` keeps the full release date. Existing files are kept or
  a separate copy is named; they are not overwritten. Duplicate matching can
  use filenames, ISRC recording codes, or both. The ISRC index refreshes when a
  file changes and can recognize files downloaded with the old app. Artwork or lyrics fetch
  errors appear as warnings when the file itself can still be saved.
- Queue and history are saved per account. Pause holds queued tracks while
  active work finishes. After a restart, unfinished jobs are marked interrupted
  and can be retried. **Retry failed** leaves deliberately cancelled jobs alone.
  **Clear completed** removes history entries, never music files. If history
  cannot be read, retry loading it or start new history while preserving a backup
  of the old record.

**Settings** exposes provider order, Songlink/Songstats resolution and fallback,
public HTTPS Tidal/Qobuz instance overrides, and reachability checks. It can
export portable preferences and import either our backup or SpotiFLAC's flat or
sectioned `config.json`. Backups contain preferences, never provider credentials.

**Tools** works on selected audio files or folders: inspect/edit tags and lyrics,
extract lyrics, convert/resample, copy with a naming template, apply track/album
ReplayGain, enrich metadata from a matching catalog recording, and inspect
spectrum, waveform, or BPM/key estimates. Levels and waveform cover the full
track at its original sample rate. Frequency analysis samples up to 450 FFT
windows across the full duration; brief events between windows may be missed.
These measurements cannot prove an original lossless source. Processing writes
new files; selected originals are preserved. Long work runs in the background
with progress and cancellation. Spectrograms show frequency changes over time,
with FFT size/window controls, five color palettes, linear/logarithmic frequency
scales, hover measurements, and batch PNG export. The averaged spectrum and
waveform remain available alongside the spectrogram. Analysis is limited to
two hours or 2 GB of decoded PCM per file, with at most 128 files per batch;
limits produce an error rather than silently truncating a track. LRC/TXT
files can be opened, edited, saved as copies, or converted to plain text. Metadata
enrichment uses a chosen source or an embedded Spotify COMMENT link, ISRC, and
title/artist fallbacks, rejecting conflicting recording identifiers.

Optional lyric translation uses the signed-in **Codex or Claude CLI on this Mac**,
with a language and provider-fallback preference. It starts an isolated temporary
session with tools and customizations disabled; no API key is stored by Spotify.
Only lyric text is sent, and timestamps are preserved locally. Invalid, incomplete,
cancelled, or failed translations never overwrite the original file. CLI account
limits still apply. Lyrics lookup can search simplified titles and optionally
broader title matches, preferring complete lyrics over truncated timed excerpts.

Downloads use authenticated music API routes; service credentials and YouTube
sessions remain configured on the server. The desktop has no cookie editor.
See [the download runbook](../docs/library-saves.md#native-desktop-downloads)
for server requirements. Keep the app running for transfers; closing the desktop
window in menu-bar mode leaves its download queue active.

The SpotiFLAC application is not a dependency. The Mac mini owns its provider
session at `~/.streamarena-music/provider-session.json`, migrating the old session
once. Protocol compatibility is tracked in source and renewal uses the official
verification flow independently of the old app bundle.

## Integration

- Home opens with clickable playlist covers: the global and UK Top 50 charts,
  YouTube Music Discover Mix, On repeat, Recently played, and Liked Songs.
  Covers open the track list; their play buttons start the collection. Your own
  playlists have a separate shelf, with compact recent-track shortcuts below.
  On repeat and Recently played use your real listening history; they do not
  create saved playlists. Chart/mix metadata uses the shared cached music API.
- All Songs, Liked Songs, and editable library playlists.
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
- Native themes and keyboard shortcuts.

The website and mobile app remain separate clients of the same service. Spotify
Connect, Spotify account authorization, upstream self-updates, and unsupported
Spotify-only library shelves are not exposed. MilkDrop is an optional upstream
build feature and is not included in the standard desktop build.
