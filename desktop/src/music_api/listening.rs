//! The website's curated radio and podcast catalogue, played by the native engine.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Catalogue {
    stations: Vec<MusicSong>,
    shows: Vec<Podcast>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Podcast {
    id: String,
    title: String,
    author: String,
    description: String,
    feed_url: String,
    website_url: String,
    image_url: String,
}

impl Podcast {
    fn show(&self) -> view::Show {
        view::Show {
            id: format!("streamarena:{}", self.id),
            uri: format!("spotify:show:streamarena:{}", self.id),
            name: self.title.clone(),
            publisher: self.author.clone(),
            description: self.description.clone(),
            images: mapping::images(Some(&self.image_url)),
            external_urls: view::ExternalUrls {
                spotify: Some(self.website_url.clone()),
            },
            ..Default::default()
        }
    }
}

impl MusicApi {
    /// Read-only collections of actual listening history. Reuses the Home read,
    /// so opening a card doesn't download or permanently save any music.
    pub(super) async fn listening_history_collection(&self, id: &str) -> Result<Collection> {
        let value = self.get("/api/stats/home").await?;
        let top = id == "streamarena-top";
        let raw = if top {
            Value::Array(
                value
                    .get("mostPlayed")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.get("song").cloned())
                    .collect(),
            )
        } else {
            value
                .get("recentlyPlayed")
                .cloned()
                .unwrap_or_else(|| json!([]))
        };
        let mut seen = HashSet::new();
        let songs: Vec<_> = self
            .songs(&raw)?
            .into_iter()
            .filter(|song| seen.insert(song.uri()))
            .collect();
        Ok(Collection {
            kind: Some("curated".into()),
            playlist: Some(MusicPlaylist {
                id: id.into(),
                name: if top { "On repeat" } else { "Recently played" }.into(),
                description: Some(
                    if top {
                        "The songs you keep coming back to."
                    } else {
                        "Pick up where you left off."
                    }
                    .into(),
                ),
                image_url: Some(
                    if top {
                        "music-cover:repeat"
                    } else {
                        "music-cover:recent"
                    }
                    .into(),
                ),
                owner_name: Some("Your listening history".into()),
                songs_count: Some(songs.len() as u32),
                editable: Some(false),
                ..Default::default()
            }),
            songs,
            ..Default::default()
        })
    }

    async fn listening_catalogue(&self) -> Result<Catalogue> {
        decode(self.get("/api/listening").await?)
    }

    pub(super) async fn radio_collection(&self) -> Result<Collection> {
        let songs = self
            .listening_catalogue()
            .await?
            .stations
            .into_iter()
            .map(|song| self.remember(song))
            .collect::<Vec<_>>();
        Ok(Collection {
            kind: Some("curated".into()),
            playlist: Some(MusicPlaylist {
                id: "streamarena-radio".into(),
                name: "Radio".into(),
                description: Some("Live stations, always on.".into()),
                editable: Some(false),
                songs_count: Some(songs.len() as u32),
                ..Default::default()
            }),
            songs,
            ..Default::default()
        })
    }

    pub(super) async fn podcast_shows(&self, offset: u32) -> Result<view::Page<view::SavedShow>> {
        let shows = self
            .listening_catalogue()
            .await?
            .shows
            .into_iter()
            .map(|podcast| view::SavedShow {
                show: podcast.show(),
                added_at: None,
            })
            .collect::<Vec<_>>();
        Ok(mapping::page(&shows, offset, PAGE_SIZE))
    }

    pub(super) async fn podcast_show(&self, id: &str) -> Result<view::Show> {
        let podcast = self.podcast(id).await?;
        let episodes = self.podcast_feed(&podcast).await?;
        let mut show = podcast.show();
        show.total_episodes = Some(episodes.len() as u32);
        show.episodes = Some(mapping::page(&episodes, 0, PAGE_SIZE));
        Ok(show)
    }

    async fn podcast(&self, id: &str) -> Result<Podcast> {
        let id = id.strip_prefix("streamarena:").unwrap_or(id);
        self.listening_catalogue()
            .await?
            .shows
            .into_iter()
            .find(|show| show.id == id)
            .ok_or_else(|| failure("This podcast is no longer in the catalogue."))
    }

    pub(super) async fn podcast_episodes(
        &self,
        id: &str,
        offset: u32,
    ) -> Result<view::Page<view::Episode>> {
        let podcast = self.podcast(id).await?;
        Ok(mapping::page(
            &self.podcast_feed(&podcast).await?,
            offset,
            PAGE_SIZE,
        ))
    }

    pub(super) async fn podcast_episode(&self, id: &str) -> Result<view::Episode> {
        let show_id = id
            .strip_prefix("podcast:")
            .and_then(|id| id.split_once(':'))
            .map(|(show, _)| show)
            .ok_or_else(unsupported)?;
        let podcast = self.podcast(show_id).await?;
        self.podcast_feed(&podcast)
            .await?
            .into_iter()
            .find(|episode| episode.id == id)
            .ok_or_else(|| failure("This episode is no longer in the podcast feed."))
    }

    async fn podcast_feed(&self, podcast: &Podcast) -> Result<Vec<view::Episode>> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| failure("Music service stopped"))?;
        let response = self
            .media_client
            .get(format!(
                "{}/api/podcast-feeds/{}",
                self.base,
                segment(&podcast.id)
            ))
            .send()
            .await
            .map_err(|_| failure("Couldn't load podcast episodes. Try again."))?;
        if !response.status().is_success() || response.url().origin() != self.origin.origin() {
            return Err(failure("Couldn't load podcast episodes. Try again."));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| failure("Podcast feed was interrupted"))?
        {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err(failure("Podcast feed is too large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let xml = std::str::from_utf8(&bytes).map_err(|_| failure("Invalid podcast feed"))?;
        let parsed = parse_feed(xml, podcast)?;
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(ApiError::NotSignedIn);
        }
        Ok(parsed
            .into_iter()
            .map(|(song, mut episode)| {
                let song = self.remember(song);
                episode.images = mapping::images(Some(&song.image_url));
                episode
            })
            .collect())
    }

    pub(super) async fn listening_track(&self, id: &str) -> Result<MusicSong> {
        if id.starts_with("radio:") {
            return self
                .radio_collection()
                .await?
                .songs
                .into_iter()
                .find(|song| song.id == id)
                .ok_or_else(|| failure("This radio station is no longer available."));
        }
        self.podcast_episode(id).await?;
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .songs
            .get(&format!("spotify:episode:{id}"))
            .cloned()
            .ok_or_else(unsupported)
    }
}

fn text(node: roxmltree::Node<'_, '_>, name: &str) -> String {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn media_url(value: &str, base: &str) -> Option<String> {
    let url = Url::parse(base).ok()?.join(value.trim()).ok()?;
    (!value.trim().is_empty()
        && matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

fn duration_ms(value: &str) -> u32 {
    let parts = value
        .split(':')
        .map(str::parse::<u32>)
        .collect::<std::result::Result<Vec<_>, _>>();
    match parts {
        Ok(parts) if !parts.is_empty() && parts.len() <= 3 => parts
            .into_iter()
            .fold(0u32, |total, n| total.saturating_mul(60).saturating_add(n))
            .saturating_mul(1000),
        _ => 0,
    }
}

fn episode_id(show: &str, seed: &str) -> String {
    let mut key = String::new();
    for c in seed.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            key.push(c);
        } else if !key.is_empty() && !key.ends_with('-') {
            key.push('-');
        }
    }
    let key = key.trim_end_matches('-');
    format!(
        "podcast:{show}:{}",
        if key.is_empty() {
            "episode"
        } else {
            &key[..key.len().min(96)]
        }
    )
}

fn parse_feed(xml: &str, podcast: &Podcast) -> Result<Vec<(MusicSong, view::Episode)>> {
    let doc =
        roxmltree::Document::parse(xml).map_err(|_| failure("Podcast feed could not be parsed"))?;
    let channel = doc
        .descendants()
        .find(|n| n.has_tag_name("channel"))
        .ok_or_else(|| failure("Podcast feed is missing a channel"))?;
    let show = podcast.show();
    let mut episodes = Vec::new();
    for item in channel
        .children()
        .filter(|n| n.has_tag_name("item"))
        .take(50)
    {
        let Some(audio) = item
            .children()
            .find(|n| n.has_tag_name("enclosure"))
            .and_then(|n| n.attribute("url"))
            .and_then(|u| media_url(u, &podcast.feed_url))
        else {
            continue;
        };
        let title = text(item, "title");
        let guid = text(item, "guid");
        let id = episode_id(&podcast.id, if guid.is_empty() { &audio } else { &guid });
        let art = item
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "image")
            .and_then(|n| n.attribute("href"))
            .and_then(|u| media_url(u, &podcast.feed_url))
            .unwrap_or_else(|| podcast.image_url.clone());
        let mut proxy = Url::parse("https://placeholder.invalid/").expect("static URL");
        proxy.set_path(&format!("/api/podcast-media/{}", podcast.id));
        proxy.query_pairs_mut().append_pair("url", &audio);
        let description = crate::util::strip_html(&text(item, "description"));
        let duration = duration_ms(&text(item, "duration"));
        let date = jiff::fmt::rfc2822::parse(&text(item, "pubDate"))
            .ok()
            .map(|d| d.date().to_string());
        let song = MusicSong {
            id: id.clone(),
            title: if title.is_empty() {
                "Untitled episode".into()
            } else {
                title
            },
            artist: podcast.title.clone(),
            album: Some(podcast.title.clone()),
            image_url: art,
            audio_url: format!("{}?{}", proxy.path(), proxy.query().unwrap_or_default()),
            duration_ms: duration,
            source: Some("podcast".into()),
            description: Some(description.clone()),
            created_at: date.clone(),
            ..Default::default()
        };
        let episode = view::Episode {
            id,
            name: song.title.clone(),
            uri: song.uri(),
            duration_ms: duration,
            description,
            release_date: date,
            show: Some(show.clone()),
            external_urls: view::ExternalUrls {
                spotify: media_url(&text(item, "link"), &podcast.website_url),
            },
            ..Default::default()
        };
        episodes.push((song, episode));
    }
    Ok(episodes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn feed_maps_encoded_media_and_episode_identity() {
        let show = Podcast {
            id: "test".into(),
            title: "Test".into(),
            author: "Author".into(),
            description: String::new(),
            feed_url: "https://feeds.test/feed".into(),
            website_url: "https://show.test/".into(),
            image_url: "https://cdn.test/cover.jpg".into(),
        };
        let xml = r#"<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><item>
            <guid>Episode ABC/123</guid><title>One &amp; two</title><description><![CDATA[<p>Hello world</p>]]></description>
            <enclosure url="https://cdn.test/a.mp3?x=1&amp;y=2"/><itunes:duration>1:02:03</itunes:duration>
            <pubDate>Fri, 02 Oct 2026 12:00:00 +0000</pubDate></item>
            <item><title>Unsafe</title><enclosure url="file:///etc/passwd"/></item></channel></rss>"#;
        let items = parse_feed(xml, &show).unwrap();
        assert_eq!(items.len(), 1);
        let (song, episode) = &items[0];
        assert_eq!(episode.uri, "spotify:episode:podcast:test:episode-abc-123");
        assert_eq!(song.duration_ms, 3_723_000);
        assert_eq!(episode.name, "One & two");
        assert_eq!(episode.release_date.as_deref(), Some("2026-10-02"));
        assert!(song.audio_url.contains("x%3D1%26y%3D2"));
        assert!(parse_feed("<rss/>", &show).is_err());
    }
    #[test]
    fn durations_and_urls_are_bounded() {
        assert_eq!(duration_ms("93"), 93_000);
        assert_eq!(duration_ms("abc"), 0);
        assert_eq!(duration_ms("4294967295:59:59"), u32::MAX);
        assert!(media_url("https://user:pass@example.org/file", "https://example.org").is_none());
    }
}
