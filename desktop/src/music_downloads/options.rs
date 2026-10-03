//! Durable preferences shared by downloads and local audio tools.
use super::{ExportOptions, TrackMetadata};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LyricsTranslationProvider {
    #[default]
    Off,
    Codex,
    Claude,
}
impl LyricsTranslationProvider {
    pub const ALL: [Self; 3] = [Self::Off, Self::Codex, Self::Claude];
    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "Off",
            Self::Codex => "Codex CLI",
            Self::Claude => "Claude CLI",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LyricsOptions {
    pub translation_provider: LyricsTranslationProvider,
    pub language: String,
    pub fallback: bool,
    pub title_fallback: bool,
}
impl Default for LyricsOptions {
    fn default() -> Self {
        Self {
            translation_provider: LyricsTranslationProvider::Off,
            language: "English".into(),
            fallback: true,
            title_fallback: true,
        }
    }
}
impl LyricsOptions {
    pub fn validate(&self) -> Result<(), String> {
        if self.language.trim().is_empty()
            || self.language.len() > 80
            || self.language.chars().any(char::is_control)
        {
            return Err("Enter a target language under 80 characters.".into());
        }
        Ok(())
    }
}

impl TrackMetadata {
    pub fn for_export(&self, options: &ExportOptions) -> Self {
        let mut metadata = self.clone();
        if !self.artists.is_empty() {
            metadata.artist = if options.first_artist_only {
                self.artists[0].clone()
            } else {
                self.artists.join(options.artist_separator.text())
            };
        }
        if options.single_genre {
            metadata.genre = self
                .genre
                .split([';', ','])
                .next()
                .unwrap_or("")
                .trim()
                .into();
        }
        metadata
    }

    pub fn selected_tags(&self, options: &ExportOptions) -> Vec<(String, String)> {
        if !options.embed_tags {
            return Vec::new();
        }
        let s = &options.metadata_tags;
        let date = if options.year_only {
            self.year.chars().take(4).collect()
        } else {
            self.year.clone()
        };
        let mut tags = Vec::new();
        for (enabled, key, value) in [
            (s.title, "title", &self.title),
            (s.artist, "artist", &self.artist),
            (s.album, "album", &self.album),
            (s.album_artist, "album_artist", &self.album_artist),
            (s.date, "date", &date),
            (s.genre, "genre", &self.genre),
            (s.isrc, "ISRC", &self.isrc),
            (s.upc, "UPC", &self.upc),
            (s.composer, "composer", &self.composer),
            (s.copyright, "copyright", &self.copyright),
            (s.label, "publisher", &self.label),
            (s.comment, "comment", &self.source_url),
        ] {
            if enabled && !value.is_empty() {
                tags.push((key.into(), value.clone()));
            }
        }
        for (enabled, key, number, total) in [
            (s.track, "track", self.track_number, self.track_total),
            (s.disc, "disc", self.disc_number, self.disc_total),
        ] {
            if enabled {
                if let Some(number) = number {
                    tags.push((
                        key.into(),
                        total.map_or_else(
                            || number.to_string(),
                            |total| format!("{number}/{total}"),
                        ),
                    ));
                }
            }
        }
        tags
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MetadataTags {
    pub title: bool,
    pub artist: bool,
    pub album: bool,
    pub album_artist: bool,
    pub date: bool,
    pub track: bool,
    pub disc: bool,
    pub genre: bool,
    pub composer: bool,
    pub copyright: bool,
    pub label: bool,
    pub isrc: bool,
    pub upc: bool,
    pub comment: bool,
}
impl Default for MetadataTags {
    fn default() -> Self {
        Self::all(true)
    }
}
impl MetadataTags {
    pub fn all(value: bool) -> Self {
        Self {
            title: value,
            artist: value,
            album: value,
            album_artist: value,
            date: value,
            track: value,
            disc: value,
            genre: value,
            composer: value,
            copyright: value,
            label: value,
            isrc: value,
            upc: value,
            comment: value,
        }
    }
    pub fn fields(&mut self) -> [(&'static str, &mut bool); 14] {
        [
            ("Title", &mut self.title),
            ("Artist", &mut self.artist),
            ("Album", &mut self.album),
            ("Album artist", &mut self.album_artist),
            ("Release date", &mut self.date),
            ("Track number", &mut self.track),
            ("Disc number", &mut self.disc),
            ("Genre", &mut self.genre),
            ("Composer", &mut self.composer),
            ("Copyright", &mut self.copyright),
            ("Label", &mut self.label),
            ("ISRC", &mut self.isrc),
            ("UPC", &mut self.upc),
            ("Spotify URL / comment", &mut self.comment),
        ]
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArtistSeparator {
    #[default]
    Comma,
    Semicolon,
}
impl ArtistSeparator {
    pub fn text(self) -> &'static str {
        match self {
            Self::Comma => ", ",
            Self::Semicolon => "; ",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExistingFileCheck {
    Filename,
    Isrc,
    #[default]
    Hybrid,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReplayGainMode {
    #[default]
    Track,
    Album,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkResolver {
    #[default]
    Auto,
    SongLink,
    Songstats,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderOptions {
    pub resolver: LinkResolver,
    pub resolver_fallback: bool,
    pub provider_fallback: bool,
    pub provider_order: Vec<String>,
    pub custom_tidal_url: String,
    pub custom_qobuz_url: String,
    pub atmos_fallback: bool,
    pub atmos_fallback_quality: String,
}
impl Default for ProviderOptions {
    fn default() -> Self {
        Self {
            resolver: LinkResolver::Auto,
            resolver_fallback: true,
            provider_fallback: true,
            provider_order: vec!["tidal".into(), "qobuz".into(), "amazon".into()],
            custom_tidal_url: String::new(),
            custom_qobuz_url: String::new(),
            atmos_fallback: true,
            atmos_fallback_quality: "max".into(),
        }
    }
}
impl ProviderOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !["cd", "max"].contains(&self.atmos_fallback_quality.as_str()) {
            return Err("Choose CD or maximum quality for the Atmos fallback.".into());
        }
        for value in [&self.custom_tidal_url, &self.custom_qobuz_url] {
            if value.trim().is_empty() {
                continue;
            }
            let url = reqwest::Url::parse(value.trim())
                .map_err(|_| "Enter a valid HTTPS instance URL")?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(
                    "Instance URLs must use HTTPS without credentials, query strings or fragments."
                        .into(),
                );
            }
        }
        let mut seen = std::collections::HashSet::new();
        if self.provider_order.is_empty()
            || self.provider_order.iter().any(|p| {
                !["tidal", "qobuz", "amazon", "deezer", "apple"].contains(&p.as_str())
                    || !seen.insert(p)
            })
        {
            return Err("Choose a unique provider order.".into());
        }
        Ok(())
    }
}
