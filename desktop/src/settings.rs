//! User preferences, stored as one readable JSON file.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Local Library identity only. Never sent to Spotify as a context URI.
pub const LIKED_SONGS_KEY: &str = "spotifast:liked-songs";

/// How the Library orders its playlists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LibrarySort {
    RecentlyPlayed,
    Name,
    Local,
}

/// The Library's order, kept in the shape older files used: one order per
/// shelf. The Library shows only playlists now, so the other shelves'
/// orders, and orders this version no longer offers, are dropped.
mod library_sort {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use super::LibrarySort;

    const PLAYLISTS: &str = "playlists";

    pub fn serialize<S: Serializer>(sort: &Option<LibrarySort>, to: S) -> Result<S::Ok, S::Error> {
        BTreeMap::from_iter(sort.map(|sort| (PLAYLISTS, sort))).serialize(to)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        from: D,
    ) -> Result<Option<LibrarySort>, D::Error> {
        let shelves = BTreeMap::<String, serde_json::Value>::deserialize(from)?;
        Ok(shelves
            .get(PLAYLISTS)
            .and_then(|sort| LibrarySort::deserialize(sort).ok()))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    Dark,
    Light,
    #[default]
    System,
}

/// Whether a Home shelf is drawn. Hidden shelves still refresh normally.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HomeShelfSettings {
    pub visible: bool,
}

impl Default for HomeShelfSettings {
    fn default() -> Self {
        Self { visible: true }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HomeSettings {
    /// The Discover playlists and the YouTube Music shelves. Older files
    /// call it `made_for_you`.
    #[serde(alias = "made_for_you")]
    pub discover: HomeShelfSettings,
}

/// Mini-player visualizer mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisMode {
    #[default]
    Bars,
    Scope,
    Off,
}

impl VisMode {
    /// Next mode in the display's click cycle.
    pub fn next(self) -> Self {
        match self {
            Self::Bars => Self::Scope,
            Self::Scope => Self::Off,
            Self::Off => Self::Bars,
        }
    }
}

/// The interface language: the operating system's, or one chosen in Settings.
///
/// Stored as `"system"` or a locale tag such as `"es"` or `"pt-BR"`. A file
/// without the field follows the system; a tag this version does not carry
/// also follows the system, rather than making the whole file unreadable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LanguageChoice {
    #[default]
    System,
    Locale(crate::i18n::Locale),
}

impl LanguageChoice {
    /// The locale the interface is drawn in.
    pub fn resolve(self) -> crate::i18n::Locale {
        match self {
            Self::System => crate::i18n::Locale::from_system(),
            Self::Locale(locale) => locale,
        }
    }
}

impl Serialize for LanguageChoice {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(match self {
            Self::System => "system",
            Self::Locale(locale) => locale.tag(),
        })
    }
}

impl<'de> Deserialize<'de> for LanguageChoice {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(value
            .as_str()
            .and_then(crate::i18n::Locale::from_tag)
            .map_or(Self::System, Self::Locale))
    }
}

impl ThemeChoice {
    pub const ALL: [ThemeChoice; 3] = [Self::System, Self::Light, Self::Dark];

    pub fn label(self, locale: crate::i18n::Locale) -> std::borrow::Cow<'static, str> {
        use crate::i18n::{gettext, pgettext};
        match self {
            Self::Dark => pgettext(locale, "theme", "Dark"),
            Self::Light => pgettext(locale, "theme", "Light"),
            Self::System => gettext(locale, "Follow system"),
        }
    }
}

/// Spacing throughout the music library. Compact retains cover art and all controls.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayDensity {
    #[default]
    Comfortable,
    Compact,
}

impl DisplayDensity {
    pub const ALL: [Self; 2] = [Self::Comfortable, Self::Compact];

    pub fn label(self, locale: crate::i18n::Locale) -> std::borrow::Cow<'static, str> {
        crate::i18n::gettext(
            locale,
            match self {
                Self::Comfortable => "Comfortable",
                Self::Compact => "Compact",
            },
        )
    }

    pub fn row_height(self) -> f32 {
        match self {
            Self::Comfortable => 56.0,
            Self::Compact => 48.0,
        }
    }
    pub fn queue_row_height(self) -> f32 {
        match self {
            Self::Comfortable => 48.0,
            Self::Compact => 44.0,
        }
    }
    pub fn card_width(self) -> f32 {
        match self {
            Self::Comfortable => 172.0,
            Self::Compact => 156.0,
        }
    }
    pub fn card_gap(self) -> f32 {
        match self {
            Self::Comfortable => 14.0,
            Self::Compact => 10.0,
        }
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// The name this computer's player goes by.
    pub device_name: String,
    pub autoplay: bool,
    /// Continue a single-song selection with related music from our service.
    pub similar_songs: bool,
    pub audio_device: Option<String>,
    pub theme: ThemeChoice,
    pub density: DisplayDensity,
    /// The interface language; older files without it follow the system.
    pub language: LanguageChoice,
    /// Filename selected from the local themes directory.
    pub custom_theme: Option<String>,
    /// Last accepted appearance, retained if its source file becomes unavailable.
    #[serde(
        default,
        deserialize_with = "fastframe_theme::read_cached_theme",
        skip_serializing_if = "Option::is_none"
    )]
    pub custom_theme_cache: Option<crate::theme::CustomTheme>,
    /// Last detected system palette, so following Omarchy survives a restart.
    #[serde(
        default,
        deserialize_with = "fastframe_theme::read_cached_theme",
        skip_serializing_if = "Option::is_none"
    )]
    pub system_theme_cache: Option<crate::theme::CustomTheme>,
    pub home: HomeSettings,
    /// Last local volume, 0..=65535.
    pub volume: u16,
    /// Whether the library sidebar is visible.
    pub sidebar_visible: bool,
    /// The playing album's art docked large at the sidebar's bottom.
    pub art_expanded: bool,
    /// Use compact single-line rows without cover art in the sidebar.
    pub sidebar_compact: bool,
    /// Show the Library as responsive cover cards instead of rows.
    pub sidebar_grid: bool,
    pub sidebar_width: f32,
    pub lyrics_width: f32,
    /// Use compact single-line rows without cover art in track lists.
    pub tracklist_compact: bool,
    /// Linux: middle-click a list to autoscroll it. Off by default, because
    /// Linux desktops usually paste the primary selection on middle click.
    /// Windows always autoscrolls and macOS never does.
    pub middle_click_autoscroll: bool,
    pub search_history: Vec<String>,
    /// Closing the window hides to the tray and keeps the music playing.
    pub keep_playing_in_background: bool,
    /// Context URIs and the local Liked Songs key, in pin order.
    pub pinned_contexts: Vec<String>,
    /// Older settings keep Liked Songs first until it is moved or unpinned.
    pub liked_songs_pinned: bool,
    /// The sidebar's own playlist order, set by dragging rows. Kept while
    /// another sort is selected; empty means no saved local arrangement.
    pub sidebar_order: Vec<String>,
    /// The Library's chosen order, if any. Selecting another order never
    /// deletes the local arrangement.
    #[serde(with = "library_sort")]
    pub library_sort: Option<LibrarySort>,
    /// Interface zoom, egui's zoom factor; Ctrl+plus/minus changes it.
    pub zoom: f32,
    /// The Winamp window is open.
    pub winamp_window: bool,
    /// Windows and X11: keep a taskbar button while the Winamp window is visible.
    pub winamp_show_taskbar: bool,
    /// Windows: draw Spotifast's own title bar and window buttons instead of
    /// the standard Windows frame.
    pub custom_titlebar: bool,
    /// Skin file or folder name. `None` selects the built-in skin.
    pub skin: Option<String>,
    /// Pick a different skin each time the mini player opens; `skin` holds
    /// the one picked.
    pub random_skin: bool,
    /// Screen pixels per skin pixel; `None` picks double size for the
    /// display.
    pub skin_scale: Option<u8>,
    /// The Winamp window stays above other windows.
    pub winamp_on_top: bool,
    /// The mini player's visualiser: bars, scope, or off.
    pub vis: VisMode,
    /// The playlist window is open under the mini player.
    pub playlist_open: bool,
    /// How tall the playlist window is, in skin pixels.
    pub playlist_height: u32,
    /// The equalizer window is open under the mini player.
    pub eq_open: bool,
    /// The equalizer shapes local playback.
    pub eq_on: bool,
    /// The preamp, in decibels, never above zero.
    pub eq_preamp_db: f32,
    /// The ten bands, in decibels, 60 Hz to 16 kHz.
    pub eq_bands_db: [f32; 10],
    /// The balance, -1 all left to 1 all right.
    pub balance: f32,
    /// Play both channels the same.
    pub mono: bool,
    /// The playlist window is rolled up to its title bar.
    pub playlist_shaded: bool,
    /// The equalizer window is rolled up to its title bar.
    pub eq_shaded: bool,
    /// The main window is rolled up to its title bar.
    pub winamp_shaded: bool,
    /// The MilkDrop window is open (its own window, not part of the skin).
    pub milkdrop_open: bool,
    /// How long each preset plays before the next, in seconds.
    pub milkdrop_seconds: u32,
    /// How many frames a second the MilkDrop window draws; 0 is uncapped.
    pub milkdrop_fps: u32,
    /// Last reported MilkDrop screen refresh rate. The first value sets the
    /// default frame rate; this field is not directly configurable.
    pub milkdrop_screen_hz: u32,
    /// The picture's inner resolution: 1 full, 2 half, 4 quarter.
    pub milkdrop_scale: u32,
    /// The MilkDrop window fills the screen.
    pub milkdrop_fullscreen: bool,
    /// The MilkDrop window's size in logical points, when not full-screen.
    pub milkdrop_size: [f32; 2],
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let preferences = serde_json::to_value(self).map_err(|_| std::fmt::Error)?;
        f.debug_struct("Settings")
            .field("preferences", &preferences)
            .finish()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            device_name: "Spotify".to_string(),
            autoplay: false,
            similar_songs: true,
            audio_device: None,
            theme: ThemeChoice::System,
            density: DisplayDensity::default(),
            language: LanguageChoice::System,
            custom_theme: None,
            custom_theme_cache: None,
            system_theme_cache: None,
            home: HomeSettings::default(),
            volume: (u16::MAX as u32 * 70 / 100) as u16,
            sidebar_visible: true,
            art_expanded: false,
            sidebar_compact: false,
            sidebar_grid: false,
            sidebar_width: 250.0,
            lyrics_width: 360.0,
            tracklist_compact: false,
            middle_click_autoscroll: false,
            search_history: Vec::new(),
            keep_playing_in_background: true,
            pinned_contexts: Vec::new(),
            liked_songs_pinned: true,
            sidebar_order: Vec::new(),
            library_sort: None,
            zoom: 1.0,
            winamp_window: false,
            winamp_show_taskbar: true,
            custom_titlebar: false,
            skin: None,
            random_skin: false,
            skin_scale: None,
            winamp_on_top: false,
            vis: VisMode::default(),
            playlist_open: false,
            playlist_height: 174,
            eq_open: false,
            eq_on: false,
            eq_preamp_db: 0.0,
            eq_bands_db: [0.0; 10],
            balance: 0.0,
            mono: false,
            playlist_shaded: false,
            eq_shaded: false,
            winamp_shaded: false,
            milkdrop_open: false,
            milkdrop_seconds: crate::milkdrop::DEFAULT_SECONDS,
            milkdrop_fps: crate::milkdrop::DEFAULT_FPS,
            milkdrop_screen_hz: 0,
            milkdrop_scale: 1,
            milkdrop_fullscreen: false,
            milkdrop_size: crate::milkdrop::DEFAULT_SIZE,
        }
    }
}

impl Settings {
    pub(crate) fn cached_palette(&self) -> Option<crate::theme::Palette> {
        let theme = if self.custom_theme.is_some() {
            self.custom_theme_cache.as_ref()
        } else if self.theme == ThemeChoice::System {
            self.system_theme_cache.as_ref()
        } else {
            None
        };
        theme.map(|theme| theme.palette)
    }

    pub fn library_pins(&self) -> Vec<String> {
        let mut pins = self.pinned_contexts.clone();
        if !self.liked_songs_pinned {
            pins.retain(|key| key != LIKED_SONGS_KEY);
        } else if !pins.iter().any(|key| key == LIKED_SONGS_KEY) {
            pins.insert(0, LIKED_SONGS_KEY.into());
        }
        pins
    }

    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                // A file edited in Notepad or Windows PowerShell can start with
                // a byte order mark, which JSON does not allow.
                let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
                let mut settings = serde_json::from_str(text).unwrap_or_else(|error| {
                    log::warn!("settings at {} are unreadable: {error}", path.display());
                    Self::default()
                });
                if settings.device_name == "Fastpotify" {
                    settings.device_name = "Spotifast".into();
                }
                for key in settings
                    .pinned_contexts
                    .iter_mut()
                    .chain(settings.sidebar_order.iter_mut())
                {
                    if key == "fastpotify:liked-songs" {
                        *key = LIKED_SONGS_KEY.into();
                    }
                }
                settings
            }
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let text = match self
            .encode_for_profile(path == crate::paths::AppDirs::legacy().settings_file())
        {
            Ok(text) => text,
            Err(error) => {
                log::warn!("unable to encode settings: {error}");
                return;
            }
        };
        let temporary = path.with_extension("json.tmp");
        let written = std::fs::write(&temporary, text)
            .and_then(|()| crate::util::replace_file(&temporary, path));
        if let Err(error) = written {
            log::warn!("unable to save settings to {}: {error}", path.display());
        }
    }

    fn encode_for_profile(&self, legacy: bool) -> serde_json::Result<String> {
        if !legacy {
            return serde_json::to_string_pretty(self);
        }
        // A trial launch can still roll back to a client that only recognizes
        // the previous local key. Keep its on-disk spelling until migration.
        let mut saved = self.clone();
        for key in saved
            .pinned_contexts
            .iter_mut()
            .chain(saved.sidebar_order.iter_mut())
        {
            if key == LIKED_SONGS_KEY {
                *key = "fastpotify:liked-songs".into();
            }
        }
        serde_json::to_string_pretty(&saved)
    }

    pub fn remember_search(&mut self, query: &str) {
        let query = query.trim();
        if query.is_empty() {
            return;
        }
        self.search_history.retain(|entry| entry != query);
        self.search_history.insert(0, query.to_string());
        self.search_history.truncate(12);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn trial_launch_writes_keys_the_previous_release_can_still_read() {
        let settings = super::Settings {
            pinned_contexts: vec![super::LIKED_SONGS_KEY.into(), "spotify:playlist:one".into()],
            sidebar_order: vec![super::LIKED_SONGS_KEY.into()],
            ..Default::default()
        };
        for (legacy, key) in [
            (true, "fastpotify:liked-songs"),
            (false, super::LIKED_SONGS_KEY),
        ] {
            let saved: super::Settings =
                serde_json::from_str(&settings.encode_for_profile(legacy).unwrap()).unwrap();
            assert_eq!(saved.pinned_contexts, [key, "spotify:playlist:one"]);
            assert_eq!(saved.sidebar_order, [key]);
        }
        assert_eq!(settings.pinned_contexts[0], super::LIKED_SONGS_KEY);
    }
    use super::Settings;

    #[test]
    fn new_profiles_follow_the_system_and_saved_choices_are_preserved() {
        use super::ThemeChoice;
        assert_eq!(Settings::default().theme, ThemeChoice::System);
        assert_eq!(ThemeChoice::default(), ThemeChoice::System);
        let empty: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.theme, ThemeChoice::System);
        for (json, choice) in [("dark", ThemeChoice::Dark), ("light", ThemeChoice::Light)] {
            let settings: Settings =
                serde_json::from_value(serde_json::json!({"theme": json, "volume": 37})).unwrap();
            assert_eq!(settings.theme, choice);
            assert_eq!(settings.volume, 37);
        }
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "theme": "dark", "system_theme_cache": {"broken": true}, "volume": 37
        }))
        .unwrap();
        assert!(settings.system_theme_cache.is_none());
        assert_eq!(settings.theme, ThemeChoice::Dark);
        assert_eq!(settings.volume, 37);
    }

    #[test]
    fn language_follows_the_system_unless_a_known_locale_was_chosen() {
        use super::LanguageChoice;
        use crate::i18n::Locale;
        assert_eq!(Settings::default().language, LanguageChoice::System);
        let older: Settings = serde_json::from_value(serde_json::json!({"volume": 37})).unwrap();
        assert_eq!(older.language, LanguageChoice::System);
        assert_eq!(older.volume, 37);
        for (json, choice) in [
            (serde_json::json!("system"), LanguageChoice::System),
            (
                serde_json::json!("es"),
                LanguageChoice::Locale(Locale::Spanish),
            ),
            (
                serde_json::json!("pt-BR"),
                LanguageChoice::Locale(Locale::PortugueseBrazil),
            ),
            (
                serde_json::json!("zh-Hant"),
                LanguageChoice::Locale(Locale::ChineseTraditional),
            ),
            (
                serde_json::json!("de"),
                LanguageChoice::Locale(Locale::German),
            ),
            // A language a later version added, or a hand-edited typo, keeps
            // the rest of the file and follows the system.
            (serde_json::json!("tlh"), LanguageChoice::System),
            (serde_json::json!(7), LanguageChoice::System),
            (serde_json::Value::Null, LanguageChoice::System),
        ] {
            let settings: Settings =
                serde_json::from_value(serde_json::json!({"language": json, "volume": 37}))
                    .unwrap();
            assert_eq!(settings.language, choice, "{json}");
            assert_eq!(settings.volume, 37);
        }
        for &locale in crate::i18n::LOCALES {
            let settings = Settings {
                language: LanguageChoice::Locale(locale),
                ..Default::default()
            };
            let text = serde_json::to_string(&settings).unwrap();
            assert!(text.contains(&format!("\"language\":\"{}\"", locale.tag())));
            let saved: Settings = serde_json::from_str(&text).unwrap();
            assert_eq!(saved.language, settings.language);
        }
        let text = serde_json::to_string(&Settings::default()).unwrap();
        assert!(text.contains("\"language\":\"system\""));
        assert_eq!(
            LanguageChoice::System.resolve(),
            Locale::English,
            "tests pin English"
        );
    }

    #[test]
    fn display_density_keeps_existing_settings_and_round_trips() {
        use super::DisplayDensity;
        let old: Settings =
            serde_json::from_str(r#"{"volume":12345,"tracklist_compact":true}"#).unwrap();
        assert_eq!(old.density, DisplayDensity::Comfortable);
        assert_eq!(old.volume, 12345);
        assert!(old.tracklist_compact);
        let settings = Settings {
            density: DisplayDensity::Compact,
            ..old
        };
        let restored: Settings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(restored, settings);
        assert!(
            restored.tracklist_compact,
            "density must preserve the separate coverless preference"
        );
    }

    #[test]
    fn custom_theme_cache_round_trips_and_a_bad_cache_keeps_other_settings() {
        let mut settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.custom_theme.is_none() && settings.custom_theme_cache.is_none());
        settings.custom_theme = Some("gruvbox.json".into());
        let mut palette = crate::theme::Palette::light();
        palette.shadow = egui::Color32::from_rgba_unmultiplied(37, 128, 249, 117);
        settings.custom_theme_cache = Some(crate::theme::CustomTheme {
            filename: "gruvbox.json".into(),
            palette,
        });
        let encoded = serde_json::to_string(&settings).unwrap();
        assert_eq!(
            serde_json::from_str::<Settings>(&encoded).unwrap(),
            settings
        );
        let mut damaged = serde_json::to_value(&settings).unwrap();
        damaged["custom_theme_cache"] = serde_json::json!({"palette": "broken"});
        damaged["volume"] = 777.into();
        let recovered: Settings = serde_json::from_value(damaged).unwrap();
        assert_eq!(recovered.custom_theme.as_deref(), Some("gruvbox.json"));
        assert_eq!(recovered.volume, 777);
        assert!(recovered.custom_theme_cache.is_none());
    }

    #[test]
    fn partial_home_preferences_keep_defaults_and_survive_a_settings_round_trip() {
        for (home, discover) in [
            ("{}", true),
            (r#"{"discover":{"visible":false}}"#, false),
            // The setting's older name, and a shelf Home no longer has.
            (r#"{"made_for_you":{"visible":false}}"#, false),
            (r#"{"recommendations":{"visible":false}}"#, true),
        ] {
            let settings: Settings =
                serde_json::from_str(&format!(r#"{{"volume":12345,"home":{home}}}"#)).unwrap();
            assert_eq!(settings.home.discover.visible, discover);
            assert_eq!(settings.volume, 12345);
            let saved = serde_json::to_string(&settings).unwrap();
            assert!(!saved.contains("made_for_you") && !saved.contains("recommendations"));
            let restored: Settings = serde_json::from_str(&saved).unwrap();
            assert_eq!(restored, settings);
        }
        let old: Settings = serde_json::from_str(r#"{"volume":12345}"#).unwrap();
        assert!(old.home.discover.visible);
        assert_eq!(old.volume, 12345);
    }

    /// Notepad and Windows PowerShell can save UTF-8 with a byte order mark.
    /// A file edited that way, as the Home shelves guide asks, is still read
    /// rather than dropped as unreadable and replaced with the defaults.
    #[test]
    fn a_settings_file_saved_with_a_byte_order_mark_keeps_its_preferences() {
        let dir = std::env::temp_dir().join(format!("spotifast-bom-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            "\u{feff}{\"volume\":12345,\"home\":{\"made_for_you\":{\"visible\":false}}}",
        )
        .unwrap();
        let settings = Settings::load(&path);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(settings.volume, 12345);
        assert!(!settings.home.discover.visible);
    }

    /// Settings the app no longer has are skipped, not a reason to start
    /// over from the defaults.
    #[test]
    fn a_settings_file_with_retired_settings_keeps_its_preferences() {
        let dir = std::env::temp_dir().join(format!("spotifast-retired-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "volume": 12345,
                "theme": "light",
                "bitrate": 160,
                "normalisation": true,
                "gapless": false,
                "audio_backend": "rodio",
                "audio_buffer_ms": 250,
                "audio_cache": false,
                "audio_cache_mb": 2048,
                "show_shortcut_hints": false,
                "web_client_id": "personal-app",
                "personal_app_nudge_at": "2026-09-03T15:00:00Z",
                "personal_app_intro_seen": true,
                "playback_authorized": true,
                "check_for_updates": true,
                "download_updates_automatically": true,
                "proxy": "http://proxy.example:8080",
                "proxy_mode": "http",
                "proxy_host": "proxy.example",
                "proxy_port": "8080",
                "proxy_username": "listener"
            })
            .to_string(),
        )
        .unwrap();
        let settings = Settings::load(&path);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(settings.volume, 12345);
        assert_eq!(settings.theme, super::ThemeChoice::Light);
        let saved = serde_json::to_value(&settings).unwrap();
        for retired in [
            "bitrate",
            "proxy_mode",
            "web_client_id",
            "check_for_updates",
        ] {
            assert!(saved.get(retired).is_none(), "{retired} is written again");
        }
    }

    /// Older files kept an order for each Library shelf. The playlists'
    /// order survives; the others, and the Spotify order, are dropped
    /// without losing the rest of the file.
    #[test]
    fn the_library_keeps_its_playlist_order_from_older_files() {
        for (sorts, kept) in [
            (
                r#"{"playlists": "name", "albums": "recently_added"}"#,
                Some(super::LibrarySort::Name),
            ),
            (r#"{"playlists": "spotify", "podcasts": "library"}"#, None),
            ("{}", None),
        ] {
            let settings: Settings =
                serde_json::from_str(&format!(r#"{{"volume": 37, "library_sort": {sorts}}}"#))
                    .unwrap();
            assert_eq!(settings.volume, 37);
            assert_eq!(settings.library_sort, kept);
            let saved: Settings =
                serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
            assert_eq!(saved.library_sort, kept);
        }
    }

    #[test]
    fn older_settings_keep_the_sidebar_visible() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.sidebar_visible);
    }

    #[test]
    fn older_library_settings_keep_liked_songs_ahead_of_existing_pins() {
        let settings: Settings = serde_json::from_str(
            r#"{"pinned_contexts":["spotify:playlist:one"],"sidebar_order":["spotify:playlist:two"]}"#,
        ).unwrap();
        assert!(settings.liked_songs_pinned);
        assert_eq!(
            settings.library_pins(),
            [super::LIKED_SONGS_KEY, "spotify:playlist:one"]
        );
        assert_eq!(settings.sidebar_order, ["spotify:playlist:two"]);
    }

    #[test]
    fn older_settings_keep_the_winamp_window_closed_and_the_built_in_skin() {
        let settings: Settings = serde_json::from_str(r#"{"zoom": 1.2}"#).unwrap();
        assert!(!settings.winamp_window);
        assert!(settings.winamp_show_taskbar);
        assert_eq!(settings.skin, None);
        assert_eq!(settings.skin_scale, None);
        assert!(!settings.winamp_on_top);
        assert_eq!(settings.vis, super::VisMode::Bars);
        assert!(!settings.playlist_open);
        assert_eq!(settings.playlist_height, 174);
        assert!(!settings.eq_on);
        assert_eq!(settings.eq_bands_db, [0.0; 10]);
        assert_eq!(settings.balance, 0.0);
        assert!(!settings.mono);
        assert!(!settings.playlist_shaded);
        assert!(!settings.eq_shaded);
        assert!(!settings.winamp_shaded);
    }

    #[test]
    fn the_visualiser_cycles_bars_scope_off() {
        use super::VisMode;
        assert_eq!(VisMode::Bars.next(), VisMode::Scope);
        assert_eq!(VisMode::Scope.next(), VisMode::Off);
        assert_eq!(VisMode::Off.next(), VisMode::Bars);
        let settings: Settings = serde_json::from_str(r#"{"vis": "scope"}"#).unwrap();
        assert_eq!(settings.vis, VisMode::Scope);
    }

    #[test]
    fn a_chosen_skin_round_trips() {
        let settings = Settings {
            winamp_window: true,
            skin: Some("Zaxon.wsz".into()),
            skin_scale: Some(3),
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let restored: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, settings);
    }

    #[test]
    fn hidden_sidebar_round_trips() {
        let settings = Settings {
            sidebar_visible: false,
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let restored: Settings = serde_json::from_str(&json).unwrap();
        assert!(!restored.sidebar_visible);
    }

    #[test]
    fn older_settings_default_to_standard_sidebar() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(!settings.sidebar_compact);
    }

    #[test]
    fn compact_sidebar_round_trips() {
        let settings = Settings {
            sidebar_compact: true,
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let restored: Settings = serde_json::from_str(&json).unwrap();
        assert!(restored.sidebar_compact);
    }

    #[test]
    fn library_grid_round_trips_and_older_settings_keep_the_list() {
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert!(!old.sidebar_grid);

        let settings = Settings {
            sidebar_grid: true,
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let restored: Settings = serde_json::from_str(&json).unwrap();
        assert!(restored.sidebar_grid);
    }

    #[test]
    fn older_settings_default_to_standard_tracklist() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(!settings.tracklist_compact);
    }

    #[test]
    fn compact_tracklist_round_trips() {
        let settings = Settings {
            tracklist_compact: true,
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let restored: Settings = serde_json::from_str(&json).unwrap();
        assert!(restored.tracklist_compact);
    }

    #[test]
    fn older_settings_keep_the_chosen_skin() {
        let settings: Settings = serde_json::from_str(r#"{"skin":"A.wsz"}"#).unwrap();
        assert!(!settings.random_skin);
        assert_eq!(settings.skin.as_deref(), Some("A.wsz"));
    }

    #[test]
    fn middle_click_autoscroll_is_opt_in_and_round_trips() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(!settings.middle_click_autoscroll);
        let settings = Settings {
            middle_click_autoscroll: true,
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let restored: Settings = serde_json::from_str(&json).unwrap();
        assert!(restored.middle_click_autoscroll);
    }
}

/// The profile of the account last signed in to a music server. The next
/// launch opens onto it while that server restores the saved session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CachedAccount {
    pub origin: String,
    pub user: crate::api::models::User,
}

/// Restorable UI session: what was open when the app last closed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionState {
    pub last_page: Option<String>,
    /// Context URIs most recently played, newest first.
    pub recent_contexts: Vec<String>,
    /// What was playing when the app closed, to resume from a cold start.
    pub last_context: Option<String>,
    pub last_track: Option<String>,
    pub last_position_ms: u32,
    /// Local podcast positions, keyed by account ID and episode URI.
    pub episode_progress: std::collections::HashMap<String, crate::api::models::ResumePoint>,
    /// Manually queued songs to restore with the remembered track.
    ///
    /// Context rows are excluded to prevent duplicates. This replaced the old
    /// `last_queue` field, so sessions using that field restore no added rows.
    pub last_added_queue: Vec<String>,
    /// Queue rows displayed on the next start. Playback restores manual rows
    /// from `last_added_queue`; it does not enqueue this list.
    pub last_queue_rows: Vec<crate::api::models::PlayableItem>,
    /// The signed-in account, cleared when it signs out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<CachedAccount>,
    /// Shuffle mode saved across contexts and restarts.
    pub shuffle_on: bool,
    /// Each table's chosen sort, by encoded page, restored at start.
    pub sorts: Vec<(String, crate::model::TableSort)>,
    /// Last window inner size, to restore on next launch.
    pub window_size: Option<[f32; 2]>,
    /// Last window outer position, to restore on next launch.
    pub window_pos: Option<[f32; 2]>,
    /// Whether the queue panel was open.
    pub queue_open: Option<bool>,
    /// Which tab the queue panel showed: `queue` or `recents`.
    pub queue_tab: Option<String>,
    /// Last outer position of the Winamp window.
    pub winamp_pos: Option<[f32; 2]>,
    /// Last outer position of the MilkDrop window.
    pub milkdrop_pos: Option<[f32; 2]>,
    /// The window mode fullscreen lyrics left, when the app closed while
    /// showing them. eframe restores the window full screen, so the next
    /// start returns it to this mode instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics_fullscreen_from: Option<WindowMode>,
}

/// Whether a window was full screen, and whether it was maximized.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowMode {
    pub fullscreen: bool,
    pub maximized: bool,
}

impl SessionState {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let text = match serde_json::to_string(self) {
            Ok(text) => text,
            Err(error) => {
                log::warn!("unable to encode session: {error}");
                return;
            }
        };
        let temporary = path.with_extension("json.tmp");
        let written = std::fs::write(&temporary, text)
            .and_then(|()| crate::util::replace_file(&temporary, path));
        if let Err(error) = written {
            log::warn!("unable to save session to {}: {error}", path.display());
        }
    }
}

#[cfg(test)]
mod session_tests {
    use super::{CachedAccount, SessionState};

    #[test]
    fn old_sessions_with_a_playlist_tree_remain_readable() {
        let state: SessionState = serde_json::from_str(
            r#"{"last_page":"home","collapsed_folders":["f1"],"rootlist":{"account_id":"listener","entries":[{"Playlist":"spotify:playlist:one"}]}}"#,
        )
        .unwrap();
        assert_eq!(state.last_page.as_deref(), Some("home"));
        assert_eq!(state.account, None);
    }

    #[test]
    fn the_account_round_trips_with_its_server() {
        let state = SessionState {
            account: Some(CachedAccount {
                origin: "https://music.example".into(),
                user: crate::api::models::User {
                    id: "listener".into(),
                    display_name: Some("Listener".into()),
                    ..Default::default()
                },
            }),
            ..SessionState::default()
        };

        let json = serde_json::to_string(&state).unwrap();
        assert_eq!(serde_json::from_str::<SessionState>(&json).unwrap(), state);
    }

    #[test]
    fn a_new_session_atomically_replaces_the_previous_one() {
        let root = std::env::temp_dir().join(format!(
            "spotifast-session-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let path = root.join("session.json");
        let state = |page: &str| SessionState {
            last_page: Some(page.into()),
            ..SessionState::default()
        };

        state("home").save(&path);
        state("liked").save(&path);

        assert_eq!(
            SessionState::load(&path).last_page.as_deref(),
            Some("liked")
        );
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
