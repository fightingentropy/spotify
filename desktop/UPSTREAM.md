# Spotifast source

The native client is a fork of [Spotifast](https://github.com/crmne/spotifast),
version 0.11.2, commit `579edbe2abde6652a9b5f5b2b8f108ade59eacb6`.
Copyright 2026 Carmine Paolino. The original MIT license is retained in `LICENSE`.

The upstream egui interface, theme system, lyrics layout, accessibility, artwork
cache, desktop controls, and visualizer are retained. StreamArena's provider is
implemented in `src/music_api`, `src/music_backend.rs`, and `src/music_player.rs`,
and it is the only provider: the app does not sign in to a Spotify account or
stream through librespot.

The upstream Spotify client has been removed: Spotify sign-in and credential
storage, the librespot playback engine, Spotify Connect discovery, self-updates,
the Web API client, the LRCLIB lyrics client, and the Spotify-only library
shelves, folders, radio pages and cover upload, together with their regression
tests. To port an upstream fix, compare against the commit above.

The fork uses its own application profile, credential-store service, process
control port, and app bundle identifier. No upstream deployment workflows,
release notes, or installation docs are used.
