//! Portable download preferences. Imports accept our backup and SpotiFLAC's
//! flat or sectioned config, without importing credentials or provider sessions.
use super::*;
use serde_json::{Map, Value, json};
use std::io::{Read, Write};

pub fn write_preferences(path: &Path, options: &ExportOptions) -> Result<(), String> {
    validate(options)?;
    let data = serde_json::to_vec_pretty(
        &json!({"app":"Spotify", "version":1, "download_settings":options}),
    )
    .map_err(|e| e.to_string())?;
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut file = open
        .open(path)
        .map_err(|e| format!("Choose a new backup filename: {e}"))?;
    file.write_all(&data)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

pub fn read_preferences(path: &Path) -> Result<ExportOptions, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("The settings file is too large.".into());
    }
    let mut data = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > 1024 * 1024 {
        return Err("The settings file is too large.".into());
    }
    let value: Value =
        serde_json::from_slice(&data).map_err(|_| "This is not a valid settings backup.")?;
    let result = if let Some(options) = value.get("download_settings") {
        if value.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("This backup uses an unsupported version.".into());
        }
        serde_json::from_value(options.clone()).map_err(|_| "The download settings are invalid.")?
    } else {
        import_spotiflac(&value)?
    };
    validate(&result)?;
    Ok(result)
}

fn validate(options: &ExportOptions) -> Result<(), String> {
    options.providers.validate()?;
    options.lyrics.validate()?;
    if options.output_dir.as_os_str().is_empty() {
        return Err("Choose a download folder.".into());
    }
    for value in [
        &options.folder_template,
        &options.filename_template,
        &options.album_filename_template,
    ] {
        if value.len() > 512
            || value.chars().any(char::is_control)
            || value
                .split(['/', '\\'])
                .any(|s| matches!(s.trim(), "." | ".."))
        {
            return Err("Naming templates must be under 512 characters without traversal or control characters.".into());
        }
    }
    if options.filename_template.trim().is_empty()
        || options.album_filename_template.trim().is_empty()
    {
        return Err("Filename templates cannot be empty.".into());
    }
    if options.sample_rate.is_some_and(|rate| {
        ![22_050, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000].contains(&rate)
    }) {
        return Err("Unsupported sample rate in settings.".into());
    }
    if options
        .bit_depth
        .is_some_and(|bits| ![16, 24].contains(&bits))
    {
        return Err("Unsupported bit depth in settings.".into());
    }
    if !(32..=512).contains(&options.bitrate_kbps) {
        return Err("Unsupported bitrate in settings.".into());
    }
    Ok(())
}

fn import_spotiflac(value: &Value) -> Result<ExportOptions, String> {
    fn visit(value: &Value, output: &mut Map<String, Value>) {
        if let Some(object) = value.as_object() {
            for (key, value) in object {
                if value.is_object() && key != "metadataTags" {
                    visit(value, output);
                } else {
                    output.insert(key.clone(), value.clone());
                }
            }
        }
    }
    let mut flat = Map::new();
    visit(value, &mut flat);
    if ![
        "downloadPath",
        "downloader",
        "folderPreset",
        "filenameTemplate",
        "metadataTags",
    ]
    .iter()
    .any(|k| flat.contains_key(*k))
    {
        return Err("Choose a Spotify download-settings backup or SpotiFLAC config.json.".into());
    }
    let text = |key: &str| flat.get(key).and_then(Value::as_str);
    let boolean =
        |key: &str, fallback: bool| flat.get(key).and_then(Value::as_bool).unwrap_or(fallback);
    let mut options = ExportOptions::default();
    if let Some(path) = text("downloadPath").filter(|p| !p.is_empty()) {
        options.output_dir = PathBuf::from(path);
    }
    options.source = match text("downloader") {
        Some("tidal") => DownloadSource::Tidal,
        Some("qobuz") => DownloadSource::Qobuz,
        Some("amazon") => DownloadSource::Amazon,
        _ => DownloadSource::Auto,
    };
    let quality = match options.source {
        DownloadSource::Tidal => text("tidalQuality"),
        DownloadSource::Qobuz => text("qobuzQuality"),
        DownloadSource::Amazon => text("amazonQuality"),
        _ => text("autoQuality"),
    };
    options.quality = match quality {
        Some("16" | "6" | "LOSSLESS") => DownloadQuality::Cd,
        Some("7") => DownloadQuality::HiRes48,
        Some("atmos" | "ATMOS") => DownloadQuality::Atmos,
        _ => DownloadQuality::Max,
    };
    options.providers.resolver = if text("linkResolver") == Some("songstats") {
        LinkResolver::Songstats
    } else {
        LinkResolver::SongLink
    };
    options.providers.resolver_fallback = boolean("allowResolverFallback", true);
    options.providers.provider_fallback = boolean("allowFallback", true);
    options.providers.atmos_fallback = boolean("allowAtmosFallback", true);
    options.providers.atmos_fallback_quality = if text("atmosFallbackQuality") == Some("16") {
        "cd"
    } else {
        "max"
    }
    .into();
    if let Some(order) = text("autoOrder") {
        options.providers.provider_order = order.split('-').map(str::to_owned).collect();
    }
    options.providers.custom_tidal_url = text("customTidalApi").unwrap_or_default().into();
    options.providers.custom_qobuz_url = text("customQobuzApi").unwrap_or_default().into();
    options.folder_template = match text("folderPreset").unwrap_or("custom") {
        "none" => "",
        "artist" => "{artist}",
        "album" => "{album}",
        "year-album" => "[{year}] {album}",
        "year-artist-album" => "[{year}] {artist} - {album}",
        "artist-album" => "{artist}/{album}",
        "artist-year-album" => "{artist}/[{year}] {album}",
        "artist-year-nested-album" => "{artist}/{year}/{album}",
        "album-artist" => "{album_artist}",
        "album-artist-album" => "{album_artist}/{album}",
        "album-artist-year-album" => "{album_artist}/[{year}] {album}",
        "album-artist-year-nested-album" => "{album_artist}/{year}/{album}",
        "year" => "{year}",
        "year-artist" => "{year}/{artist}",
        _ => text("folderTemplate").unwrap_or("{artist}/{album}"),
    }
    .into();
    options.filename_template = match text("filenamePreset").unwrap_or("custom") {
        "title" => "{title}",
        "title-artist" => "{title} - {artist}",
        "artist-title" => "{artist} - {title}",
        "track-title" => "{track}. {title}",
        "track-title-artist" => "{track}. {title} - {artist}",
        "track-artist-title" => "{track}. {artist} - {title}",
        "title-album-artist" => "{title} - {album_artist}",
        "track-title-album-artist" => "{track}. {title} - {album_artist}",
        "artist-album-title" => "{artist} - {album} - {title}",
        "track-dash-title" => "{track} - {title}",
        "disc-track-title" => "{disc}-{track}. {title}",
        "disc-track-title-artist" => "{disc}-{track}. {title} - {artist}",
        _ => text("filenameTemplate").unwrap_or("{artist} - {title}"),
    }
    .into();
    if let Some(template) = text("albumFilenameTemplate") {
        options.album_filename_template = template.into();
    }
    options.separate_album_filename = boolean("useSeparateAlbumFilename", false);
    options.apply_folder_to_single_track = boolean("applyFolderToSingleTrack", false);
    options.create_playlist_folder = boolean("createPlaylistFolder", true);
    options.playlist_owner_folder = boolean("playlistOwnerFolderName", false);
    options.create_playlist = boolean("createM3u8File", false);
    options.cover_sidecar = boolean("saveCover", false);
    options.export_log = boolean("exportLogsFile", true);
    options.log_failures_only = boolean("exportLogsOnlyFailed", false);
    options.embed_lyrics = boolean("embedLyrics", false);
    options.max_artwork = boolean("embedMaxQualityCover", boolean("maxQualityCover", true));
    options.lyrics.title_fallback =
        boolean("lrclibTitleFallback", boolean("lyricsTitleFallback", true));
    if let Some(language) = text("lyricsTranslationLang").filter(|value| !value.trim().is_empty()) {
        options.lyrics.language = language.into();
    }
    options.lyrics.fallback = boolean("lyricsTranslationAutoFallback", true);
    // Preserve an enabled translation preference using the user's chosen local
    // CLI replacement, without importing the old guest-provider implementation.
    options.lyrics.translation_provider = match text("lyricsTranslationMode") {
        Some("chatgpt" | "gemini" | "codex") => LyricsTranslationProvider::Codex,
        Some("claude") => LyricsTranslationProvider::Claude,
        _ => LyricsTranslationProvider::Off,
    };
    options.first_artist_only = boolean("useFirstArtistOnly", false);
    options.single_genre = boolean("useSingleGenre", false);
    options.artist_separator = if text("separator") == Some("semicolon") {
        ArtistSeparator::Semicolon
    } else {
        ArtistSeparator::Comma
    };
    options.year_only = text("metadataDateFormat") == Some("year");
    options.duplicates = if boolean("redownloadWithSuffix", false) {
        DuplicatePolicy::Rename
    } else {
        DuplicatePolicy::Skip
    };
    options.existing_file_check = match text("existingFileCheckMode") {
        Some("isrc") => ExistingFileCheck::Isrc,
        Some("filename") => ExistingFileCheck::Filename,
        _ => ExistingFileCheck::Hybrid,
    };
    if boolean("autoConvertAudio", false) {
        options.format = match text("autoConvertFormat") {
            Some("mp3") => OutputFormat::Mp3,
            Some("m4a-aac") => OutputFormat::Aac,
            Some("m4a-alac") => OutputFormat::Alac,
            Some("wav") => OutputFormat::Wav,
            Some("aiff") => OutputFormat::Aiff,
            Some("opus") => OutputFormat::Opus,
            _ => OutputFormat::Original,
        };
        options.bitrate_kbps = text("autoConvertBitrate")
            .and_then(|s| s.trim_end_matches('k').parse().ok())
            .unwrap_or(320);
        options.keep_original = !boolean("autoConvertDeleteOriginal", true);
    }
    if boolean("autoResampleAudio", false) {
        options.sample_rate = text("autoResampleSampleRate").and_then(|s| s.parse().ok());
        options.bit_depth = text("autoResampleBitDepth").and_then(|s| s.parse().ok());
        options.keep_original |= !boolean("autoResampleDeleteOriginal", true);
    }
    options.replay_gain = boolean("autoReplayGainTags", false);
    options.replay_gain_mode = if text("autoReplayGainMode") == Some("album") {
        ReplayGainMode::Album
    } else {
        ReplayGainMode::Track
    };
    if let Some(tags) = flat.get("metadataTags") {
        let s = &mut options.metadata_tags;
        for (key, target) in [
            ("title", &mut s.title),
            ("artist", &mut s.artist),
            ("album", &mut s.album),
            ("albumArtist", &mut s.album_artist),
            ("date", &mut s.date),
            ("trackNumber", &mut s.track),
            ("discNumber", &mut s.disc),
            ("genre", &mut s.genre),
            ("composer", &mut s.composer),
            ("copyright", &mut s.copyright),
            ("label", &mut s.label),
            ("isrc", &mut s.isrc),
            ("upc", &mut s.upc),
            ("comment", &mut s.comment),
        ] {
            if let Some(value) = tags.get(key).and_then(Value::as_bool) {
                *target = value;
            }
        }
    }
    options.metadata_tags.genre &= boolean("embedGenre", true);
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_nested_legacy_settings_without_importing_credentials() {
        let value = json!({"settingsPage":{"general":{"downloadPath":"/tmp/Music"},"naming":{"folderPreset":"none","filenamePreset":"track-title"},"fileManagement":{"metadataTags":{"artist":false,"albumArtist":true},"existingFileCheckMode":"isrc","autoConvertAudio":true,"autoConvertFormat":"m4a-aac","autoConvertDeleteOriginal":false}},"workflowPage":{"linkResolvers":{"linkResolver":"songstats","allowResolverFallback":false}},"session_token":"ignored"});
        let options = import_spotiflac(&value).unwrap();
        assert_eq!(options.folder_template, "");
        assert_eq!(options.filename_template, "{track}. {title}");
        assert!(!options.metadata_tags.artist);
        assert!(options.metadata_tags.album_artist);
        assert_eq!(options.providers.resolver, LinkResolver::Songstats);
        assert!(!options.providers.resolver_fallback);
        assert_eq!(options.format, OutputFormat::Aac);
        assert!(options.keep_original);
        assert_eq!(options.existing_file_check, ExistingFileCheck::Isrc);
        assert!(
            !serde_json::to_string(&options)
                .unwrap()
                .contains("session_token")
        );
    }
    #[test]
    fn rejects_traversal_and_unknown_backups() {
        assert!(import_spotiflac(&json!({"password":"not settings"})).is_err());
        let mut options = ExportOptions::default();
        options.folder_template = "../escape".into();
        assert!(validate(&options).is_err());
    }
    #[test]
    fn imports_actual_legacy_artwork_and_lyrics_keys() {
        let options = import_spotiflac(&json!({"downloadPath":"/tmp/Music","embedMaxQualityCover":false,"lrclibTitleFallback":false,"lyricsTranslationMode":"gemini","lyricsTranslationLang":"el","lyricsTranslationAutoFallback":false})).unwrap();
        assert!(!options.max_artwork);
        assert!(!options.lyrics.title_fallback);
        assert!(!options.lyrics.fallback);
        assert_eq!(options.lyrics.language, "el");
        assert_eq!(
            options.lyrics.translation_provider,
            LyricsTranslationProvider::Codex
        );
    }
    #[test]
    fn round_trip_preserves_every_preference_and_never_overwrites_backup() {
        let path =
            std::env::temp_dir().join(format!("spotify-settings-{}.json", rand::random::<u64>()));
        let mut options = ExportOptions::default();
        options.max_artwork = false;
        options.lyrics = LyricsOptions {
            translation_provider: LyricsTranslationProvider::Claude,
            language: "Italian".into(),
            fallback: false,
            title_fallback: false,
        };
        write_preferences(&path, &options).unwrap();
        assert_eq!(read_preferences(&path).unwrap(), options);
        assert!(write_preferences(&path, &options).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
