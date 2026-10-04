use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::AtomicBool;

#[derive(Clone, Debug)]
pub(super) struct Seen {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) cookie: String,
    pub(super) body: Value,
}
pub(super) struct Reply {
    status: u16,
    body: Value,
    headers: Vec<(&'static str, &'static str)>,
}
pub(super) fn reply(body: Value) -> Reply {
    Reply {
        status: 200,
        body,
        headers: vec![],
    }
}
pub(super) fn error(status: u16) -> Reply {
    Reply {
        status,
        body: json!({"error":"Provider unavailable"}),
        headers: vec![],
    }
}
pub(super) struct Server {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub(super) fn new(handler: impl Fn(&Seen) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let captured = seen.clone();
        let stopping = stop.clone();
        let fixture_url = url.clone();
        let thread = std::thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(socket) => socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(_) => break,
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let request = loop {
                    let count = match stream.read(&mut buffer) {
                        Ok(count) => count,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => panic!(
                            "Music API fixture could not read its request after {} bytes: {error}",
                            bytes.len()
                        ),
                    };
                    if count == 0 {
                        break None;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]);
                        let length: usize = header
                            .lines()
                            .find_map(|line| {
                                line.split_once(':')
                                    .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                    .and_then(|(_, v)| v.trim().parse().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() < end + 4 + length {
                            continue;
                        }
                        let mut first = header.lines().next().unwrap().split_whitespace();
                        break Some(Seen {
                            method: first.next().unwrap().into(),
                            path: first.next().unwrap().into(),
                            cookie: header
                                .lines()
                                .find_map(|l| {
                                    l.split_once(':')
                                        .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
                                        .map(|(_, v)| v.trim().to_string())
                                })
                                .unwrap_or_default(),
                            body: serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                                .unwrap_or(Value::Null),
                        });
                    }
                };
                let Some(request) = request else {
                    continue;
                };
                // Preserve the exact request before invoking assertions so a
                // fixture panic remains diagnosable under the parallel suite.
                captured.lock().unwrap().push(request.clone());
                let response =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&request)))
                        .unwrap_or_else(|failure| {
                            eprintln!(
                                "Music API fixture {fixture_url} handler failed for {} {:?}",
                                request.method,
                                request.path.split('?').next().unwrap_or_default()
                            );
                            std::panic::resume_unwind(failure)
                        });
                let body = response.body.to_string();
                let headers = response
                    .headers
                    .iter()
                    .map(|(k, v)| format!("{k}: {v}\r\n"))
                    .collect::<String>();
                let wire = format!(
                    "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                    response.status,
                    body.len()
                );
                let _ = stream.write_all(wire.as_bytes());
            }
        });
        Self {
            url,
            seen,
            stop,
            thread: Some(thread),
        }
    }
    pub(super) fn api(&self) -> MusicApi {
        MusicApi::new(&self.url, Http::default()).unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            if let Err(failure) = thread.join() {
                // Keep fixture assertions fatal on normal teardown, but never
                // start a second panic while the failed request is unwinding.
                if !std::thread::panicking() {
                    std::panic::resume_unwind(failure);
                }
            }
        }
    }
}
pub(super) fn song(id: &str) -> Value {
    json!({"id":id,"title":"A Song","artist":"The Artist","album":"Record","duration":123.5,"imageUrl":"/api/artwork/local/a%2520b.webp?spotify_sig=a%2Fb&spotify_exp=9999999999","audioUrl":"/api/files/local/a%2520b.flac?spotify_sig=a%2Fb&spotify_exp=9999999999"})
}

#[test]
fn validates_origin_and_saved_cookie_without_exposing_tokens() {
    for url in [
        "http://music.example",
        "https://user:secret@example.com",
        "https://example.com/api",
        "https://example.com/?token=x",
    ] {
        assert!(MusicApi::new(url, Http::default()).is_err());
    }
    let api = MusicApi::new("https://music.example", Http::default()).unwrap();
    for token in ["", "a;b", "x\r\nCookie:y", "a b"] {
        assert!(api.restore_session_cookie(token).is_err());
    }
    api.restore_session_cookie("safe_session_token").unwrap();
    assert_eq!(
        api.export_session_cookie().as_deref(),
        Some("safe_session_token")
    );
    assert!(
        api.jar
            .cookies(&Url::parse("https://other.example/").unwrap())
            .is_none()
    );
    assert_eq!(
        segment("catalog:opaque/id?x=1"),
        "catalog:opaque%2Fid%3Fx=1"
    );
}

#[tokio::test]
async fn cookie_session_round_trip_and_account_clients_are_independent() {
    let server = Server::new(|r| match r.path.as_str() {
        "/api/auth/signin" => {
            assert_eq!(r.body["email"], "person@example.com");
            let mut response =
                reply(json!({"user":{"id":"account1","name":"Listener","image":"/avatar.png"}}));
            response.headers = vec![
                (
                    "Set-Cookie",
                    "spotify_session=first-token; Path=/; HttpOnly",
                ),
                ("Set-Cookie", "unrelated=not-exported; Path=/"),
            ];
            response
        }
        "/api/auth/session" => reply(
            json!({"user":{"id":if r.cookie.contains("first-token") {"account1"} else {"account2"}}}),
        ),
        "/api/auth/signout" => reply(Value::Null),
        _ => error(404),
    });
    let shared = Http::default();
    let first = MusicApi::new(&server.url, shared.clone()).unwrap();
    let user = first
        .sign_in("person@example.com", "not-logged")
        .await
        .unwrap();
    assert_eq!(user.name(), "Listener");
    assert_eq!(user.images[0].url, format!("{}/avatar.png", server.url));
    assert_eq!(
        first.export_session_cookie().as_deref(),
        Some("first-token")
    );
    let second = MusicApi::new(&server.url, shared.clone()).unwrap();
    second.restore_session_cookie("second-token").unwrap();
    shared.replace(second.client());
    assert_eq!(first.session().await.unwrap().unwrap().id, "account1");
    assert_eq!(second.session().await.unwrap().unwrap().id, "account2");
    first.sign_out().await.unwrap();
    assert!(first.export_session_cookie().is_none());
    assert_eq!(
        second.export_session_cookie().as_deref(),
        Some("second-token")
    );
    assert!(
        server
            .seen
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.path == "/api/auth/signout")
            .unwrap()
            .cookie
            .contains("first-token")
    );
}

#[tokio::test]
async fn home_requests_share_fetch_and_preserve_generation_duration_and_signed_paths() {
    let server = Server::new(|_| {
        reply(
            json!({"recentlyPlayed":[song("opaque:id")],"mostPlayed":[{"song":song("opaque:id"),"playCount":2}]}),
        )
    });
    let api = server.api();
    let (recent, top) = tokio::join!(
        api.handle(ApiRequest::RecentlyPlayed {
            who: crate::backend::RecentsFor::Home,
            generation: 42,
            before: None,
            limit: 20
        }),
        api.handle(ApiRequest::TopTracks {
            offset: 0,
            full: false,
            generation: 17
        })
    );
    assert!(
        matches!(&recent[0], ApiResponse::RecentlyPlayed { generation:42, result:Ok(page), .. } if page.items[0].track.duration_ms==123_500 && page.items[0].played_at.is_none())
    );
    assert!(
        matches!(&top[0], ApiResponse::TopTracks { generation:17, result:Ok(page), .. } if page.items[0].uri=="spotify:track:opaque:id")
    );
    assert_eq!(server.seen.lock().unwrap().len(), 1);
    let resolved = api.resolve_song("spotify:track:opaque:id").await.unwrap();
    assert!(
        resolved
            .audio_url
            .ends_with("a%2520b.flac?spotify_sig=a%2Fb&spotify_exp=9999999999")
    );
    assert_eq!(
        resolved.local_track("spotify:track:opaque:id").duration_ms,
        123_500
    );
}

#[tokio::test]
async fn search_merges_library_first_and_retains_provider_album_and_playlist_identity() {
    let server = Server::new(|r| {
        if r.path.starts_with("/api/search-index") {
            reply(json!({"songs":[song("local")]}))
        } else if r.path.starts_with("/api/search/catalog") {
            reply(
                json!({"results":[song("duplicate")],"artists":[{"id":"artist1","name":"The Artist","imageUrl":"/artist.jpg"}],"playlists":[{"id":"external","name":"Catalog list","provider":"spotify","trackCount":8}]}),
            )
        } else {
            reply(
                json!({"albums":[{"id":"OLAK5uy_album","provider":"youtube","name":"Record","artist":"Artist"}]}),
            )
        }
    });
    let api = server.api();
    let result = api
        .handle(ApiRequest::Search {
            query: "song & artist".into(),
            serial: 44,
        })
        .await;
    let ApiResponse::Search {
        serial,
        result: Ok(result),
        ..
    } = &result[0]
    else {
        panic!("Search failed");
    };
    assert_eq!(*serial, 44);
    assert_eq!(result.tracks.as_ref().unwrap().items.len(), 1);
    assert_eq!(
        result.tracks.as_ref().unwrap().items[0].id.as_deref(),
        Some("local")
    );
    assert_eq!(
        result.albums.as_ref().unwrap().items[0].id,
        "youtube:OLAK5uy_album"
    );
    assert_eq!(
        result.playlists.as_ref().unwrap().items[0].id,
        "catalog:external"
    );
    assert!(
        server
            .seen
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.path.contains("q=song+%26+artist"))
    );
}

#[tokio::test]
async fn staging_preserves_placeholder_alias_and_never_saves_on_play() {
    let server = Server::new(|r| {
        assert_eq!(r.path, "/api/discover/stage");
        assert_eq!(r.body["preview"], true);
        let mut value = song("staged-file");
        value["staged"] = json!(true);
        reply(value)
    });
    let api = server.api();
    let mut value = song("discover:abc");
    value["audioUrl"] = json!("");
    value["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
    value["preview"] = json!(true);
    api.remember(decode(value).unwrap());
    let actual = api
        .resolve_song("spotify:track:discover:abc")
        .await
        .unwrap();
    assert_eq!(actual.id, "staged-file");
    assert!(actual.staged && actual.preview);
    assert_eq!(
        actual.discover_track_id.as_deref(),
        Some("ABCDEFGHIJKLMNOPQRSTUV")
    );
    assert!(api.track_for_uri("spotify:track:discover:abc").is_some());
    // Both the placeholder and staged identity should replay without another
    // server-side staging request while their media URL remains usable.
    assert_eq!(
        api.resolve_song("spotify:track:discover:abc")
            .await
            .unwrap()
            .audio_url,
        actual.audio_url
    );
    assert_eq!(
        api.resolve_song(&actual.uri()).await.unwrap().audio_url,
        actual.audio_url
    );
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn staging_keeps_catalog_duration_when_the_media_response_omits_it() {
    for (duration, expected) in [
        (None, 123_500),
        (Some(0.0), 123_500),
        (Some(121.75), 121_750),
    ] {
        let server = Server::new(move |r| {
            assert_eq!(r.path, "/api/discover/stage");
            assert_eq!(r.body["durationMs"], 123_500);
            let mut value = song("staged-file");
            value["duration"] = json!(duration);
            reply(value)
        });
        let api = server.api();
        let mut value = song("discover:abc");
        value["audioUrl"] = json!("");
        value["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
        api.remember(decode(value).unwrap());

        let resolved = api
            .resolve_song("spotify:track:discover:abc")
            .await
            .unwrap();
        assert_eq!(resolved.duration_ms, expected);
        assert_eq!(
            resolved
                .local_track("spotify:track:discover:abc")
                .duration_ms,
            expected
        );
        assert_eq!(
            api.resolve_song(&resolved.uri()).await.unwrap().duration_ms,
            expected
        );
        assert_eq!(server.seen.lock().unwrap().len(), 1);
    }
}

#[test]
fn partial_metadata_cannot_erase_a_known_track_duration() {
    let api = MusicApi::new("https://music.example.test", crate::http::Http::default()).unwrap();
    api.remember(decode(song("track")).unwrap());
    for duration in [Value::Null, json!(0)] {
        let mut value = song("track");
        value["duration"] = duration;
        let remembered = api.remember(decode(value).unwrap());
        assert_eq!(remembered.duration_ms, 123_500);
        assert_eq!(remembered.duration, Some(123.5));
    }
    let mut corrected = song("track");
    corrected["duration"] = json!(121.75);
    assert_eq!(
        api.remember(decode(corrected).unwrap()).duration_ms,
        121_750
    );
}

#[tokio::test]
async fn cached_staged_preview_still_refreshes_expired_or_missing_media() {
    let server = Server::new(|r| {
        assert_eq!(r.path, "/api/discover/stage");
        assert_eq!(r.body["preview"], true);
        reply(song("staged-file"))
    });
    let api = server.api();
    let mut value = song("staged-file");
    value["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
    value["preview"] = json!(true);
    value["staged"] = json!(true);
    value["audioUrl"] =
        json!("/api/files/local/.discover/track/song.opus?spotify_exp=1&spotify_sig=old");
    api.remember(decode(value).unwrap());
    let refreshed = api.resolve_song("spotify:track:staged-file").await.unwrap();
    assert!(refreshed.audio_url.contains("spotify_exp=9999999999"));
    // Explicit refresh is also used by the media bridge after a pruned cache
    // entry or rejected signature; it must bypass the fast replay path.
    api.refresh_song("spotify:track:staged-file").await.unwrap();
    assert_eq!(server.seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn provider_previews_never_bypass_full_track_staging() {
    let server = Server::new(|r| {
        assert_eq!(r.path, "/api/discover/stage");
        assert_eq!(r.body["preview"], true);
        reply(song("staged-file"))
    });
    let api = server.api();
    for (audio, staged) in [
        ("https://preview.example/clip.mp3", true),
        ("/preview/clip.mp3", true),
        ("/api/files/local/song.opus", false),
        ("", true),
    ] {
        let mut value = song("discover:provider");
        value["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
        value["preview"] = json!(true);
        value["staged"] = json!(staged);
        value["audioUrl"] = json!(audio);
        api.remember(decode(value).unwrap());
        let resolved = api
            .resolve_song("spotify:track:discover:provider")
            .await
            .unwrap();
        assert!(resolved.audio_url.starts_with(api.base_url()));
        assert!(resolved.audio_url.contains("/api/files/local/"));
    }
    assert_eq!(server.seen.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn expiring_local_media_and_explicit_retry_refresh_the_song_detail() {
    let server = Server::new(|r| {
        assert_eq!(r.path, "/api/songs/local%2Fopaque");
        reply(song("local/opaque"))
    });
    let api = server.api();
    let mut expired = song("local/opaque");
    expired["audioUrl"] = json!("/audio.flac?spotify_exp=1&spotify_sig=old");
    api.remember(decode(expired).unwrap());
    let refreshed = api
        .resolve_song("spotify:track:local/opaque")
        .await
        .unwrap();
    assert!(refreshed.audio_url.contains("spotify_exp=9999999999"));
    api.refresh_song("spotify:track:local/opaque")
        .await
        .unwrap();
    assert_eq!(server.seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn failed_download_does_not_discard_a_catalog_like() {
    let server = Server::new(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/api/likes") => reply(json!({"likedSongIds":[]})),
        (_, "/api/discover/promote") => error(503),
        ("POST", "/api/likes") => {
            assert_eq!(r.body["song"]["discoverTrackId"], "ABCDEFGHIJKLMNOPQRSTUV");
            assert_eq!(r.body["song"]["duration"], 123.5);
            reply(json!({"ok":true}))
        }
        _ => error(404),
    });
    let api = server.api();
    let mut value = song("discover:abc");
    value["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
    value["audioUrl"] = json!("");
    api.remember(decode(value).unwrap());
    let result = api
        .handle(ApiRequest::SetSaved {
            uris: vec!["spotify:track:discover:abc".into()],
            saved: true,
        })
        .await;
    assert!(matches!(
        &result[0],
        ApiResponse::SavedChanged { result: Ok(()), .. }
    ));
    assert!(
        server
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.path == "/api/likes" && r.method == "POST")
    );
}

#[tokio::test]
async fn readonly_playlist_rejects_mutation_and_all_songs_is_a_real_context() {
    let server = Server::new(|r| {
        if r.path == "/api/songs" {
            reply(json!([song("one"), song("two")]))
        } else {
            reply(
                json!({"kind":"curated","playlist":{"id":"discover-top50","name":"Top 50"},"songs":[song("one")]}),
            )
        }
    });
    let api = server.api();
    let result = api
        .handle(ApiRequest::UpdatePlaylist {
            id: "discover-top50".into(),
            name: Some("Rename".into()),
            public: None,
            description: None,
        })
        .await;
    assert!(matches!(
        &result[0],
        ApiResponse::PlaylistUpdated { result: Err(_), .. }
    ));
    assert_eq!(
        api.resolve_context("spotify:playlist:streamarena-all")
            .await
            .unwrap(),
        vec!["spotify:track:one", "spotify:track:two"]
    );
    assert!(
        server
            .seen
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.method == "GET")
    );
}

#[tokio::test]
async fn playback_history_uses_registry_without_staging_and_drops_network_artwork() {
    let server = Server::new(|r| {
        assert_eq!(r.path, "/api/play-events");
        assert_eq!(r.body["durationMs"], 31_000);
        assert!(r.body["song"].get("networkImageUrl").is_none());
        assert_eq!(r.body["song"]["duration"], 123.5);
        reply(json!({"ok":true}))
    });
    let api = server.api();
    let mut value = song("history");
    value["networkImageUrl"] = json!("https://external.example/art.jpg");
    value["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
    api.remember(decode(value).unwrap());
    api.record_play("spotify:track:history", 31_000)
        .await
        .unwrap();
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}

#[test]
fn paging_and_null_song_fields_are_safe() {
    let items: Vec<u32> = (0..123).collect();
    let page = mapping::page(&items, 100, 50);
    assert_eq!(page.items.len(), 23);
    assert_eq!(page.next_offset(), None);
    assert!(mapping::page(&items, 500, 50).items.is_empty());
    let song: MusicSong =
        decode(json!({"id":"x","title":null,"artist":null,"audioUrl":null,"imageUrl":null}))
            .unwrap();
    assert_eq!(song.title, "");
    assert_eq!(song.artist, "");
}

#[tokio::test]
async fn protected_401_expires_session_but_invalid_signin_does_not() {
    let server = Server::new(|_| error(401));
    let api = server.api();
    assert!(api.sign_in("person@example.com", "wrong").await.is_err());
    assert!(!api.session_expired());
    assert!(api.get("/api/library").await.is_err());
    assert!(api.session_expired());
    api.restore_session_cookie("new-session").unwrap();
    assert!(!api.session_expired());
    assert!(api.session().await.is_err());
    assert!(!api.session_expired());
}

#[tokio::test]
async fn cached_catalog_lyrics_metadata_does_not_stage_audio() {
    let server = Server::new(|_| error(500));
    let api = server.api();
    let mut catalog = song("catalog:lyrics-only");
    catalog["audioUrl"] = json!("");
    catalog["lyricsUrl"] = json!("/api/files/lyrics.lrc?spotify_sig=keep%2Fexact");
    catalog["discoverTrackId"] = json!("lyrics-only");
    catalog["preview"] = json!(true);
    api.remember(decode(catalog).unwrap());

    let metadata = api
        .song_metadata("spotify:track:catalog:lyrics-only")
        .await
        .unwrap();
    assert!(metadata.audio_url.is_empty());
    assert_eq!(
        metadata.lyrics_url.as_deref(),
        Some(
            format!(
                "{}/api/files/lyrics.lrc?spotify_sig=keep%2Fexact",
                server.url
            )
            .as_str()
        )
    );
    assert!(metadata.preview);
    assert!(server.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn liked_songs_without_a_like_time_are_dated_by_their_arrival() {
    let server = Server::new(|r| match r.path.as_str() {
        "/api/liked" => {
            let mut recent = song("recent");
            recent["likedAt"] = json!("2026-09-27T10:00:00.000Z");
            recent["createdAt"] = json!("2025-01-01T00:00:00.000Z");
            let mut legacy = song("legacy");
            legacy["createdAt"] = json!("2024-03-05T08:00:00.000Z");
            let undated = song("undated");
            reply(json!({"songs":[recent, legacy, undated]}))
        }
        _ => error(500),
    });
    let api = server.api();
    let responses = api
        .handle(ApiRequest::SavedTracks {
            offset: 0,
            generation: 1,
        })
        .await;
    let Some(ApiResponse::SavedTracks {
        result: Ok(page), ..
    }) = responses.first()
    else {
        panic!("a page of liked songs");
    };
    let dates: Vec<_> = page
        .items
        .iter()
        .map(|saved| saved.added_at.as_deref())
        .collect();
    assert_eq!(
        dates,
        [
            Some("2026-09-27T10:00:00.000Z"),
            Some("2024-03-05T08:00:00.000Z"),
            None
        ]
    );
}

#[tokio::test]
async fn all_songs_are_dated_by_their_arrival_and_playlists_keep_their_own_dates() {
    let server = Server::new(|r| match r.path.as_str() {
        "/api/songs" => {
            let mut arrived = song("arrived");
            arrived["createdAt"] = json!("2026-05-02T09:00:00.000Z");
            reply(json!({"songs":[arrived]}))
        }
        "/api/playlist/mix" => {
            let mut listed = song("listed");
            listed["createdAt"] = json!("2026-05-02T09:00:00.000Z");
            reply(json!({"playlist":{"id":"mix","name":"Mix"},"songs":[listed]}))
        }
        _ => error(500),
    });
    let api = server.api();
    let mut dates = Vec::new();
    for id in ["streamarena-all", "mix"] {
        let responses = api
            .handle(ApiRequest::PlaylistItems {
                id: id.into(),
                offset: 0,
                generation: 1,
            })
            .await;
        let Some(ApiResponse::PlaylistItems {
            result: Ok(page), ..
        }) = responses.first()
        else {
            panic!("a page of {id}");
        };
        dates.push(page.items[0].added_at.clone());
    }
    // A playlist was not made when its songs reached the library.
    assert_eq!(dates, [Some("2026-05-02T09:00:00.000Z".into()), None]);
}

#[tokio::test]
async fn cold_catalog_metadata_recovers_saved_history_without_staging() {
    let server = Server::new(|r| match r.path.as_str() {
        "/api/songs/catalog:lyrics-only" => error(404),
        "/api/liked" => reply(json!({"songs":[]})),
        "/api/stats/home" => {
            let mut saved = song("saved-history-id");
            saved["audioUrl"] = json!("");
            saved["lyricsUrl"] = json!("/lyrics.lrc");
            saved["discoverTrackId"] = json!("lyrics-only");
            reply(json!({"recentlyPlayed":[saved],"mostPlayed":[]}))
        }
        _ => error(500),
    });
    let api = server.api();
    for _ in 0..2 {
        let metadata = api
            .song_metadata("spotify:track:catalog:lyrics-only")
            .await
            .unwrap();
        assert_eq!(metadata.id, "saved-history-id");
        assert!(metadata.audio_url.is_empty());
        assert!(metadata.lyrics_url.unwrap().ends_with("/lyrics.lrc"));
    }
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert!(seen.iter().all(|r| r.method == "GET"));
    assert!(seen.iter().all(|r| !r.path.contains("/stage")));
}

#[tokio::test]
async fn catalog_uri_resume_recovers_real_history_metadata_before_staging() {
    let server = Server::new(|r| match r.path.as_str() {
        "/api/liked" => reply(json!({"songs":[]})),
        "/api/stats/home" => {
            let mut saved = song("old-stage-file");
            saved["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
            saved["preview"] = json!(true);
            reply(json!({"recentlyPlayed":[saved],"mostPlayed":[]}))
        }
        "/api/discover/stage" => {
            assert_eq!(r.body["title"], "A Song");
            assert_eq!(r.body["artist"], "The Artist");
            reply(song("refreshed-stage"))
        }
        _ => error(404),
    });
    let api = server.api();
    let song = api
        .resolve_song("spotify:track:discover:ABCDEFGHIJKLMNOPQRSTUV")
        .await
        .unwrap();
    assert_eq!(song.id, "refreshed-stage");
    assert_eq!(song.title, "A Song");
    assert_eq!(
        server
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.path == "/api/stats/home")
            .count(),
        1
    );
}

#[tokio::test]
async fn unlike_keeps_raw_identity_when_server_uses_per_file_likes() {
    let server = Server::new(|r| match r.method.as_str() {
        "GET" => reply(json!({"likedSongIds":["raw-copy"]})),
        "DELETE" => {
            assert_eq!(r.body["songId"], "raw-copy");
            reply(json!({"ok":true}))
        }
        _ => error(400),
    });
    let api = server.api();
    let mut copy = song("raw-copy");
    copy["canonicalId"] = json!("canonical-copy");
    api.remember(decode(copy).unwrap());
    api.set_saved(&["spotify:track:raw-copy".into()], false)
        .await
        .unwrap();
}

#[tokio::test]
async fn home_collections_keep_chart_and_mix_identity_and_play_through_our_api() {
    let server = Server::new(|request| match request.path.as_str() {
        "/api/discover/playlists" => reply(json!({"playlists":[
            {"id":"discover-top50","name":"Top 50 - Global","imageUrl":"/global.jpg","songsCount":50},
            {"id":"discover-top50-uk","name":"Top 50 - United Kingdom","imageUrl":"","songsCount":50},
            {"id":"yt-mix-test","name":"Discover Mix","imageUrl":"","songsCount":25}
        ]})),
        "/api/playlist/discover-top50" => reply(json!({"kind":"curated",
            "playlist":{"id":"discover-top50","name":"Top 50 - Global"},"songs":[song("chart-track")]})),
        "/api/playlist/yt-mix-test" => {
            let mut track = song("discover:yt-test");
            track["discoverTrackId"] = json!("yt-test");
            track["youtubeVideoId"] = json!("video-exact");
            track["audioUrl"] = json!("");
            track["preview"] = json!(true);
            reply(
                json!({"kind":"curated","playlist":{"id":"yt-mix-test","name":"Discover Mix","imageUrl":"/first-video-frame.jpg"},"songs":[track]}),
            )
        }
        _ => error(404),
    });
    let api = server.api();
    let responses = api
        .handle(ApiRequest::Discover {
            term: "Top 50".into(),
            generation: 19,
        })
        .await;
    let ApiResponse::Discover {
        generation,
        result: Ok(playlists),
        ..
    } = &responses[0]
    else {
        panic!("missing shelves")
    };
    assert_eq!(*generation, 19);
    assert_eq!(playlists.len(), 3);
    assert_eq!(playlists[0].uri, "spotify:playlist:discover-top50");
    assert!(playlists[0].images[0].url.ends_with("/global.jpg"));
    assert_eq!(playlists[1].images[0].url, "music-cover:uk");
    assert_eq!(playlists[2].owner_name(), "YouTube Music");
    let details = api
        .handle(ApiRequest::Playlist {
            id: playlists[2].id.clone(),
            generation: 20,
        })
        .await;
    let ApiResponse::Playlist {
        result: Ok(detail), ..
    } = &details[0]
    else {
        panic!("missing mix detail")
    };
    assert_eq!(detail.images[0].url, playlists[2].images[0].url);
    assert_eq!(detail.owner_name(), "YouTube Music");
    assert_eq!(
        api.resolve_context(&playlists[0].uri).await.unwrap(),
        vec!["spotify:track:chart-track"]
    );
    let mix = api.context(&playlists[2].uri).await.unwrap();
    assert_eq!(mix[0].youtube_video_id.as_deref(), Some("video-exact"));
    assert!(mix[0].preview && mix[0].audio_url.is_empty());
    assert!(
        server
            .seen
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.method == "GET")
    );
}

#[tokio::test]
async fn personal_home_collections_are_read_only_ordered_and_share_the_home_read() {
    let server = Server::new(|request| {
        assert_eq!(request.path, "/api/stats/home");
        assert_eq!(request.method, "GET");
        reply(
            json!({"recentlyPlayed":[song("recent"),song("favourite"),song("recent")],
            "mostPlayed":[{"song":song("favourite")},{"song":song("recent")}]}),
        )
    });
    let api = server.api();
    let (top, recent) = tokio::join!(
        api.collection("streamarena-top", 0),
        api.collection("streamarena-recent", 0)
    );
    let top = top.unwrap();
    let recent = recent.unwrap();
    assert_eq!(top.playlist.unwrap().name, "On repeat");
    assert_eq!(
        top.songs
            .iter()
            .map(|song| song.id.as_str())
            .collect::<Vec<_>>(),
        vec!["favourite", "recent"]
    );
    assert_eq!(
        recent
            .songs
            .iter()
            .map(|song| song.id.as_str())
            .collect::<Vec<_>>(),
        vec!["recent", "favourite"]
    );
    assert_eq!(recent.playlist.unwrap().editable, Some(false));
    assert!(api.editable_playlist("streamarena-top").await.is_err());
    assert_eq!(
        api.resolve_context("spotify:playlist:streamarena-recent")
            .await
            .unwrap(),
        vec!["spotify:track:recent", "spotify:track:favourite"]
    );
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}
