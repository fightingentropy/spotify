use super::*;
use crate::music_api::downloads::{DownloadCollection, DownloadTrack};
use crate::music_downloads::{ExportOptions, TrackMetadata};
use lofty::{
    config::{ParseOptions, WriteOptions},
    file::{AudioFile, FileType, TaggedFile, TaggedFileExt},
    picture::{Picture, PictureType},
    probe::Probe,
    tag::{ItemKey, Tag, TagType},
};

fn read(path: &Path, artwork: bool) -> Result<TaggedFile, String> {
    Probe::open(path)
        .map_err(|error| format!("Could not open audio tags: {error}"))?
        .options(
            ParseOptions::new()
                .read_properties(false)
                .read_cover_art(artwork),
        )
        .guess_file_type()
        .map_err(|error| error.to_string())?
        .read()
        .map_err(|error| format!("This file's tags could not be read: {error}"))
}
fn primary_type(file: &TaggedFile) -> TagType {
    match file.file_type() {
        FileType::Wav | FileType::Aiff => TagType::Id3v2,
        _ => file.primary_tag_type(),
    }
}
fn key(name: &str, kind: TagType) -> Option<ItemKey> {
    Some(match name.to_ascii_lowercase().as_str() {
        "title" => ItemKey::TrackTitle,
        "artist" => ItemKey::TrackArtist,
        "album" => ItemKey::AlbumTitle,
        "album_artist" | "albumartist" | "album artist" => ItemKey::AlbumArtist,
        "date" | "year" => ItemKey::RecordingDate,
        "genre" => ItemKey::Genre,
        "track" | "tracknumber" => ItemKey::TrackNumber,
        "tracktotal" | "totaltracks" => ItemKey::TrackTotal,
        "disc" | "discnumber" => ItemKey::DiscNumber,
        "disctotal" | "totaldiscs" => ItemKey::DiscTotal,
        "composer" => ItemKey::Composer,
        "copyright" => ItemKey::CopyrightMessage,
        "publisher" | "label" | "organization" => {
            if ItemKey::Publisher.map_key(kind).is_some() {
                ItemKey::Publisher
            } else {
                ItemKey::Label
            }
        }
        "isrc" => ItemKey::Isrc,
        "upc" | "barcode" => ItemKey::Barcode,
        "comment" | "description" => ItemKey::Comment,
        "lyrics" | "unsyncedlyrics" | "unsynced lyrics" => {
            if kind == TagType::Id3v2 {
                ItemKey::UnsyncLyrics
            } else {
                ItemKey::Lyrics
            }
        }
        "replaygain_track_gain" => ItemKey::ReplayGainTrackGain,
        "replaygain_track_peak" => ItemKey::ReplayGainTrackPeak,
        "replaygain_album_gain" => ItemKey::ReplayGainAlbumGain,
        "replaygain_album_peak" => ItemKey::ReplayGainAlbumPeak,
        other => {
            return ItemKey::from_key(kind, other)
                .or_else(|| ItemKey::from_key(kind, &other.to_ascii_uppercase()));
        }
    })
}
fn name(key: ItemKey, kind: TagType) -> Option<String> {
    Some(
        match key {
            ItemKey::TrackTitle => "title",
            ItemKey::TrackArtist => "artist",
            ItemKey::AlbumTitle => "album",
            ItemKey::AlbumArtist => "album_artist",
            ItemKey::RecordingDate | ItemKey::Year => "date",
            ItemKey::Genre => "genre",
            ItemKey::TrackNumber => "track",
            ItemKey::TrackTotal => "tracktotal",
            ItemKey::DiscNumber => "disc",
            ItemKey::DiscTotal => "disctotal",
            ItemKey::Composer => "composer",
            ItemKey::CopyrightMessage => "copyright",
            ItemKey::Publisher | ItemKey::Label => "publisher",
            ItemKey::Isrc => "isrc",
            ItemKey::Barcode => "upc",
            ItemKey::Comment => "comment",
            ItemKey::Lyrics | ItemKey::UnsyncLyrics => "lyrics",
            ItemKey::ReplayGainTrackGain => "replaygain_track_gain",
            ItemKey::ReplayGainTrackPeak => "replaygain_track_peak",
            ItemKey::ReplayGainAlbumGain => "replaygain_album_gain",
            ItemKey::ReplayGainAlbumPeak => "replaygain_album_peak",
            _ => return key.map_key(kind).map(|key| key.to_ascii_lowercase()),
        }
        .into(),
    )
}

pub(super) fn read_tags(path: &Path) -> Result<(BTreeMap<String, String>, bool), String> {
    let file = read(path, true)?;
    let mut result = BTreeMap::new();
    let mut artwork = false;
    for tag in file.tags() {
        artwork |= !tag.pictures().is_empty();
        for item in tag.items() {
            if let (Some(name), Some(value)) = (
                name(item.key(), tag.tag_type()),
                item.value().text().or_else(|| item.value().locator()),
            ) {
                result.insert(name, value.to_owned());
            }
        }
    }
    Ok((result, artwork))
}
pub(super) fn read_isrc(path: &Path) -> Result<Option<String>, String> {
    let file = read(path, false)?;
    Ok(file
        .tags()
        .iter()
        .find_map(|tag| tag.get_string(ItemKey::Isrc))
        .map(str::to_owned)
        .filter(|isrc| !isrc.trim().is_empty()))
}

/// The caller must pass its own temporary or newly-created output file. The
/// public Tools editor calls this only after copying the selected original.
fn update(
    path: &Path,
    values: &BTreeMap<String, String>,
    lyrics: Option<&str>,
    cover: Option<&[u8]>,
    clear_art: bool,
    cancel: &Cancellation,
) -> Result<(), String> {
    cancel.check()?;
    let mut file = read(path, true)?;
    let kind = primary_type(&file);
    if file.tag(kind).is_none() {
        file.insert_tag(Tag::new(kind));
    }
    // Remove edited fields from secondary tags as well, otherwise old ID3v1 or
    // RIFF values can reappear when a player chooses a different tag family.
    let tag_types: Vec<_> = file.tags().iter().map(Tag::tag_type).collect();
    for tag_type in tag_types {
        if let Some(tag) = file.tag_mut(tag_type) {
            for field in values.keys() {
                if let Some(key) = key(field, tag_type) {
                    tag.remove_key(key);
                    if key == ItemKey::RecordingDate {
                        tag.remove_key(ItemKey::Year);
                    }
                    if key == ItemKey::TrackNumber {
                        tag.remove_key(ItemKey::TrackTotal);
                    }
                    if key == ItemKey::DiscNumber {
                        tag.remove_key(ItemKey::DiscTotal);
                    }
                    if matches!(key, ItemKey::Publisher | ItemKey::Label) {
                        tag.remove_key(ItemKey::Label);
                        tag.remove_key(ItemKey::Publisher);
                    }
                }
            }
            if lyrics.is_some() {
                tag.remove_key(ItemKey::Lyrics);
                tag.remove_key(ItemKey::UnsyncLyrics);
            }
            if clear_art || cover.is_some() {
                while !tag.pictures().is_empty() {
                    tag.remove_picture(0);
                }
            }
        }
    }
    let tag = file.tag_mut(kind).expect("primary tag was inserted");
    for (field, value) in values {
        if value.len() > 512 * 1024 {
            return Err(format!("The {field} field exceeds the 512 KB tag limit."));
        }
        let Some(key) = key(field, kind) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let (value, total) = if matches!(key, ItemKey::TrackNumber | ItemKey::DiscNumber) {
            let (number, total) = value
                .split_once('/')
                .map_or((value.as_str(), None), |(number, total)| {
                    (number, Some(total))
                });
            (number, total)
        } else {
            (value.as_str(), None)
        };
        if !tag.insert_text(key, value.to_owned()) {
            return Err(format!(
                "This audio container cannot store the {field} tag."
            ));
        }
        if let Some(total) = total {
            tag.insert_text(
                if key == ItemKey::TrackNumber {
                    ItemKey::TrackTotal
                } else {
                    ItemKey::DiscTotal
                },
                total.to_owned(),
            );
        }
    }
    if let Some(lyrics) = lyrics {
        if !lyrics.is_empty() {
            if lyrics.len() > 512 * 1024 {
                return Err("Lyrics exceed the 512 KB tag limit.".into());
            }
            tag.insert_text(
                if kind == TagType::Id3v2 {
                    ItemKey::UnsyncLyrics
                } else {
                    ItemKey::Lyrics
                },
                lyrics.into(),
            );
        }
    }
    if let Some(cover) = cover {
        let mut picture = Picture::from_reader(&mut std::io::Cursor::new(cover))
            .map_err(|error| format!("Cover artwork could not be read: {error}"))?;
        picture.set_pic_type(PictureType::CoverFront);
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(picture);
    }
    cancel.check()?;
    file.save_to_path(path, WriteOptions::default())
        .map_err(|error| format!("Audio tags could not be saved: {error}"))?;
    cancel.check()
}

pub(super) fn write_metadata(
    path: &Path,
    metadata: &TrackMetadata,
    options: &ExportOptions,
    lyrics: Option<&str>,
    cover: Option<&[u8]>,
    cancel: &Cancellation,
) -> Result<(), String> {
    let metadata = metadata.for_export(options);
    let mut values: BTreeMap<String, String> = [
        "title",
        "artist",
        "album",
        "album_artist",
        "date",
        "track",
        "disc",
        "genre",
        "composer",
        "copyright",
        "publisher",
        "isrc",
        "upc",
        "comment",
    ]
    .into_iter()
    .map(|key| (key.into(), String::new()))
    .collect();
    for (key, value) in metadata.selected_tags(options) {
        values.insert(key.to_ascii_lowercase(), value);
    }
    update(
        path,
        &values,
        if options.embed_lyrics {
            lyrics
        } else {
            Some("")
        },
        if options.embed_artwork { cover } else { None },
        !options.embed_artwork,
        cancel,
    )
}
pub(super) fn write_gain(
    path: &Path,
    report: &ReplayGainReport,
    cancel: &Cancellation,
) -> Result<(), String> {
    let mut values = BTreeMap::from([
        (
            "replaygain_track_gain".into(),
            format!("{:+.2} dB", report.track_gain_db),
        ),
        (
            "replaygain_track_peak".into(),
            format!("{:.8}", report.track_peak),
        ),
    ]);
    if let Some(value) = report.album_gain_db {
        values.insert("replaygain_album_gain".into(), format!("{value:+.2} dB"));
    }
    if let Some(value) = report.album_peak {
        values.insert("replaygain_album_peak".into(), format!("{value:.8}"));
    }
    update(path, &values, None, None, false, cancel)
}

pub(super) fn edited_copy(
    document: &AudioDocument,
    directory: &Path,
    values: &BTreeMap<String, String>,
    lyrics: Option<&str>,
    suffix: &str,
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    edited_copy_with_cover(document, directory, values, lyrics, None, suffix, cancel)
}

pub(super) fn edited_copy_with_cover(
    document: &AudioDocument,
    directory: &Path,
    values: &BTreeMap<String, String>,
    lyrics: Option<&str>,
    cover: Option<&[u8]>,
    suffix: &str,
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut temporary = super::super::export::TemporaryFiles(Vec::new());
    let extension = document
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("audio");
    let copy = temporary.add(directory, extension);
    processing::copy_cancelled(&document.path, &copy, cancel)?;
    update(&copy, values, lyrics, cover, false, cancel)?;
    let name = format!(
        "{} - {}.{}",
        super::super::safe_component(
            &document
                .path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
        ),
        suffix,
        extension
    );
    super::super::export::publish(
        &copy,
        &directory.join(name),
        super::super::DuplicatePolicy::Rename,
    )
    .map(|(path, _)| path)
}

pub(super) async fn enrich(
    paths: Vec<PathBuf>,
    output_dir: PathBuf,
    source: Option<String>,
    overwrite: bool,
    lyrics_options: crate::music_downloads::LyricsOptions,
    api: Option<MusicApi>,
    cancel: Cancellation,
    progress: ToolsProgressCallback,
) -> ToolsResult {
    let Some(api) = api else {
        return failed_result(
            PathBuf::new(),
            "Sign in to match metadata from the music catalog.".into(),
        );
    };
    let scan_cancel = cancel.clone();
    let paths = match tokio::task::spawn_blocking(move || expand_paths(&paths, &scan_cancel)).await
    {
        Ok(Ok(paths)) => paths,
        Ok(Err(error)) => return failed_result(PathBuf::new(), error),
        Err(_) => return failed_result(PathBuf::new(), "File scan stopped unexpectedly.".into()),
    };
    let mut result = ToolsResult::default();
    let explicit = if let Some(source) = source.as_deref().filter(|value| !value.trim().is_empty())
    {
        match crate::music_downloads::cancellable(&cancel, api.resolve_download_input(source)).await
        {
            Ok(collection) => Some(collection),
            Err(error) => return failed_result(PathBuf::new(), error),
        }
    } else {
        None
    };
    for (index, path) in paths.iter().enumerate() {
        if cancel.is_cancelled() {
            result.cancelled = true;
            break;
        }
        progress(ToolsProgress {
            completed: index,
            total: paths.len(),
            path: Some(path.clone()),
            stage: "Matching catalog metadata".into(),
        });
        let operation = async {
            let file=path.clone(); let signal=cancel.clone();
            let document=tokio::task::spawn_blocking(move||inspect(&file,&signal)).await.map_err(|_|"Inspection stopped unexpectedly.")??;
            let mut warnings=Vec::new();
            let matched=match_catalog(&api,&document,explicit.as_ref(),paths.len()==1,&cancel,&mut warnings).await?;
            let matched=match crate::music_downloads::cancellable(&cancel,api.enrich_download_track(&matched)).await {
                Ok(track)=>track,
                Err(error) if error==CANCELLED=>return Err(error),
                Err(error)=>{warnings.push(format!("Additional catalog metadata could not be fetched: {error}"));matched}
            };
            reject_conflicting_isrc(&document,&matched)?;
            let options=ExportOptions::default(); let incoming=TrackMetadata::from(&matched).selected_tags(&options);
            let values: BTreeMap<_,_>=incoming.into_iter().map(|(key,value)|(key.to_ascii_lowercase(),value)).filter(|(key,_)|overwrite||document.tags.get(key).is_none_or(|value|value.trim().is_empty())).collect();
            let mut lyrics=if overwrite||document.lyrics.is_none() {
                match crate::music_downloads::cancellable(&cancel,api.download_lyrics_with_options(&matched,&lyrics_options)).await {
                    Ok(Some(lyrics)) if !lyrics.trim().is_empty()=>Some(lyrics),
                    Ok(_)=>{warnings.push("No catalog lyrics were available; any existing lyrics were kept.".into());None},
                    Err(error) if error==CANCELLED=>return Err(error),
                    Err(error)=>{warnings.push(format!("Lyrics could not be fetched; existing lyrics were kept: {error}"));None}
                }
            } else { None };
            if lyrics_options.translation_provider != crate::music_downloads::LyricsTranslationProvider::Off {
                if let Some(original)=lyrics.as_deref() {
                    match crate::music_downloads::lyrics::translate_lyrics(original,&lyrics_options,&cancel).await {
                        Ok(translated)=>lyrics=Some(translated),
                        Err(error) if error==CANCELLED=>return Err(error),
                        Err(error)=>{warnings.push(format!("Translation failed; original lyrics were kept: {error}"));if document.lyrics.is_some(){lyrics=None;}}
                    }
                }
            }
            let cover=if overwrite||!document.has_artwork {
                if matched.cover_url.trim().is_empty(){
                    warnings.push("No catalog cover was available; any existing artwork was kept.".into());None
                } else {
                    match crate::music_downloads::cancellable(&cancel,api.download_cover(&matched.cover_url)).await {
                        Ok(bytes)=>match Picture::from_reader(&mut std::io::Cursor::new(&bytes)) {
                            Ok(_)=>Some(bytes),
                            Err(error)=>{warnings.push(format!("The catalog cover could not be decoded; existing artwork was kept: {error}"));None}
                        },
                        Err(error) if error==CANCELLED=>return Err(error),
                        Err(error)=>{warnings.push(format!("Cover artwork could not be fetched; existing artwork was kept: {error}"));None}
                    }
                }
            } else { None };
            cancel.check()?;
            let directory=output_dir.clone(); let signal=cancel.clone();
            let output=tokio::task::spawn_blocking(move||edited_copy_with_cover(&document,&directory,&values,lyrics.as_deref(),cover.as_deref(),"enriched",&signal)).await.map_err(|_|"Metadata update stopped unexpectedly.")??;
            let inspect_path=output.clone(); let signal=cancel.clone();
            let document=tokio::task::spawn_blocking(move||inspect(&inspect_path,&signal)).await.map_err(|_|"Inspection stopped unexpectedly.")??;
            Ok::<_,String>(ToolsFileResult{input:path.clone(),output:Some(output),document:Some(document),warnings,..Default::default()})
        }.await;
        match operation {
            Ok(file) => result.files.push(file),
            Err(error) => {
                let stopped = error == CANCELLED;
                result.files.push(ToolsFileResult {
                    input: path.clone(),
                    error: Some(error),
                    ..Default::default()
                });
                if stopped {
                    result.cancelled = true;
                    break;
                }
            }
        }
        progress(ToolsProgress {
            completed: index + 1,
            total: paths.len(),
            path: Some(path.clone()),
            stage: "Finished".into(),
        });
    }
    result
}
fn normalized(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}
fn match_recording(
    document: &AudioDocument,
    candidates: &[DownloadTrack],
    explicit_single: bool,
) -> Result<DownloadTrack, String> {
    if explicit_single && candidates.len() == 1 {
        reject_conflicting_isrc(document, &candidates[0])?;
        return Ok(candidates[0].clone());
    }
    let isrc = document.tags.get("isrc").filter(|value| !value.is_empty());
    let matches: Vec<_> = candidates
        .iter()
        .filter(|track| {
            if reject_conflicting_isrc(document, track).is_err() {
                return false;
            }
            if isrc.is_some_and(|isrc| {
                !track.isrc.is_empty() && normalized(isrc) == normalized(&track.isrc)
            }) {
                return true;
            }
            document
                .tags
                .get("title")
                .is_some_and(|title| normalized(title) == normalized(&track.title))
                && document.tags.get("artist").is_some_and(|artist| {
                    track
                        .artists
                        .iter()
                        .any(|candidate| normalized(candidate) == normalized(artist))
                })
                && (document.duration_ms == 0
                    || track.duration_ms == 0
                    || document.duration_ms.abs_diff(track.duration_ms) <= 3000)
        })
        .collect();
    match matches.as_slice() {
        [track] => Ok((*track).clone()),
        [] => Err(
            "No unambiguous matching recording was found. Supply an exact Spotify track link."
                .into(),
        ),
        _ => Err(
            "Several recordings match this file. Supply an exact Spotify track link to choose one."
                .into(),
        ),
    }
}

pub(super) fn canonical_name(name: &str) -> &str {
    match name {
        "tracknumber" => "track",
        "discnumber" => "disc",
        "year" => "date",
        "albumartist" | "album artist" => "album_artist",
        "barcode" => "upc",
        "label" | "organization" => "publisher",
        "unsyncedlyrics" | "unsynced lyrics" => "lyrics",
        other => other,
    }
}
pub(super) fn copy_tags(source: &Path, target: &Path, cancel: &Cancellation) -> Result<(), String> {
    cancel.check()?;
    let source = read(source, true)?;
    let mut target_file = read(target, true)?;
    let kind = primary_type(&target_file);
    let mut merged = Tag::new(kind);
    for source_tag in source.tags() {
        let mut tag = source_tag.clone();
        tag.re_map(kind);
        for item in tag.items() {
            merged.insert(item.clone());
        }
        for picture in tag.pictures() {
            merged.push_picture(picture.clone());
        }
    }
    target_file.insert_tag(merged);
    cancel.check()?;
    target_file
        .save_to_path(target, WriteOptions::default())
        .map_err(|error| format!("Converted audio tags could not be preserved: {error}"))?;
    cancel.check()
}

fn reject_conflicting_isrc(document: &AudioDocument, track: &DownloadTrack) -> Result<(), String> {
    if let Some(isrc) = document
        .tags
        .get("isrc")
        .filter(|isrc| !isrc.trim().is_empty())
    {
        if !track.isrc.trim().is_empty() && normalized(isrc) != normalized(&track.isrc) {
            return Err("The catalog recording has a different ISRC from this file. Its metadata was not applied.".into());
        }
    }
    Ok(())
}
fn embedded_spotify_url(document: &AudioDocument) -> Option<String> {
    for text in document
        .tags
        .iter()
        .filter(|(key, _)| {
            key.starts_with("comment") || matches!(key.as_str(), "description" | "url")
        })
        .map(|(_, value)| value)
    {
        for token in text.split_whitespace() {
            let token = token.trim_matches(|character: char| {
                matches!(
                    character,
                    '"' | '\'' | '(' | ')' | '[' | ']' | '<' | '>' | ',' | ';' | '.'
                )
            });
            if let Some(id) = token.strip_prefix("spotify:track:") {
                if id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                    return Some(format!("https://open.spotify.com/track/{id}"));
                }
            }
            let Ok(url) = reqwest::Url::parse(token) else {
                continue;
            };
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str() != Some("open.spotify.com")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                continue;
            }
            let segments: Vec<_> = url.path_segments().into_iter().flatten().collect();
            for pair in segments.windows(2) {
                if pair[0] == "track"
                    && pair[1].len() == 22
                    && pair[1].bytes().all(|byte| byte.is_ascii_alphanumeric())
                {
                    return Some(format!("https://open.spotify.com/track/{}", pair[1]));
                }
            }
        }
    }
    None
}
async fn match_catalog(
    api: &MusicApi,
    document: &AudioDocument,
    explicit: Option<&DownloadCollection>,
    single: bool,
    cancel: &Cancellation,
    warnings: &mut Vec<String>,
) -> Result<DownloadTrack, String> {
    if let Some(collection) = explicit {
        return match_recording(document, &collection.tracks, single);
    }
    let mut attempts = Vec::new();
    if let Some(url) = embedded_spotify_url(document) {
        attempts.push((url, true, "Embedded Spotify link"));
    }
    if let Some(isrc) = document
        .tags
        .get("isrc")
        .filter(|isrc| !isrc.trim().is_empty())
    {
        attempts.push((format!("isrc:{}", isrc.trim()), false, "ISRC lookup"));
    }
    let title = document
        .tags
        .get("title")
        .map(String::as_str)
        .unwrap_or_default();
    let artist = document
        .tags
        .get("artist")
        .map(String::as_str)
        .unwrap_or_default();
    if !title.trim().is_empty() && !artist.trim().is_empty() {
        attempts.push((format!("{artist} {title}"), false, "Artist/title lookup"));
    }
    if attempts.is_empty() {
        return Err("This file needs a Spotify link in COMMENT, an ISRC, title/artist, or explicit catalog link before it can be matched.".into());
    }
    let mut last_error = String::new();
    for (query, direct, label) in attempts {
        match crate::music_downloads::cancellable(cancel, api.resolve_download_input(&query)).await
        {
            Ok(collection) => match match_recording(document, &collection.tracks, direct) {
                Ok(track) => return Ok(track),
                Err(error) => {
                    warnings.push(format!("{label} did not identify this recording; trying the next available method: {error}"));
                    last_error = error;
                }
            },
            Err(error) if error == CANCELLED => return Err(error),
            Err(error) => {
                warnings.push(format!(
                    "{label} failed; trying the next available method: {error}"
                ));
                last_error = error;
            }
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod matching_tests {
    use super::*;
    fn document() -> AudioDocument {
        AudioDocument {
            path: PathBuf::new(),
            bytes: 0,
            duration_ms: 180_000,
            quality: Default::default(),
            tags: BTreeMap::from([
                ("title".into(), "Song".into()),
                ("artist".into(), "Artist".into()),
                ("isrc".into(), "GB-ABC-25-00001".into()),
            ]),
            lyrics: None,
            has_artwork: false,
        }
    }
    #[test]
    fn conflicting_isrc_is_rejected_even_for_explicit_url_or_same_title() {
        let document = document();
        let track = DownloadTrack {
            title: "Song".into(),
            artists: vec!["Artist".into()],
            isrc: "GBABC2500002".into(),
            duration_ms: 180_000,
            ..Default::default()
        };
        assert!(match_recording(&document, std::slice::from_ref(&track), true).is_err());
        assert!(match_recording(&document, &[track], false).is_err());
    }
    #[test]
    fn equivalent_formatted_isrc_is_accepted() {
        let document = document();
        let track = DownloadTrack {
            isrc: "gbabc2500001".into(),
            ..Default::default()
        };
        assert!(match_recording(&document, &[track], false).is_ok());
    }
    #[test]
    fn comment_reads_only_real_spotify_track_links() {
        let mut document = document();
        document.tags.insert(
            "comment".into(),
            "Source: https://open.spotify.com/intl-en/track/0123456789ABCDEFGHIJKL?si=test".into(),
        );
        assert_eq!(
            embedded_spotify_url(&document).as_deref(),
            Some("https://open.spotify.com/track/0123456789ABCDEFGHIJKL")
        );
        document.tags.insert(
            "comment".into(),
            "https://open.spotify.com.attacker.test/track/0123456789ABCDEFGHIJKL".into(),
        );
        assert!(embedded_spotify_url(&document).is_none());
        document.tags.insert(
            "comment".into(),
            "spotify:track:0123456789ABCDEFGHIJKL".into(),
        );
        assert!(embedded_spotify_url(&document).is_some());
    }
}
