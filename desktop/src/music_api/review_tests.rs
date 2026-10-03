//! Cross-layer regressions found by comparing the adapter with server routes.
use super::tests::{Server, error, reply, song};
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn refreshing_catalog_metadata_keeps_a_promoted_song_liked() {
    let server = Server::new(|request| match request.path.as_str() {
        "/api/discover/promote" => reply(song("already-owned-file")),
        "/api/likes" => reply(json!({"likedSongIds":["already-owned-file"]})),
        _ => error(404),
    });
    let api = server.api();
    let mut catalog = song("discover:ABCDEFGHIJKLMNOPQRSTUV");
    catalog["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
    catalog["audioUrl"] = json!("");
    catalog["preview"] = json!(true);
    let original = api.remember(decode(catalog.clone()).unwrap());
    let uri = original.uri();
    let promoted = api.promote(&original).await.unwrap();
    assert_eq!(promoted.id, "already-owned-file");
    // The real catalog endpoint continues returning its discover identity after
    // promotion. Reopening search/artist/playlist must not erase the alias.
    api.songs(&json!({"songs":[catalog]})).unwrap();
    let response = api
        .handle(ApiRequest::Contains {
            uris: vec![uri.clone()],
        })
        .await;
    assert!(
        matches!(&response[0], ApiResponse::Contains { result: Ok(flags), .. } if flags == &[true])
    );
    assert_eq!(
        api.resolve_song(&uri).await.unwrap().id,
        "already-owned-file"
    );
}

#[tokio::test]
async fn mini_folder_detail_without_editability_stays_readonly() {
    let writes = Arc::new(AtomicU64::new(0));
    let recorded = writes.clone();
    let server = Server::new(move |request| {
        if request.method != "GET" {
            recorded.fetch_add(1, Ordering::SeqCst);
            return reply(json!({"ok":true}));
        }
        // This is the actual unconverted Mini folder detail shape, unlike the
        // merged /library card, which explicitly contains editable:false.
        reply(
            json!({"kind":"library","playlist":{"id":"local-folder-test","name":"Folder","userId":"owner"},"songs":[song("one")]}),
        )
    });
    let api = server.api();
    let detail = api
        .handle(ApiRequest::Playlist {
            id: "local-folder-test".into(),
            generation: 1,
        })
        .await;
    assert!(
        matches!(&detail[0], ApiResponse::Playlist { result: Ok(playlist), .. } if playlist.owner.id.is_none())
    );
    let result = api
        .handle(ApiRequest::UpdatePlaylist {
            id: "local-folder-test".into(),
            name: Some("Renamed".into()),
            public: None,
            description: None,
        })
        .await;
    assert!(matches!(
        &result[0],
        ApiResponse::PlaylistUpdated { result: Err(_), .. }
    ));
    assert_eq!(writes.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unlike_waits_for_earlier_catalog_promotion_and_wins_on_the_server() {
    let liked = Arc::new(AtomicBool::new(false));
    let promote_started = Arc::new(tokio::sync::Notify::new());
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let server = Server::new({
        let liked = liked.clone();
        let started = promote_started.clone();
        let gate = gate.clone();
        move |request| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/likes") => reply(
                json!({"likedSongIds":if liked.load(Ordering::SeqCst) { vec!["physical-file"] } else { vec![] }}),
            ),
            ("POST", "/api/discover/promote") => {
                started.notify_one();
                let (lock, ready) = &*gate;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = ready.wait(released).unwrap();
                }
                reply(song("physical-file"))
            }
            ("POST", "/api/likes") => {
                liked.store(true, Ordering::SeqCst);
                reply(json!({"ok":true}))
            }
            ("DELETE", "/api/likes") => {
                liked.store(false, Ordering::SeqCst);
                reply(json!({"ok":true}))
            }
            _ => error(404),
        }
    });
    struct Release(Arc<(Mutex<bool>, std::sync::Condvar)>);
    impl Drop for Release {
        fn drop(&mut self) {
            *self.0.0.lock().unwrap() = true;
            self.0.1.notify_all();
        }
    }
    // Release before the fixture's blocking server joins, including on failure.
    let release = Release(gate);
    let api = server.api();
    let mut catalog = song("discover:ABCDEFGHIJKLMNOPQRSTUV");
    catalog["discoverTrackId"] = json!("ABCDEFGHIJKLMNOPQRSTUV");
    catalog["preview"] = json!(true);
    let uri = api.remember(decode(catalog).unwrap()).uri();
    let like = tokio::spawn({
        let api = api.clone();
        let uri = uri.clone();
        async move { api.set_saved(&[uri], true).await }
    });
    tokio::time::timeout(Duration::from_secs(2), promote_started.notified())
        .await
        .unwrap();
    let revision = api.state.lock().unwrap().cache_revision;
    let unlike = tokio::spawn({
        let api = api.clone();
        async move { api.set_saved(&[uri], false).await }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        api.state.lock().unwrap().cache_revision,
        revision,
        "A later unlike must not send a mutation while its earlier like is still promoting"
    );
    drop(release);
    tokio::time::timeout(Duration::from_secs(2), like)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), unlike)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        !liked.load(Ordering::SeqCst),
        "The last click must win on the server"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_started_before_a_like_cannot_restore_stale_like_data() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let first_seen = Arc::new(tokio::sync::Notify::new());
    let release_first = Arc::new(tokio::sync::Notify::new());
    let stored = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicU64::new(0));
    let server = tokio::spawn({
        let first_seen = first_seen.clone();
        let release_first = release_first.clone();
        let stored = stored.clone();
        let reads = reads.clone();
        async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let first_seen = first_seen.clone();
                let release_first = release_first.clone();
                let stored = stored.clone();
                let reads = reads.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    let mut buffer = [0; 4096];
                    let header = loop {
                        let count = socket.read(&mut buffer).await.unwrap_or(0);
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..count]);
                        if let Some(end) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&bytes[..end]);
                            let length = header
                                .lines()
                                .filter_map(|line| line.split_once(':'))
                                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, length)| length.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                break header.into_owned();
                            }
                        }
                    };
                    let value = if header.starts_with("GET /api/likes ") {
                        let snapshot = stored.load(Ordering::SeqCst);
                        if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                            first_seen.notify_one();
                            release_first.notified().await;
                        }
                        json!({"likedSongIds":if snapshot { vec!["new-like"] } else { vec![] }})
                    } else if header.starts_with("POST /api/likes ") {
                        stored.store(true, Ordering::SeqCst);
                        json!({"ok":true})
                    } else {
                        json!({})
                    };
                    let body = value.to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        }
    });
    let api = MusicApi::new(&origin, Http::default()).unwrap();
    let old_read = tokio::spawn({
        let api = api.clone();
        async move { api.get("/api/likes").await }
    });
    tokio::time::timeout(Duration::from_secs(2), first_seen.notified())
        .await
        .unwrap();
    api.write(Method::POST, "/api/likes", json!({"songId":"new-like"}))
        .await
        .unwrap();
    release_first.notify_one();
    let value = tokio::time::timeout(Duration::from_secs(2), old_read)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        value["likedSongIds"],
        json!(["new-like"]),
        "A stale in-flight result must not reach the UI"
    );
    assert_eq!(
        api.get("/api/likes").await.unwrap()["likedSongIds"],
        json!(["new-like"]),
        "The next reader must not see a repopulated stale cache"
    );
    server.abort();
}
