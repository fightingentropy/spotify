//! Song radio uses musical recommendations, never the original search results.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recommendation {
    id: String,
    title: String,
    artist: String,
    album: Option<String>,
    image_url: Option<String>,
    duration_ms: Option<u32>,
    audio_id: Option<String>,
    audio_url: Option<String>,
}

fn recording_key(song: &MusicSong) -> String {
    let clean = |value: &str| {
        value
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    format!("{}::{}", clean(&song.title), clean(&song.artist))
}

impl MusicApi {
    pub async fn similar_songs(
        &self,
        seed: &str,
        current: &str,
        excluded: &[String],
    ) -> std::result::Result<Vec<String>, String> {
        let original = self.song_metadata(seed).await?;
        if original.artist.is_empty() || original.title.is_empty() {
            return Ok(vec![]);
        }
        let (seeds, excluded_songs) = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let mut seeds = vec![original];
            if current != seed
                && let Some(song) = state.songs.get(current)
            {
                seeds.insert(0, song.clone());
            }
            let excluded_songs: Vec<_> = excluded
                .iter()
                .filter_map(|uri| state.songs.get(uri).cloned())
                .chain(seeds.iter().cloned())
                .collect();
            (seeds, excluded_songs)
        };
        let mut excluded_keys: HashSet<_> = excluded_songs.iter().map(recording_key).collect();
        let mut excluded_ids: HashSet<_> = excluded_songs
            .iter()
            .filter_map(|s| s.discover_track_id.clone())
            .collect();
        let pair = |s: &MusicSong| json!({"title":s.title,"artist":s.artist});
        let value = self
            .request(
                Method::POST,
                "/api/smart-shuffle/recommend",
                Some(json!({
                    "contextKey": format!("song-radio:{seed}"),
                    "seeds": seeds.iter().map(pair).collect::<Vec<_>>(),
                    "exclude": excluded_songs.iter().map(pair).collect::<Vec<_>>(),
                    "excludeIds": excluded_ids.iter().collect::<Vec<_>>(),
                    "limit": 12,
                })),
            )
            .await
            .map_err(|e| e.to_string())?;
        let tracks: Vec<Recommendation> =
            decode(value.get("tracks").cloned().unwrap_or_else(|| json!([])))
                .map_err(|e| e.to_string())?;
        let mut uris = vec![];
        for track in tracks {
            if track.id.len() != 22
                || !track.id.bytes().all(|c| c.is_ascii_alphanumeric())
                || !excluded_ids.insert(track.id.clone())
            {
                continue;
            }
            let song = MusicSong {
                id: track
                    .audio_id
                    .unwrap_or_else(|| format!("discover:{}", track.id)),
                title: track.title,
                artist: track.artist,
                album: track.album,
                image_url: track.image_url.unwrap_or_default(),
                audio_url: track.audio_url.unwrap_or_default(),
                duration_ms: track.duration_ms.unwrap_or_default(),
                discover_track_id: Some(track.id),
                source: Some("server".into()),
                ..Default::default()
            };
            if song.title.is_empty()
                || song.artist.is_empty()
                || !excluded_keys.insert(recording_key(&song))
            {
                continue;
            }
            let song = self.remember(song);
            if !excluded.contains(&song.uri()) {
                uris.push(song.uri());
            }
        }
        Ok(uris)
    }
}
