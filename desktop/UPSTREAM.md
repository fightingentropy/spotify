# Spotifast source

The native client is a fork of [Spotifast](https://github.com/crmne/spotifast),
version 0.11.2, commit `579edbe2abde6652a9b5f5b2b8f108ade59eacb6`.
Copyright 2026 Carmine Paolino. The original MIT license is retained in `LICENSE`.

The upstream egui interface, theme system, lyrics layout, accessibility, artwork
cache, desktop controls, and visualizer are retained. StreamArena's provider is
implemented in `src/music_api`, `src/music_backend.rs`, and `src/music_player.rs`.
The production entry point always uses this provider. It does not authorize a
Spotify account or stream through librespot.

The fork uses its own application profile, credential-store service, process
control port, and app bundle identifier. Upstream self-updates are disabled so an
update cannot replace the StreamArena build with the Spotify client.

Upstream compatibility modules and regression tests remain with the source to
make future upstream fixes reviewable. They are not a second active provider.
No upstream deployment workflows, release notes, or installation docs are used.
