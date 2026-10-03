use super::models::*;
use crate::api::models::*;

pub(super) fn images(url: Option<&str>) -> Vec<Image> {
    url.filter(|s| !s.is_empty())
        .map(|url| {
            vec![Image {
                url: url.into(),
                ..Default::default()
            }]
        })
        .unwrap_or_default()
}

impl MusicSong {
    pub fn uri(&self) -> String {
        format!("spotify:track:{}", self.id)
    }

    pub fn local_track(&self, uri: &str) -> crate::player::LocalTrack {
        crate::player::LocalTrack {
            uri: uri.into(),
            title: self.title.clone(),
            artists: vec![ArtistRef {
                name: self.artist.clone(),
                ..Default::default()
            }],
            album: self.album.clone().unwrap_or_default(),
            art_url: (!self.image_url.is_empty()).then(|| self.image_url.clone()),
            art_small_url: (!self.image_url.is_empty()).then(|| self.image_url.clone()),
            duration_ms: self.duration_ms,
            is_episode: self.source.as_deref() == Some("podcast"),
        }
    }

    pub(super) fn track(&self) -> Track {
        Track {
            id: Some(self.id.clone()),
            name: self.title.clone(),
            uri: self.uri(),
            duration_ms: self.duration_ms,
            artists: vec![ArtistRef {
                name: self.artist.clone(),
                ..Default::default()
            }],
            album: Some(Album {
                name: self.album.clone().unwrap_or_default(),
                images: images(Some(&self.image_url)),
                ..Default::default()
            }),
            // An unstaged catalog recording is still playable on demand.
            is_playable: Some(!self.audio_url.is_empty() || self.discover_track_id.is_some()),
            ..Default::default()
        }
    }

    pub(super) fn catalog_like_id(&self) -> Option<String> {
        self.discover_track_id
            .as_ref()
            .map(|id| format!("catalog:{id}"))
    }
}

pub(super) fn playlist(
    mut p: MusicPlaylist,
    requested_id: Option<&str>,
    total: Option<u32>,
) -> Playlist {
    let id = requested_id
        .map(str::to_string)
        .unwrap_or_else(|| match p.provider.as_deref() {
            Some("spotify") => format!("catalog:{}", p.id),
            Some("youtube") => format!("yt-mix-{}", p.id),
            _ => p.id.clone(),
        });
    let image = p
        .image_url
        .take()
        .filter(|s| !s.is_empty())
        .or_else(|| p.cover_image_urls.first().cloned());
    // A read-only folder may have userId but must not get edit controls.
    let owner = if p.editable != Some(true) {
        None
    } else {
        p.user_id
    };
    Playlist {
        uri: format!("spotify:playlist:{id}"),
        id,
        name: p.name,
        description: p.description,
        images: images(image.as_deref()),
        owner: Owner {
            id: owner,
            display_name: p.owner_name.or_else(|| Some("Music Library".into())),
            ..Default::default()
        },
        public: Some(false),
        tracks: Some(TrackCount {
            total: total.or(p.songs_count).or(p.track_count).unwrap_or(0),
        }),
        external_urls: ExternalUrls {
            spotify: p.external_url,
        },
        ..Default::default()
    }
}

pub(super) fn album(a: MusicAlbum) -> Album {
    let id = if a.provider == "youtube" {
        format!("youtube:{}", a.id)
    } else {
        a.id
    };
    Album {
        uri: format!("spotify:album:{id}"),
        id,
        name: a.name,
        artists: vec![ArtistRef {
            name: a.artist,
            ..Default::default()
        }],
        images: images(a.image_url.as_deref()),
        release_date: a.release_date,
        total_tracks: a.track_count,
        album_type: Some("album".into()),
        external_urls: ExternalUrls {
            spotify: a.external_url,
        },
        ..Default::default()
    }
}

pub(super) fn artist(a: MusicArtist) -> Artist {
    Artist {
        uri: format!("spotify:artist:{}", a.id),
        id: a.id,
        name: a.name,
        images: images(a.image_url.as_deref()),
        genres: a.genres,
        followers: a.followers.map(|total| Followers { total }),
        external_urls: ExternalUrls {
            spotify: a.external_url,
        },
        ..Default::default()
    }
}

pub(super) fn page<T: Clone>(items: &[T], offset: u32, limit: u32) -> Page<T> {
    let end = (offset as usize)
        .saturating_add(limit as usize)
        .min(items.len());
    Page {
        items: items.get(offset as usize..end).unwrap_or_default().to_vec(),
        total: items.len() as u32,
        limit,
        offset,
        next: (end < items.len()).then(|| format!("music:offset:{end}")),
    }
}

pub(super) fn playlist_items(songs: &[MusicSong]) -> Vec<PlaylistItem> {
    songs
        .iter()
        .map(|s| PlaylistItem {
            item: Some(PlayableItem::Track(s.track())),
            ..Default::default()
        })
        .collect()
}
