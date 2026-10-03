//! The only runtime used by this fork: our HTTP music API plus native playback.
use crate::{
    api::models::{Context, Device, PlayableItem, PlaybackState, Queue, User},
    backend::{ApiRequest, ApiResponse, AuthStatus, Command, Event, LocalPlayback, Waker},
    http::Http,
    music_api::MusicApi,
    music_player::MusicPlayer,
    music_session::SessionStore,
    paths::AppDirs,
    player::{EngineConfig, Playback},
};
use std::{sync::mpsc::Sender, time::Duration};
use tokio::{sync::mpsc, task::JoinSet};

const DEFAULT_API: &str = "https://music.streamarena.xyz";
enum Done {
    Auth(Result<(MusicApi, Option<User>), String>),
    Events(Vec<Event>),
    SessionSaved(Result<(), String>),
}
fn emit(events: &Sender<Event>, waker: &Waker, event: Event) {
    let _ = events.send(event);
    waker.wake();
}
fn device(player: &MusicPlayer) -> Device {
    let state = player.local_state();
    Device {
        id: Some("streamarena".into()),
        name: "This computer".into(),
        is_active: true,
        kind: "Computer".into(),
        volume_percent: Some((u32::from(state.volume) * 100 / 65535) as u8),
        supports_volume: Some(true),
        ..Default::default()
    }
}
fn queue(api: &MusicApi, player: &MusicPlayer) -> Queue {
    Queue {
        currently_playing: player
            .local_state()
            .track
            .and_then(|track| api.track_for_uri(&track.uri))
            .map(PlayableItem::Track),
        queue: player
            .queue_uris()
            .iter()
            .filter_map(|uri| api.track_for_uri(uri))
            .map(PlayableItem::Track)
            .collect(),
    }
}

pub async fn run(
    dirs: AppDirs,
    config: EngineConfig,
    http: Http,
    events: Sender<Event>,
    waker: Waker,
    restore: bool,
    mut commands: mpsc::UnboundedReceiver<Command>,
) {
    let origin = std::env::var("STREAMARENA_API_URL").unwrap_or_else(|_| DEFAULT_API.into());
    let mut api = match MusicApi::new(&origin, http.clone()) {
        Ok(api) => api,
        Err(error) => {
            emit(&events, &waker, Event::Auth(AuthStatus::Failed(error)));
            return;
        }
    };
    let sessions = SessionStore::new(origin.clone());
    let revoked = dirs.state.join("music-session-revoked");
    let mut tasks = JoinSet::new();
    let mut player: Option<MusicPlayer> = None;
    let mut account = String::new();
    let mut history = crate::music_history::ListeningHistory::default();
    if restore && !revoked.exists() {
        let api = api.clone();
        let sessions = sessions.clone();
        tasks.spawn(async move {
            let result = async {
                if let Some(cookie) = sessions.read().await? {
                    api.restore_session_cookie(&cookie)?;
                }
                let user = api.session().await?;
                Ok((api, user))
            }
            .await;
            Done::Auth(result)
        });
    } else {
        emit(&events, &waker, Event::Auth(AuthStatus::SignedOut));
    }
    let mut ticks = tokio::time::interval(Duration::from_millis(200));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        // Playback preparation can discover expiration independently of API tasks.
        if api.session_expired() {
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
            player = None;
            history.finish();
            account.clear();
            let _ = tokio::fs::create_dir_all(&dirs.state).await;
            let _ = tokio::fs::write(&revoked, b"session expired").await;
            if let Ok(fresh) = MusicApi::new(&origin, http.clone()) {
                api = fresh;
                http.replace(api.client());
            }
            emit(&events, &waker, Event::Playback(LocalPlayback::Unavailable));
            emit(&events, &waker, Event::Local(Box::default()));
            emit(&events, &waker, Event::Auth(AuthStatus::SignedOut));
            emit(
                &events,
                &waker,
                Event::Auth(AuthStatus::Failed(
                    "Your music session expired. Please sign in again.".into(),
                )),
            );
        }
        // Preparation and output changes should not wait for the periodic
        // position/history tick. Notify retains a permit across select loops.
        let playback_ready = player.as_ref().map(MusicPlayer::wake_signal);
        tokio::select! {
            _ = async {
                match playback_ready {
                    Some(signal) => tokio::select! {
                        _ = signal.notified() => {},
                        _ = ticks.tick() => {},
                    },
                    None => { ticks.tick().await; },
                }
            } => { if let Some(player) = player.as_mut() {
                player.tick().await;
                if let Some((uri, duration)) = history.observe(&player.local_state()) {
                    let api = api.clone();
                    tasks.spawn(async move { let _ = api.record_play(&uri, duration).await; Done::Events(vec![]) });
                }
            } }
            Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                match result {
                    Ok(Done::Auth(Ok((signed_api, Some(user))))) => {
                        api = signed_api;
                        http.replace(api.client());
                        account = user.id.clone();
                        match MusicPlayer::new(api.clone(), config.clone(), events.clone(), waker.clone()).await {
                            Ok(new_player) => {
                                emit(&events, &waker, Event::Local(Box::new(new_player.local_state())));
                                player = Some(new_player);
                                emit(&events, &waker, Event::Playback(LocalPlayback::Ready { device_id: "streamarena".into() }));
                            }
                            Err(error) => emit(&events, &waker, Event::Playback(LocalPlayback::Failed(error))),
                        }
                        emit(&events, &waker, Event::Auth(AuthStatus::Connected { username: user.display_name.clone().unwrap_or_else(|| user.id.clone()) }));
                        emit(&events, &waker, Event::Api(Box::new(ApiResponse::Me(Ok(user)))));
                        if let Some(cookie) = api.export_session_cookie() {
                            let sessions = sessions.clone();
                            tasks.spawn(async move { Done::SessionSaved(sessions.write(cookie).await) });
                        }
                    }
                    Ok(Done::Auth(Ok((_, None)))) => emit(&events, &waker, Event::Auth(AuthStatus::SignedOut)),
                    Ok(Done::Auth(Err(error))) => emit(&events, &waker, Event::Auth(AuthStatus::Failed(error))),
                    Ok(Done::Events(values)) => {
                        if !api.session_expired() {
                            for event in values { emit(&events, &waker, event); }
                        }
                    }
                    Ok(Done::SessionSaved(Ok(()))) => { let _ = tokio::fs::remove_file(&revoked).await; }
                    Ok(Done::SessionSaved(Err(error))) => emit(&events, &waker, Event::Error(error)),
                    Err(error) if !error.is_cancelled() => emit(&events, &waker, Event::Error("A background request failed. Please try again.".into())),
                    _ => {},
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { break; };
                match command {
                    Command::Shutdown => break,
                    Command::MusicSignIn { email, password } => {
                        tasks.abort_all();
                        // Drain cancelled tasks before queuing a new account generation.
                        while tasks.join_next().await.is_some() {}
                        player = None;
                        history.finish();
                        account.clear();
                        let _ = tokio::fs::create_dir_all(&dirs.state).await;
                        let _ = tokio::fs::write(&revoked, b"signing in").await;
                        let _deletion = sessions.request_delete();
                        emit(&events, &waker, Event::Playback(LocalPlayback::Unavailable));
                        emit(&events, &waker, Event::Local(Box::default()));
                        emit(&events, &waker, Event::Auth(AuthStatus::Connecting));
                        match MusicApi::new(&origin, http.clone()) {
                            Ok(fresh_api) => {
                                api = fresh_api.clone();
                                http.replace(api.client());
                                tasks.spawn(async move {
                                    let result = fresh_api.sign_in(&email, &password).await.map(|user| (fresh_api, Some(user)));
                                    Done::Auth(result)
                                })
                            },
                            Err(error) => { emit(&events, &waker, Event::Auth(AuthStatus::Failed(error))); continue; }
                        };
                    }
                    Command::CancelSignIn => {
                        tasks.abort_all();
                        while tasks.join_next().await.is_some() {}
                        player = None;
                        history.finish();
                        account.clear();
                        let _ = tokio::fs::create_dir_all(&dirs.state).await;
                        let _ = tokio::fs::write(&revoked, b"sign in cancelled").await;
                        let _deletion = sessions.request_delete();
                        if let Ok(fresh) = MusicApi::new(&origin, http.clone()) { api = fresh; http.replace(api.client()); }
                        emit(&events, &waker, Event::Playback(LocalPlayback::Unavailable));
                        emit(&events, &waker, Event::Local(Box::default()));
                        emit(&events, &waker, Event::Auth(AuthStatus::SignedOut));
                    }
                    Command::SignOut => {
                        tasks.abort_all();
                        while tasks.join_next().await.is_some() {}
                        player = None;
                        let _ = tokio::fs::create_dir_all(&dirs.state).await;
                        let _ = tokio::fs::write(&revoked, b"signed out").await;
                        let old_api = api.clone(); let deletion = sessions.request_delete();
                        let listen = history.finish();
                        // Sign-out revocation is not cancelled by a subsequent sign-in.
                        tokio::spawn(async move {
                            let _ = deletion.await;
                            if let Some((uri, duration)) = listen { let _ = old_api.record_play(&uri, duration).await; }
                            let _ = old_api.sign_out().await;
                        });
                        if let Ok(fresh) = MusicApi::new(&origin, http.clone()) { api = fresh; http.replace(api.client()); }
                        account.clear();
                        emit(&events, &waker, Event::Playback(LocalPlayback::Unavailable));
                        emit(&events, &waker, Event::Local(Box::default()));
                        emit(&events, &waker, Event::Auth(AuthStatus::SignedOut));
                    }
                    Command::Player(command) => {
                        if let Some(player) = player.as_mut() { player.command(command).await; }
                    }
                    Command::Api(request) => {
                        let response = match (&request, player.as_ref()) {
                            (ApiRequest::Devices, Some(player)) => Some(ApiResponse::Devices(Ok(vec![device(player)]))),
                            (ApiRequest::Queue { seq }, Some(player)) => Some(ApiResponse::Queue { seq: *seq, result: Ok(queue(&api, player)) }),
                            (ApiRequest::PlaybackState { seq }, Some(player)) => {
                                let state = player.local_state();
                                Some(ApiResponse::PlaybackState { seq: *seq, result: Ok(Some(PlaybackState {
                                    device: Some(device(player)), repeat_state: state.repeat.api_name().into(), shuffle_state: state.shuffle,
                                    progress_ms: Some(state.position_now()), is_playing: state.playback == Playback::Playing,
                                    item: queue(&api, player).currently_playing,
                                    context: player.context_uri().map(|uri| Context { kind: crate::util::uri_kind(uri).unwrap_or("playlist").into(), uri: uri.into(), ..Default::default() }),
                                    ..Default::default()
                                })) })
                            }
                            _ => None,
                        };
                        if let Some(response) = response { emit(&events, &waker, Event::Api(Box::new(response))); }
                        else {
                            let api = api.clone();
                            tasks.spawn(async move { Done::Events(api.handle(request).await.into_iter().map(|response| Event::Api(Box::new(response))).collect()) });
                        }
                    }
                    Command::Lyrics(request) => {
                        let api = api.clone();
                        tasks.spawn(async move {
                            let result = async {
                                let song = api.song_metadata(&request.uri).await?;
                                let Some(url) = song.lyrics_url.filter(|url| !url.is_empty()) else { return Ok(None); };
                                let response = api.client().get(&url).send().await.map_err(|_| "Could not load lyrics".to_string())?;
                                if !response.status().is_success() { return Ok(None); }
                                let text = response.text().await.map_err(|_| "Could not read lyrics".to_string())?;
                                Ok(parse_music_lyrics(&text))
                            }.await;
                            Done::Events(vec![Event::Lyrics { uri: request.uri, result }])
                        });
                    }
                    Command::LoadLikedSongsCache { generation } => {
                        let path = dirs.state.join("music-liked.json"); let account = account.clone();
                        tasks.spawn(async move { let cache = crate::liked::read(&path, &account).await;
                            Done::Events(vec![Event::LikedSongsCache { account_id: account, generation, cache }]) });
                    }
                    Command::StoreLikedSongsCache(cache) => {
                        if cache.account_id == account {
                            let path = dirs.state.join("music-liked.json");
                            tasks.spawn(async move { let _ = crate::liked::write(&path, &cache).await; Done::Events(vec![]) });
                        }
                    }
                    Command::LoadPlaylistCache { id, generation } => emit(&events, &waker, Event::PlaylistCache { account_id: account.clone(), id, generation, cache: None }),
                    Command::StorePlaylistCache { id, generation, snapshot, .. } => emit(&events, &waker, Event::PlaylistCacheStored { account_id: account.clone(), id, generation, snapshot, success: false }),
                    Command::OpenThemesFolder => { let _ = open::that(dirs.config.join("themes")); }
                    Command::Rootlist => emit(&events, &waker, Event::Rootlist { result: Ok(Default::default()) }),
                    Command::UserNames(ids) => { for id in ids { emit(&events, &waker, Event::UserName { id, name: None }); } }
                    Command::AlbumTypes(_) | Command::AudiobookShows(_) => {},
                    // Spotify auth, network discovery, self-updates and remote control are
                    // intentionally unreachable: this application talks only to our service.
                    _ => {},
                }
            }
        }
    }
    if let Some((uri, duration)) = history.finish() {
        let _ = tokio::time::timeout(Duration::from_secs(3), api.record_play(&uri, duration)).await;
    }
    tasks.abort_all();
    drop(player);
}

/// Our server stores both LRC and plain-text lyric sidecars.
fn parse_music_lyrics(text: &str) -> Option<crate::lyrics::Lyrics> {
    let text = text.trim().trim_start_matches('\u{feff}');
    let timed = crate::lyrics::parse_lrc(text);
    let synced = !timed.is_empty();
    let lines = if synced {
        timed
    } else {
        text.lines()
            .filter(|line| {
                let line = line.trim().to_ascii_lowercase();
                !["[ar:", "[ti:", "[al:", "[by:", "[offset:"]
                    .iter()
                    .any(|prefix| line.starts_with(prefix))
            })
            .map(|line| crate::lyrics::Line {
                at_ms: None,
                text: line.trim_end().into(),
            })
            .collect()
    };
    lines
        .iter()
        .any(|line| !line.text.trim().is_empty())
        .then_some(crate::lyrics::Lyrics {
            lines,
            synced,
            instrumental: false,
        })
}

#[cfg(test)]
mod tests {
    use super::parse_music_lyrics;
    #[test]
    fn service_lyrics_preserve_plain_text_and_stanza_breaks() {
        let lyrics = parse_music_lyrics("[ar:Test artist]\nFirst line\n\nSecond line").unwrap();
        assert!(!lyrics.synced);
        assert_eq!(
            lyrics
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            ["First line", "", "Second line"]
        );
        assert!(lyrics.lines.iter().all(|line| line.at_ms.is_none()));
        assert!(parse_music_lyrics(" \n[ar:Metadata only]").is_none());
    }
    #[test]
    fn service_lyrics_preserve_timed_lines() {
        let lyrics = parse_music_lyrics("[00:01.20]First line\n[00:03]Second line").unwrap();
        assert!(lyrics.synced);
        assert_eq!(lyrics.lines[0].at_ms, Some(1200));
        assert_eq!(lyrics.lines[1].at_ms, Some(3000));
    }
}
