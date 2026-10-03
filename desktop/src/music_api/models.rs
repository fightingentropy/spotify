//! Wire types for the music server. Playback metadata stays separate from the
//! Spotify-shaped presentation models so staging never turns into a saved song.
use serde::{Deserialize, Serialize};

fn text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicSong {
    #[serde(default, deserialize_with = "text")]
    pub id: String,
    #[serde(default, deserialize_with = "text")]
    pub title: String,
    #[serde(default, deserialize_with = "text")]
    pub artist: String,
    pub album: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub image_url: String,
    pub network_image_url: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub audio_url: String,
    pub lyrics_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub duration_ms: u32,
    pub duration: Option<f64>,
    pub discover_track_id: Option<String>,
    pub youtube_video_id: Option<String>,
    pub canonical_id: Option<String>,
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub preview: bool,
    pub source: Option<String>,
    pub liked_at: Option<String>,
    pub created_at: Option<String>,
    pub description: Option<String>,
    pub link: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MusicPlaylist {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub image_url: Option<String>,
    #[serde(default)]
    pub cover_image_urls: Vec<String>,
    pub description: Option<String>,
    pub user_id: Option<String>,
    pub owner_name: Option<String>,
    pub songs_count: Option<u32>,
    pub track_count: Option<u32>,
    pub editable: Option<bool>,
    pub deletable: Option<bool>,
    pub provider: Option<String>,
    pub external_url: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MusicAlbum {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub provider: String,
    pub image_url: Option<String>,
    pub release_date: Option<String>,
    pub track_count: Option<u32>,
    pub external_url: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MusicArtist {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub image_url: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    pub followers: Option<u64>,
    pub external_url: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Collection {
    pub kind: Option<String>,
    pub playlist: Option<MusicPlaylist>,
    pub album: Option<MusicAlbum>,
    #[serde(default)]
    pub songs: Vec<MusicSong>,
    pub page: Option<CollectionPage>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CollectionPage {
    pub total_count: u32,
    pub next_offset: Option<u32>,
}
