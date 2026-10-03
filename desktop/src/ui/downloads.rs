//! Native music downloads: selection, export preferences, and a durable queue.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use egui::{Align, CornerRadius, Frame, Layout, Margin, RichText, Stroke, vec2};

use crate::app::App;
use crate::i18n::Locale;
use crate::model::{Action, Loadable};
use crate::music_api::downloads::{
    CatalogKind, CatalogPage, DownloadCollection, DownloadQuality, DownloadSource, DownloadTrack,
    TrackAvailability,
};
use crate::music_downloads::{
    ArtistSeparator, Destination, DownloadJob, DuplicatePolicy, ExistingFileCheck, ExportOptions,
    JobStage, LinkResolver, MetadataTags, OutputFormat, QueueState, ReplayGainMode,
};
use crate::theme::{self, Icon, Palette};

use super::widgets;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DownloadTab {
    #[default]
    Browse,
    Queue,
    History,
    Tools,
    Settings,
}

pub struct DownloadViewState {
    pub query: String,
    pub catalog_kind: CatalogKind,
    pub catalog: Loadable<CatalogPage>,
    pub catalog_query: String,
    pub catalog_request: u64,
    pub show_catalog: bool,
    pub availability: Loadable<TrackAvailability>,
    pub availability_track: Option<DownloadTrack>,
    pub availability_request: u64,
    pub committed_query: String,
    pub recent_inputs: Vec<String>,
    pub filter: String,
    pub queue_filter: String,
    pub metadata: Loadable<Arc<DownloadCollection>>,
    pub selected: HashSet<String>,
    pub tab: DownloadTab,
    pub options: ExportOptions,
    pub lookup_request: u64,
    pub error: Option<String>,
    pub history_ready: bool,
    pub history_error: Option<String>,
    pub tools: super::download_tools::ToolsViewState,
    pub preferences_busy: bool,
    pub source_checks_busy: bool,
    pub source_checks: Vec<crate::music_api::downloads::DownloadSourceCheck>,
    filtered_collection: usize,
    filtered_query: String,
    filtered_rows: Arc<[usize]>,
}

impl Default for DownloadViewState {
    fn default() -> Self {
        Self {
            query: String::new(),
            catalog_kind: CatalogKind::default(),
            catalog: Loadable::NotLoaded,
            catalog_query: String::new(),
            catalog_request: 0,
            show_catalog: false,
            availability: Loadable::NotLoaded,
            availability_track: None,
            availability_request: 0,
            committed_query: String::new(),
            recent_inputs: Vec::new(),
            filter: String::new(),
            queue_filter: String::new(),
            metadata: Loadable::NotLoaded,
            selected: HashSet::new(),
            tab: DownloadTab::Browse,
            options: ExportOptions::default(),
            lookup_request: 0,
            error: None,
            history_ready: false,
            history_error: None,
            tools: super::download_tools::ToolsViewState::default(),
            preferences_busy: false,
            source_checks_busy: false,
            source_checks: Vec::new(),
            filtered_collection: 0,
            filtered_query: String::new(),
            filtered_rows: Arc::from([]),
        }
    }
}

impl DownloadViewState {
    pub fn set_collection(&mut self, collection: Arc<DownloadCollection>) {
        self.selected = collection
            .tracks
            .iter()
            .map(|track| track.id.clone())
            .collect();
        self.filter.clear();
        self.show_catalog = false;
        self.availability = Loadable::NotLoaded;
        self.availability_track = None;
        self.availability_request = self.availability_request.wrapping_add(1);
        self.filtered_collection = 0;
        self.error = None;
        self.metadata = Loadable::Loaded(collection);
        self.tab = DownloadTab::Browse;
    }

    fn filtered_tracks(&mut self, collection: &DownloadCollection) -> Arc<[usize]> {
        let key = collection as *const DownloadCollection as usize;
        let query = self.filter.trim().to_lowercase();
        if self.filtered_collection != key || self.filtered_query != query {
            self.filtered_rows = collection
                .tracks
                .iter()
                .enumerate()
                .filter(|(_, track)| matches_track(track, &query))
                .map(|(index, _)| index)
                .collect();
            self.filtered_collection = key;
            self.filtered_query = query;
        }
        Arc::clone(&self.filtered_rows)
    }

    pub fn selected_tracks(&self) -> Vec<DownloadTrack> {
        self.metadata.get().map_or_else(Vec::new, |collection| {
            collection
                .tracks
                .iter()
                .filter(|track| self.selected.contains(&track.id))
                .cloned()
                .collect()
        })
    }
}

#[derive(Clone, Debug)]
pub enum DownloadAction {
    Find,
    Search(u32),
    ResolveItem(String),
    CheckAvailability(String),
    ExportAssets(crate::download_tasks::assets::AssetKind),
    ArtistImages(String),
    Tools(super::download_tools::ToolAction),
    ExportPreferences,
    ImportPreferences,
    CheckSources,
    ReloadHistory,
    RecoverHistory,
    Resolve,
    ChooseFolder,
    EnqueueSelected,
    Cancel(u64),
    Retry(u64),
    RetryFailed,
    PauseQueue,
    ResumeQueue,
    ClearFinished,
    Reveal(PathBuf),
    OpenFile(PathBuf),
    OpenLibrarySong(String),
}

pub fn draw(ui: &mut egui::Ui, app: &mut App) {
    ui.vertical(|ui| {
        ui.set_max_width(1180.0);
        draw_content(ui, app);
    });
}

fn draw_content(ui: &mut egui::Ui, app: &mut App) {
    let mut actions = Vec::new();
    let palette = app.palette;
    let state = &mut app.downloads;
    let queue = &app.download_queue;
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        theme::text(
            ui,
            "Downloads",
            theme::semibold(theme::PAGE_TITLE_SIZE),
            palette.text,
        );
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if theme::soft_button(ui, &palette, Some(Icon::Folder), "Show folder", false)
                .on_hover_text(state.options.output_dir.display().to_string())
                .clicked()
            {
                actions.push(DownloadAction::Reveal(state.options.output_dir.clone()));
            }
        });
    });
    theme::subtle(ui, &palette, "Find, save, and manage your music.");
    ui.add_space(22.0);

    let pending = queue
        .jobs
        .iter()
        .filter(|job| job.stage == JobStage::Queued || job.stage.active())
        .count();
    let history = queue.jobs.len().saturating_sub(pending);
    let queue_label = if pending == 0 {
        "Queue".to_owned()
    } else {
        format!("Queue · {pending}")
    };
    let history_label = if history == 0 {
        "History".to_owned()
    } else {
        format!("History · {history}")
    };
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing.x = 24.0;
        for (tab, label) in [
            (DownloadTab::Browse, "Find music"),
            (DownloadTab::Queue, queue_label.as_str()),
            (DownloadTab::History, history_label.as_str()),
            (DownloadTab::Tools, "Tools"),
            (DownloadTab::Settings, "Settings"),
        ] {
            let active = state.tab == tab;
            let response = ui.add(
                egui::Button::new(RichText::new(label).font(theme::medium(14.0)).color(
                    if active {
                        palette.text
                    } else {
                        palette.secondary
                    },
                ))
                .frame(false)
                .min_size(vec2(0.0, 36.0)),
            );
            if active {
                ui.painter().hline(
                    response.rect.x_range(),
                    response.rect.bottom(),
                    Stroke::new(2.0, palette.accent),
                );
            }
            if response.clicked() {
                state.tab = tab;
            }
        }
    });
    ui.separator();
    ui.add_space(16.0);
    history_status(ui, &palette, state, &mut actions);
    if let Some(error) = &state.error {
        notice(ui, &palette, error, true);
        ui.add_space(12.0);
    }
    match state.tab {
        DownloadTab::Tools => {
            state.tools.lyrics_options = state.options.lyrics.clone();
            super::download_tools::draw(ui, &palette, app.locale, &mut state.tools, &mut actions);
            state.options.lyrics = state.tools.lyrics_options.clone();
        }
        DownloadTab::Settings => {
            ui.vertical(|ui| {
                ui.set_max_width(720.0);
                ui.add_enabled_ui(state.history_ready, |ui| {
                    export_options(ui, &palette, app.locale, &mut state.options, &mut actions);
                });
                settings_utilities(ui, &palette, state, &mut actions);
            });
        }
        DownloadTab::Browse => browse(ui, &palette, app.locale, state, &mut actions),
        DownloadTab::Queue | DownloadTab::History => {
            if state.history_ready {
                jobs(ui, &palette, app.locale, state, queue, &mut actions);
            }
        }
    }
    app.actions
        .extend(actions.into_iter().map(Action::Downloads));
}

fn settings_utilities(
    ui: &mut egui::Ui,
    palette: &Palette,
    state: &mut DownloadViewState,
    actions: &mut Vec<DownloadAction>,
) {
    ui.add_space(24.0);
    theme::section_title(ui, palette, "Settings backup");
    ui.add(egui::Label::new(RichText::new("Export these preferences or import a Spotify / SpotiFLAC settings file. Music and history are not included.").size(13.0).color(palette.secondary)).wrap());
    ui.add_enabled_ui(state.history_ready && !state.preferences_busy, |ui| {
        ui.horizontal_wrapped(|ui| {
            if theme::soft_button(
                ui,
                palette,
                Some(Icon::ExternalLink),
                "Export settings",
                false,
            )
            .clicked()
            {
                actions.push(DownloadAction::ExportPreferences);
            }
            if theme::soft_button(ui, palette, Some(Icon::Folder), "Import settings", false)
                .clicked()
            {
                actions.push(DownloadAction::ImportPreferences);
            }
        });
    });
    if state.preferences_busy {
        theme::subtle(ui, palette, "Working with settings…");
    }
    ui.add_space(24.0);
    theme::section_title(ui, palette, "Custom instance checks");
    ui.add(egui::Label::new(RichText::new("Check that configured custom endpoints respond. Reachability does not verify their login or audio availability.").size(13.0).color(palette.secondary)).wrap());
    if ui
        .add_enabled_ui(!state.source_checks_busy, |ui| {
            theme::soft_button(
                ui,
                palette,
                Some(Icon::Refresh),
                "Check reachability",
                false,
            )
        })
        .inner
        .clicked()
    {
        actions.push(DownloadAction::CheckSources);
    }
    if state.source_checks_busy {
        theme::subtle(ui, palette, "Checking configured instances…");
    }
    for check in &state.source_checks {
        ui.horizontal_wrapped(|ui| {
            theme::icon(
                ui,
                if check.ok {
                    Icon::CircleCheck
                } else {
                    Icon::Info
                },
                16.0,
                if check.ok {
                    palette.accent
                } else {
                    palette.secondary
                },
            );
            ui.label(
                RichText::new(format!("{}: {}", check.source, check.message))
                    .size(13.0)
                    .color(palette.secondary),
            );
        });
    }
}

fn history_status(
    ui: &mut egui::Ui,
    palette: &Palette,
    state: &DownloadViewState,
    actions: &mut Vec<DownloadAction>,
) {
    if state.history_ready {
        return;
    }
    if let Some(error) = &state.history_error {
        Frame::new().fill(palette.panel).stroke(Stroke::new(1.0, palette.outline))
            .corner_radius(8).inner_margin(Margin::same(14)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    theme::icon(ui, Icon::CircleAlert, 18.0, palette.warning);
                    theme::text(ui, "Download history couldn't be loaded", theme::semibold(14.0), palette.text);
                });
                ui.add(egui::Label::new(RichText::new(error).size(13.0).color(palette.secondary)).wrap());
                ui.add_space(8.0);
                ui.horizontal_wrapped(|ui| {
                    if theme::soft_button(ui, palette, Some(Icon::Refresh), "Retry history load", false).clicked() {
                        actions.push(DownloadAction::ReloadHistory);
                    }
                    if theme::soft_button(ui, palette, None, "Start new history", false).clicked() {
                        actions.push(DownloadAction::RecoverHistory);
                    }
                });
                ui.add_space(6.0);
                ui.add(egui::Label::new(RichText::new("Starting new history keeps a backup of the old record. Your music files stay untouched.").size(12.0).color(palette.secondary)).wrap());
            });
    } else {
        ui.horizontal(|ui| {
            theme::spinner(ui, 16.0, palette.secondary);
            theme::subtle(ui, palette, "Loading download history…");
        });
    }
    ui.add_space(14.0);
}

fn catalog_results(
    ui: &mut egui::Ui,
    palette: &Palette,
    state: &DownloadViewState,
    actions: &mut Vec<DownloadAction>,
) {
    let page = match &state.catalog {
        Loadable::Loading => {
            theme::spinner(ui, 18.0, palette.secondary);
            widgets::skeleton_rows(ui, palette, 5, 64.0);
            return;
        }
        Loadable::Failed(error) => {
            notice(ui, palette, error, true);
            return;
        }
        Loadable::NotLoaded => return,
        Loadable::Loaded(page) => page,
    };
    if page.items.is_empty() {
        widgets::empty_state(
            ui,
            palette,
            Icon::Search,
            "No matches",
            "Try another search or paste a direct Spotify link.",
        );
        return;
    }
    egui::ScrollArea::vertical()
        .id_salt("download-catalog")
        .max_height(650.0)
        .show_rows(ui, 64.0, page.items.len(), |ui, range| {
            for index in range {
                let item = &page.items[index];
                ui.push_id((&item.id, &item.kind), |ui| {
                    ui.horizontal(|ui| {
                        widgets::cover(
                            ui,
                            palette,
                            nonempty(&item.cover_url),
                            48.0,
                            5.0,
                            Icon::Music,
                        );
                        let width = (ui.available_width()
                            - if item.kind == "artist" { 180.0 } else { 74.0 })
                        .max(100.0);
                        ui.allocate_ui_with_layout(
                            vec2(width, 54.0),
                            Layout::top_down(Align::Min),
                            |ui| {
                                ui.add(
                                    egui::Label::new(
                                        RichText::new(&item.title).font(theme::medium(14.0)),
                                    )
                                    .truncate(),
                                )
                                .on_hover_text(&item.title);
                                ui.add(
                                    egui::Label::new(
                                        RichText::new(&item.subtitle)
                                            .size(12.0)
                                            .color(palette.secondary),
                                    )
                                    .truncate(),
                                )
                                .on_hover_text(&item.subtitle);
                            },
                        );
                        if item.kind == "artist"
                            && ui
                                .add_enabled(
                                    !state.tools.busy && state.history_ready,
                                    egui::Button::new("Artwork"),
                                )
                                .on_hover_text("Save artist images without loading the discography")
                                .clicked()
                        {
                            actions.push(DownloadAction::ArtistImages(item.source_url.clone()));
                        }
                        if theme::soft_button(ui, palette, None, "Choose", false).clicked() {
                            actions.push(DownloadAction::ResolveItem(item.source_url.clone()));
                        }
                    })
                });
            }
        });
    ui.add_space(12.0);
    ui.horizontal_wrapped(|ui| {
        theme::subtle(
            ui,
            palette,
            &if page.total_exact {
                format!(
                    "{}–{} of {}",
                    page.offset + 1,
                    page.offset + page.items.len() as u32,
                    page.total
                )
            } else {
                format!(
                    "{}–{}{}",
                    page.offset + 1,
                    page.offset + page.items.len() as u32,
                    if page.has_more {
                        " · more available"
                    } else {
                        ""
                    }
                )
            },
        );
        if ui
            .add_enabled(page.offset > 0, egui::Button::new("Previous"))
            .clicked()
        {
            actions.push(DownloadAction::Search(
                page.offset.saturating_sub(page.limit),
            ));
        }
        if ui
            .add_enabled(
                page.has_more && page.offset + page.limit < 1000,
                egui::Button::new("Next"),
            )
            .clicked()
        {
            actions.push(DownloadAction::Search(page.offset + page.limit));
        }
    });
}

fn availability_panel(ui: &mut egui::Ui, palette: &Palette, state: &DownloadViewState) {
    let Some(track) = &state.availability_track else {
        return;
    };
    ui.add_space(16.0);
    theme::section_title(ui, palette, &format!("Sources for {}", track.title));
    match &state.availability {
        Loadable::Loading => {
            theme::spinner(ui, 16.0, palette.secondary);
            theme::subtle(ui, palette, "Checking provider catalogs…");
        }
        Loadable::Failed(error) => notice(ui, palette, error, true),
        Loadable::Loaded(result) => {
            for source in &result.sources {
                ui.horizontal_wrapped(|ui| {
                    let label = match source.status.as_str() {
                        "available" => "Catalog match",
                        "unavailable" => "No match",
                        _ => "Unverified",
                    };
                    ui.label(RichText::new(format!("{} · {label}", source.source)).color(
                        if source.status == "available" {
                            palette.accent
                        } else {
                            palette.secondary
                        },
                    ));
                    ui.add(
                        egui::Label::new(
                            RichText::new(&source.message)
                                .size(12.0)
                                .color(palette.secondary),
                        )
                        .wrap(),
                    );
                });
            }
            theme::subtle(
                ui,
                palette,
                "Catalog matches do not confirm audio availability or quality. Those are verified when downloading.",
            );
        }
        Loadable::NotLoaded => {}
    }
}

pub(super) fn lyrics_settings(
    ui: &mut egui::Ui,
    palette: &Palette,
    options: &mut crate::music_downloads::LyricsOptions,
) {
    use crate::music_downloads::LyricsTranslationProvider;
    ui.checkbox(
        &mut options.title_fallback,
        "Try a cleaned-up song title if lyrics are missing",
    );
    let providers: Vec<_> = LyricsTranslationProvider::ALL
        .iter()
        .map(|&provider| (provider, provider.label()))
        .collect();
    labeled_combo(
        ui,
        "Translate lyrics with",
        "lyrics-cli-provider",
        &mut options.translation_provider,
        &providers,
    );
    if options.translation_provider != LyricsTranslationProvider::Off {
        ui.horizontal_wrapped(|ui| {
            theme::subtle(ui, palette, "Target language");
            ui.add(
                egui::TextEdit::singleline(&mut options.language)
                    .desired_width(190.0)
                    .char_limit(80),
            );
        });
        ui.checkbox(
            &mut options.fallback,
            "Try the other CLI if the selected one fails",
        );
        ui.add(egui::Label::new(RichText::new("Uses Codex or Claude CLI installed and signed in on this Mac. Lyrics are sent to the chosen service; no API key is stored here.").size(12.0).color(palette.secondary)).wrap());
    }
}

fn browse(
    ui: &mut egui::Ui,
    palette: &Palette,
    locale: Locale,
    state: &mut DownloadViewState,
    actions: &mut Vec<DownloadAction>,
) {
    let loading =
        matches!(state.metadata, Loadable::Loading) || matches!(state.catalog, Loadable::Loading);
    ui.horizontal(|ui| {
        let width = (ui.available_width() - 108.0).max(100.0);
        let response = widgets::search_field(
            ui,
            palette,
            locale,
            ui.id().with("download-input"),
            &mut state.query,
            "Paste a Spotify link or search songs and artists",
            width,
        );
        let enter = response.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter));
        let enabled = state.query.trim().len() >= 2 && !loading;
        let clicked = ui
            .add_enabled_ui(enabled, |ui| {
                theme::pill_button(ui, palette, "Find music", false)
            })
            .inner
            .clicked();
        if enabled && (clicked || enter) {
            actions.push(DownloadAction::Find);
        }
    });
    ui.add_space(8.0);
    ui.add(
        egui::Label::new(
            RichText::new(
                "Search by title or artist, or paste a link to a track, album, playlist, or artist.",
            )
            .size(13.0)
            .color(palette.secondary),
        )
        .wrap(),
    );
    ui.horizontal_wrapped(|ui| {
        for kind in CatalogKind::ALL {
            if ui
                .selectable_value(&mut state.catalog_kind, kind, kind.label())
                .clicked()
                && state.query.trim().len() >= 2
            {
                actions.push(DownloadAction::Search(0));
            }
        }
    });
    ui.add_space(20.0);
    if state.show_catalog {
        catalog_results(ui, palette, state, actions);
        return;
    }
    let collection = match &state.metadata {
        Loadable::Loading => {
            ui.horizontal(|ui| {
                theme::spinner(ui, 18.0, palette.secondary);
                theme::subtle(ui, palette, "Finding music…");
            });
            ui.add_space(12.0);
            widgets::skeleton_rows(ui, palette, 5, 54.0);
            return;
        }
        Loadable::Failed(error) => {
            notice(ui, palette, error, true);
            return;
        }
        Loadable::NotLoaded => {
            if !state.recent_inputs.is_empty() {
                theme::section_title(ui, palette, "Recent lookups");
                ui.add_space(8.0);
                for input in state.recent_inputs.clone().iter().take(8) {
                    if ui
                        .add(
                            egui::Button::new(RichText::new(input).font(theme::regular(13.0)))
                                .truncate()
                                .frame(false),
                        )
                        .on_hover_text(input)
                        .clicked()
                    {
                        state.query = input.clone();
                        actions.push(DownloadAction::Resolve);
                    }
                }
                return;
            }
            widgets::empty_state(
                ui,
                palette,
                Icon::Music,
                "Start with a song or a link",
                "Choose your tracks, then save to your Mac, your library, or both.",
            );
            return;
        }
        Loadable::Loaded(collection) => Arc::clone(collection),
    };
    if collection.tracks.is_empty() {
        widgets::empty_state(
            ui,
            palette,
            Icon::Search,
            "No tracks found",
            "Try another search or a direct Spotify song, album, or playlist link.",
        );
        return;
    }

    ui.horizontal_top(|ui| {
        widgets::cover(
            ui,
            palette,
            nonempty(&collection.cover_url),
            72.0,
            8.0,
            Icon::Disc,
        );
        ui.add_space(8.0);
        ui.vertical(|ui| {
            ui.add_space(4.0);
            theme::text(ui, &collection.title, theme::semibold(20.0), palette.text);
            theme::subtle(
                ui,
                palette,
                &format!(
                    "{} · {}",
                    collection.kind,
                    track_count(collection.tracks.len())
                ),
            );
        });
    });
    ui.add_space(20.0);
    if ui.available_width() >= 850.0 {
        let width = ui.available_width();
        ui.horizontal_top(|ui| {
            ui.allocate_ui_with_layout(
                vec2(width - 326.0, 0.0),
                Layout::top_down(Align::Min),
                |ui| {
                    selection(ui, palette, locale, state, &collection, actions);
                },
            );
            ui.add_space(16.0);
            ui.allocate_ui_with_layout(vec2(302.0, 0.0), Layout::top_down(Align::Min), |ui| {
                save_panel(ui, palette, locale, state, &collection, actions);
            });
        });
    } else {
        selection(ui, palette, locale, state, &collection, actions);
        ui.add_space(16.0);
        save_panel(ui, palette, locale, state, &collection, actions);
    }
}

fn save_panel(
    ui: &mut egui::Ui,
    palette: &Palette,
    locale: Locale,
    state: &mut DownloadViewState,
    collection: &DownloadCollection,
    actions: &mut Vec<DownloadAction>,
) {
    Frame::new()
        .fill(palette.panel)
        .stroke(Stroke::new(1.0, palette.outline))
        .corner_radius(10)
        .inner_margin(Margin::same(18))
        .show(ui, |ui| {
            ui.add_enabled_ui(state.history_ready, |ui| {
                export_options(ui, palette, locale, &mut state.options, actions);
            });
            ui.add_space(18.0);
            ui.separator();
            ui.add_space(12.0);
            let selected = collection
                .tracks
                .iter()
                .filter(|track| state.selected.contains(&track.id))
                .count();
            let label = match state.options.destination {
                Destination::Library => format!("Add {} to library", track_count(selected)),
                _ => format!("Download {}", track_count(selected)),
            };
            if ui
                .add_enabled_ui(selected > 0 && state.history_ready, |ui| {
                    theme::pill_button(ui, palette, &label, true)
                })
                .inner
                .clicked()
            {
                actions.push(DownloadAction::EnqueueSelected);
            }
        });
}

fn selection(
    ui: &mut egui::Ui,
    palette: &Palette,
    locale: Locale,
    state: &mut DownloadViewState,
    collection: &DownloadCollection,
    actions: &mut Vec<DownloadAction>,
) {
    let visible = state.filtered_tracks(collection);
    Frame::new()
        .fill(palette.panel)
        .corner_radius(8)
        .inner_margin(Margin::same(12))
        .show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                let mut all_visible = !visible.is_empty()
                    && visible
                        .iter()
                        .all(|&index| state.selected.contains(&collection.tracks[index].id));
                if ui.checkbox(&mut all_visible, "Select all shown").changed() {
                    for &index in visible.iter() {
                        let id = &collection.tracks[index].id;
                        if all_visible {
                            state.selected.insert(id.clone());
                        } else {
                            state.selected.remove(id);
                        }
                    }
                }
                theme::subtle(ui, palette, &format!("{} selected", state.selected.len()));
                let width = ui.available_width().clamp(160.0, 280.0);
                widgets::search_field(
                    ui,
                    palette,
                    locale,
                    ui.id().with("download-filter"),
                    &mut state.filter,
                    "Filter tracks",
                    width,
                );
            });
            ui.add_space(6.0);
            ui.separator();
            if visible.is_empty() {
                ui.add_space(16.0);
                theme::subtle(
                    ui,
                    palette,
                    "No tracks match this filter. Your other selections are kept.",
                );
                ui.add_space(16.0);
                return;
            }
            egui::ScrollArea::vertical()
                .id_salt("download-tracks")
                .max_height(510.0)
                .auto_shrink([false, true])
                .show_rows(ui, 54.0, visible.len(), |ui, range| {
                    for row in range {
                        let index = visible[row];
                        let track = &collection.tracks[index];
                        ui.push_id((&track.id, index), |ui| {
                            let mut selected = state.selected.contains(&track.id);
                            let width = ui.available_width();
                            ui.allocate_ui_with_layout(
                                vec2(width, 54.0),
                                Layout::left_to_right(Align::Center),
                                |ui| {
                                    let response = ui.checkbox(&mut selected, "");
                                    response.widget_info(|| {
                                        egui::WidgetInfo::selected(
                                            egui::WidgetType::Checkbox,
                                            true,
                                            selected,
                                            format!(
                                                "Select {} by {}",
                                                track.title,
                                                track.artists.join(", ")
                                            ),
                                        )
                                    });
                                    if response.changed() {
                                        if selected {
                                            state.selected.insert(track.id.clone());
                                        } else {
                                            state.selected.remove(&track.id);
                                        }
                                    }
                                    widgets::cover(
                                        ui,
                                        palette,
                                        nonempty(&track.cover_url),
                                        38.0,
                                        4.0,
                                        Icon::Music,
                                    );
                                    let album_width = if width > 720.0 {
                                        (width * 0.24).min(220.0)
                                    } else {
                                        0.0
                                    };
                                    let name_width =
                                        (ui.available_width() - album_width - 123.0).max(80.0);
                                    ui.allocate_ui_with_layout(
                                        vec2(name_width, 42.0),
                                        Layout::top_down(Align::Min),
                                        |ui| {
                                            ui.add(
                                                egui::Label::new(
                                                    RichText::new(&track.title)
                                                        .font(theme::medium(14.0))
                                                        .color(palette.text),
                                                )
                                                .truncate(),
                                            )
                                            .on_hover_text(&track.title);
                                            ui.add(
                                                egui::Label::new(
                                                    RichText::new(track.artists.join(", "))
                                                        .font(theme::regular(12.0))
                                                        .color(palette.secondary),
                                                )
                                                .truncate(),
                                            );
                                        },
                                    );
                                    if album_width > 0.0 {
                                        ui.add_sized(
                                            vec2(album_width, 20.0),
                                            egui::Label::new(
                                                RichText::new(&track.album)
                                                    .color(palette.secondary)
                                                    .size(12.0),
                                            )
                                            .truncate(),
                                        )
                                        .on_hover_text(&track.album);
                                    }
                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        if ui
                                            .small_button("Sources")
                                            .on_hover_text(
                                                "Check provider catalog matches for this track",
                                            )
                                            .clicked()
                                        {
                                            actions.push(DownloadAction::CheckAvailability(
                                                track.id.clone(),
                                            ));
                                        }
                                        theme::subtle(ui, palette, &duration(track.duration_ms));
                                    });
                                },
                            );
                        });
                    }
                });
        });
    ui.add_space(12.0);
    ui.horizontal_wrapped(|ui| {
        ui.add_enabled_ui(
            state.history_ready && !state.tools.busy && !state.selected.is_empty(),
            |ui| {
                if theme::soft_button(ui, palette, None, "Save covers only", false).clicked() {
                    actions.push(DownloadAction::ExportAssets(
                        crate::download_tasks::assets::AssetKind::Covers,
                    ));
                }
                if theme::soft_button(ui, palette, None, "Save lyrics only", false).clicked() {
                    actions.push(DownloadAction::ExportAssets(
                        crate::download_tasks::assets::AssetKind::Lyrics,
                    ));
                }
            },
        );
        if !collection.images.is_empty()
            && ui
                .add_enabled(
                    state.history_ready && !state.tools.busy,
                    egui::Button::new("Save artwork"),
                )
                .clicked()
        {
            actions.push(DownloadAction::ExportAssets(
                crate::download_tasks::assets::AssetKind::Artwork,
            ));
        }
    });
    theme::subtle(
        ui,
        palette,
        "Artwork and lyrics save to your download folder without downloading audio.",
    );
    availability_panel(ui, palette, state);
}

fn export_options(
    ui: &mut egui::Ui,
    palette: &Palette,
    locale: Locale,
    options: &mut ExportOptions,
    actions: &mut Vec<DownloadAction>,
) {
    theme::text(ui, "Save settings", theme::semibold(16.0), palette.text);
    ui.add_space(8.0);
    ui.vertical(|ui| {
        labeled_combo(
            ui,
            "Source",
            "download-source",
            &mut options.source,
            &[
                (DownloadSource::Auto, "Auto"),
                (DownloadSource::Tidal, "Tidal"),
                (DownloadSource::Qobuz, "Qobuz"),
                (DownloadSource::Amazon, "Amazon Music"),
                (DownloadSource::Deezer, "Deezer"),
                (DownloadSource::Apple, "Apple Music"),
                (DownloadSource::YouTube, "YouTube"),
            ],
        );
        ui.add_enabled_ui(options.source != DownloadSource::YouTube, |ui| {
            labeled_combo(
                ui,
                "Quality",
                "download-quality",
                &mut options.quality,
                &[
                    (DownloadQuality::Cd, "CD quality"),
                    (DownloadQuality::HiRes48, "Hi-Res 48 kHz"),
                    (DownloadQuality::Max, "Highest available"),
                    (DownloadQuality::Atmos, "Dolby Atmos"),
                ],
            );
        });
        labeled_combo(
            ui,
            "Save to",
            "download-destination",
            &mut options.destination,
            &[
                (Destination::Mac, "This Mac"),
                (Destination::Library, "Music library"),
                (Destination::Both, "Mac + library"),
            ],
        );
    });
    ui.add_space(8.0);
    if options.source == DownloadSource::Auto {
        theme::subtle(ui, palette, "Try lossless sources first.");
    }
    if options.source != DownloadSource::YouTube {
        ui.checkbox(&mut options.allow_youtube_fallback, "YouTube fallback")
            .on_hover_text(
                "YouTube audio is lossy. The history shows the actual source and measured quality.",
            );
    } else {
        ui.add(
            egui::Label::new(
                RichText::new(
                    "YouTube audio is lossy. Saving it as FLAC does not increase its quality.",
                )
                .size(13.0)
                .color(palette.secondary),
            )
            .wrap(),
        );
    }

    let local = options.destination != Destination::Library;
    if options.quality == DownloadQuality::Atmos {
        options.format = OutputFormat::Original;
        options.sample_rate = None;
        options.bit_depth = None;
    }
    ui.add_space(12.0);
    if local {
        theme::subtle(ui, palette, "Download folder");
        ui.horizontal(|ui| {
            let path = options.output_dir.to_string_lossy();
            let folder = options
                .output_dir
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(path.as_ref());
            let width = (ui.available_width() - 78.0).max(70.0);
            ui.add_sized(
                vec2(width, 28.0),
                egui::Label::new(RichText::new(folder).color(palette.text).size(13.0)).truncate(),
            )
            .on_hover_text(path.as_ref());
            if theme::soft_button(ui, palette, None, "Choose…", false).clicked() {
                actions.push(DownloadAction::ChooseFolder);
            }
        });
    } else {
        ui.add(
            egui::Label::new(
                RichText::new(
                    "Available across your music apps. Local export settings do not apply.",
                )
                .size(13.0)
                .color(palette.secondary),
            )
            .wrap(),
        );
    }
    ui.add_space(8.0);
    egui::CollapsingHeader::new("Sources & link resolver")
        .id_salt("download-providers")
        .show(ui, |ui| {
            let providers = &mut options.providers;
            labeled_combo(
                ui,
                "Resolve track links with",
                "download-resolver",
                &mut providers.resolver,
                &[
                    (LinkResolver::Auto, "Automatic"),
                    (LinkResolver::SongLink, "Songlink"),
                    (LinkResolver::Songstats, "Songstats"),
                ],
            );
            ui.checkbox(
                &mut providers.resolver_fallback,
                "Try the other resolver if needed",
            );
            ui.checkbox(
                &mut providers.provider_fallback,
                "Try another provider if needed",
            );
            if options.quality == DownloadQuality::Atmos {
                ui.checkbox(
                    &mut providers.atmos_fallback,
                    "Use stereo if Atmos is unavailable",
                );
                egui::ComboBox::from_id_salt("download-atmos-fallback")
                    .selected_text(if providers.atmos_fallback_quality == "cd" {
                        "CD quality fallback"
                    } else {
                        "Highest quality fallback"
                    })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(
                            &mut providers.atmos_fallback_quality,
                            "cd".into(),
                            "CD quality",
                        );
                        ui.selectable_value(
                            &mut providers.atmos_fallback_quality,
                            "max".into(),
                            "Highest available",
                        );
                    });
            }
            ui.add_space(8.0);
            theme::subtle(ui, palette, "Provider order");
            let mut movement = None;
            for index in 0..providers.provider_order.len() {
                ui.push_id(index, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(format!(
                            "{}. {}",
                            index + 1,
                            providers.provider_order[index]
                        ));
                        if ui
                            .add_enabled(index > 0, egui::Button::new("↑"))
                            .on_hover_text("Move provider up")
                            .clicked()
                        {
                            movement = Some((index, index - 1));
                        }
                        if ui
                            .add_enabled(
                                index + 1 < providers.provider_order.len(),
                                egui::Button::new("↓"),
                            )
                            .on_hover_text("Move provider down")
                            .clicked()
                        {
                            movement = Some((index, index + 1));
                        }
                    })
                });
            }
            if let Some((from, to)) = movement {
                providers.provider_order.swap(from, to);
            }
            ui.add_space(8.0);
            for (label, value) in [
                ("Custom Tidal instance", &mut providers.custom_tidal_url),
                ("Custom Qobuz instance", &mut providers.custom_qobuz_url),
            ] {
                theme::subtle(ui, palette, label);
                ui.add(
                    egui::TextEdit::singleline(value)
                        .hint_text("https://…")
                        .desired_width(f32::INFINITY),
                );
            }
            theme::subtle(ui, palette, "Leave blank to use the built-in providers.");
            if let Err(error) = providers.validate() {
                notice(ui, palette, &error, true);
            }
        });
    ui.add_enabled_ui(local, |ui| {
        egui::CollapsingHeader::new("Format & metadata").id_salt("download-advanced").show(ui, |ui| {
            ui.add_space(6.0);
            ui.add_enabled_ui(options.quality != DownloadQuality::Atmos, |ui| ui.horizontal_wrapped(|ui| {
                let formats: Vec<_> = OutputFormat::ALL.iter().map(|&format| (format, format.label())).collect();
                labeled_combo(ui, "File format", "download-format", &mut options.format, &formats);
                labeled_combo(ui, "Sample rate", "download-sample-rate", &mut options.sample_rate, &[
                    (None, "Keep original"), (Some(44_100), "44.1 kHz"), (Some(48_000), "48 kHz"), (Some(96_000), "96 kHz"), (Some(192_000), "192 kHz"),
                ]);
                labeled_combo(ui, "Bit depth", "download-bit-depth", &mut options.bit_depth, &[
                    (None,"Keep original"),(Some(16),"16-bit"),(Some(24),"24-bit"),
                ]);
                if matches!(options.format, OutputFormat::Mp3 | OutputFormat::Opus | OutputFormat::Aac) {
                    labeled_combo(ui, "Bitrate", "download-bitrate", &mut options.bitrate_kbps, &[
                        (128, "128 kbps"), (192, "192 kbps"), (256, "256 kbps"), (320, "320 kbps"),
                    ]);
                }
            }));
            if options.quality == DownloadQuality::Atmos { theme::subtle(ui,palette,"Atmos keeps the original M4A audio and spatial information."); }
            ui.add_space(8.0);
            ui.add(egui::Label::new(RichText::new("Original keeps the source codec. Converting to a lossless format cannot restore lost audio detail.").size(13.0).color(palette.secondary)).wrap());
            ui.checkbox(&mut options.replay_gain, "Write ReplayGain loudness tags")
                .on_hover_text("Stores playback gain metadata without changing the music's volume.");
            if options.replay_gain {
                labeled_combo(ui,"Loudness grouping","download-replay-gain-mode",&mut options.replay_gain_mode,&[
                    (ReplayGainMode::Track,"Each track"),(ReplayGainMode::Album,"Tracks and album"),
                ]);
            }
            if options.format != OutputFormat::Original || options.sample_rate.is_some() || options.bit_depth.is_some() {
                ui.checkbox(&mut options.keep_original,"Keep a copy of the original audio");
            }
            ui.add_space(8.0);
            ui.horizontal_wrapped(|ui| {
                ui.checkbox(&mut options.embed_tags, "Track metadata");
                ui.checkbox(&mut options.embed_artwork, "Embed artwork");
                ui.checkbox(&mut options.max_artwork, "Largest available artwork").on_hover_text("Requests the known high-resolution CDN image, with the original image as fallback.");
                ui.checkbox(&mut options.embed_lyrics, "Embed lyrics");
            });
            egui::CollapsingHeader::new("Choose metadata tags").id_salt("download-tags").show(ui, |ui| {
                ui.horizontal(|ui| {
                    if ui.button("Select all").clicked() { options.metadata_tags = MetadataTags::all(true); }
                    if ui.button("Clear selection").clicked() { options.metadata_tags = MetadataTags::all(false); }
                });
                ui.add_enabled_ui(options.embed_tags, |ui| {
                    for (label,value) in options.metadata_tags.fields() { ui.checkbox(value,label); }
                });
                ui.checkbox(&mut options.first_artist_only, "Use first artist only");
                ui.checkbox(&mut options.single_genre, "Use first genre only");
                ui.checkbox(&mut options.year_only, "Write year without month and day");
                labeled_combo(ui,"Artist separator","download-artist-separator",&mut options.artist_separator,&[
                    (ArtistSeparator::Comma,"Comma"),(ArtistSeparator::Semicolon,"Semicolon"),
                ]);
            });
            ui.horizontal_wrapped(|ui| {
                ui.checkbox(&mut options.cover_sidecar, "Cover file");
                ui.checkbox(&mut options.lyrics_sidecar, "Lyrics file");
                ui.checkbox(&mut options.create_playlist, "M3U8 playlist");
            });
            ui.add_space(10.0);
            fn preset(ui:&mut egui::Ui,label:&str,value:&mut String,choices:&[(&str,&str)]) {
                egui::ComboBox::from_id_salt(label).selected_text(choices.iter().find(|(_,template)|*template==value).map(|(label,_)|*label).unwrap_or("Custom"))
                    .show_ui(ui,|ui| { for (label,template) in choices { if ui.selectable_label(value==template,*label).clicked() { *value=(*template).into(); } } });
            }
            theme::subtle(ui,palette,"Folder layout");
            preset(ui,"download-folder-preset",&mut options.folder_template,&[
                ("No subfolders",""),("Artist","{artist}"),("Album","{album}"),("Artist / Album","{artist}/{album}"),
                ("Year / Artist / Album","{year}/{artist}/{album}"),("Artist / [Year] Album","{artist}/[{year}] {album}"),
                ("Album artist / Album","{album_artist}/{album}"),("Album artist / [Year] Album","{album_artist}/[{year}] {album}"),
            ]);
            template_field(ui, locale, "Folders", &mut options.folder_template);
            ui.checkbox(&mut options.apply_folder_to_single_track,"Apply folders to individual tracks");
            ui.checkbox(&mut options.create_playlist_folder,"Put each playlist in its own folder");
            if options.create_playlist_folder { ui.checkbox(&mut options.playlist_owner_folder,"Include playlist owner folder"); }
            theme::subtle(ui,palette,"Filename layout");
            preset(ui,"download-filename-preset",&mut options.filename_template,&[
                ("Title","{title}"),("Artist – Title","{artist} - {title}"),("Title – Artist","{title} - {artist}"),
                ("Track. Title","{track}. {title}"),("Track. Artist – Title","{track}. {artist} - {title}"),
                ("Disc–Track. Title","{disc}-{track}. {title}"),("Artist – Album – Title","{artist} - {album} - {title}"),
            ]);
            template_field(ui, locale, "Filename", &mut options.filename_template);
            ui.checkbox(&mut options.separate_album_filename,"Use a different filename for albums");
            if options.separate_album_filename { template_field(ui,locale,"Album filename",&mut options.album_filename_template); }
            ui.add(egui::Label::new(RichText::new("Use {artist}, {artists}, {album}, {title}, {track}, {total_tracks}, {disc}, {total_discs}, {year}, {date}, {album_artist}, {isrc}, {upc}, {playlist}, {creator}, {category}, or {id}.").size(12.0).color(palette.secondary)).wrap());
            ui.add(egui::Label::new(RichText::new("{year} uses four digits; {date} keeps the full release date.").size(12.0).color(palette.secondary)).wrap());
            ui.add_space(8.0);
            labeled_combo(ui, "Existing files", "download-duplicates", &mut options.duplicates, &[
                (DuplicatePolicy::Skip, "Keep existing file"), (DuplicatePolicy::Rename, "Save another copy"),
            ]);
            if options.duplicates == DuplicatePolicy::Skip {
                labeled_combo(ui,"Match existing recordings by","download-duplicate-match",&mut options.existing_file_check,&[
                    (ExistingFileCheck::Hybrid,"ISRC or filename"),(ExistingFileCheck::Isrc,"ISRC recording code"),(ExistingFileCheck::Filename,"Filename"),
                ]);
            }
            ui.checkbox(&mut options.export_log,"Save download reports");
            if options.export_log { ui.checkbox(&mut options.log_failures_only,"Report failed downloads only"); }
        });
    });
    egui::CollapsingHeader::new("Lyrics & translation")
        .id_salt("download-lyrics-preferences")
        .show(ui, |ui| lyrics_settings(ui, palette, &mut options.lyrics));
}

fn jobs(
    ui: &mut egui::Ui,
    palette: &Palette,
    locale: Locale,
    state: &mut DownloadViewState,
    queue: &QueueState,
    actions: &mut Vec<DownloadAction>,
) {
    let history = state.tab == DownloadTab::History;
    ui.horizontal(|ui| {
        widgets::search_field(
            ui,
            palette,
            locale,
            ui.id().with("download-queue-filter"),
            &mut state.queue_filter,
            "Filter downloads",
            ui.available_width().min(300.0),
        );
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if history {
                if queue
                    .jobs
                    .iter()
                    .any(|job| job.stage == JobStage::Completed)
                    && theme::soft_button(ui, palette, None, "Clear completed", false)
                        .on_hover_text(
                            "Remove completed entries from history. Your files stay on your Mac.",
                        )
                        .clicked()
                {
                    actions.push(DownloadAction::ClearFinished);
                }
                if queue
                    .jobs
                    .iter()
                    .any(|job| matches!(job.stage, JobStage::Failed | JobStage::Interrupted))
                    && theme::soft_button(ui, palette, Some(Icon::Refresh), "Retry failed", false)
                        .clicked()
                {
                    actions.push(DownloadAction::RetryFailed);
                }
            } else if queue
                .jobs
                .iter()
                .any(|job| job.stage == JobStage::Queued || job.stage.active())
            {
                if theme::soft_button(
                    ui,
                    palette,
                    Some(if queue.paused {
                        Icon::Play
                    } else {
                        Icon::Pause
                    }),
                    if queue.paused {
                        "Resume queue"
                    } else {
                        "Pause queue"
                    },
                    false,
                )
                .clicked()
                {
                    actions.push(if queue.paused {
                        DownloadAction::ResumeQueue
                    } else {
                        DownloadAction::PauseQueue
                    });
                }
            }
        });
    });
    ui.add_space(16.0);
    let needle = state.queue_filter.trim().to_lowercase();
    let visible: Vec<_> = if history {
        queue
            .jobs
            .iter()
            .rev()
            .filter(|job| job.stage != JobStage::Queued && !job.stage.active())
            .filter(|job| matches_track(&job.track, &needle))
            .collect()
    } else {
        // Keep current transfers in view before the remaining FIFO queue.
        queue
            .jobs
            .iter()
            .filter(|job| job.stage.active())
            .chain(
                queue
                    .jobs
                    .iter()
                    .filter(|job| job.stage == JobStage::Queued),
            )
            .filter(|job| matches_track(&job.track, &needle))
            .collect()
    };
    if visible.is_empty() {
        let (title, detail) = if !needle.is_empty() {
            (
                "No matching downloads",
                "Try a different track or artist name.",
            )
        } else if history {
            (
                "Your downloads will appear here",
                "See actual audio quality, reveal files, or retry an unfinished download.",
            )
        } else {
            (
                "Your queue is clear",
                "Find music and select the tracks you want to keep. Playback can continue while they download.",
            )
        };
        widgets::empty_state(
            ui,
            palette,
            if history { Icon::Clock } else { Icon::ListEnd },
            title,
            detail,
        );
        return;
    }
    let painter = ui.painter().clone();
    let wide = ui.available_width() >= 800.0;
    let mut table = egui_extras::TableBuilder::new(ui)
        .id_salt(("download-jobs", history))
        .striped(false)
        .resizable(false)
        .cell_layout(Layout::left_to_right(Align::Center))
        .column(egui_extras::Column::remainder().at_least(220.0));
    if wide {
        table = table
            .column(egui_extras::Column::exact(96.0))
            .column(egui_extras::Column::exact(182.0));
    }
    table
        .column(egui_extras::Column::exact(158.0))
        .column(egui_extras::Column::exact(96.0))
        .header(30.0, |mut row| {
            row.col(|ui| {
                theme::subtle(ui, palette, "Track");
            });
            if wide {
                row.col(|ui| {
                    theme::subtle(ui, palette, "Source");
                });
                row.col(|ui| {
                    theme::subtle(ui, palette, "Audio quality");
                });
            }
            row.col(|ui| {
                theme::subtle(ui, palette, "Status");
            });
            row.col(|_| {});
        })
        .body(|body| {
            body.rows(68.0, visible.len(), |mut row| {
                let job = visible[row.index()];
                let file = job.receipt.as_ref().and_then(|r| r.file.as_ref());
                row.col(|ui| {
                    widgets::cover(
                        ui,
                        palette,
                        nonempty(&job.track.cover_url),
                        44.0,
                        4.0,
                        Icon::Music,
                    );
                    ui.add_space(4.0);
                    ui.allocate_ui_with_layout(
                        vec2(ui.available_width(), 40.0),
                        Layout::top_down(Align::Min),
                        |ui| {
                            ui.add(
                                egui::Label::new(
                                    RichText::new(&job.track.title)
                                        .font(theme::medium(14.0))
                                        .color(palette.text),
                                )
                                .truncate(),
                            )
                            .on_hover_text(&job.track.title);
                            ui.add(
                                egui::Label::new(
                                    RichText::new(job.track.artists.join(", "))
                                        .size(12.5)
                                        .color(palette.secondary),
                                )
                                .truncate(),
                            );
                        },
                    );
                });
                if wide {
                    row.col(|ui| {
                        theme::subtle(
                            ui,
                            palette,
                            file.and_then(|f| f.source.as_deref()).unwrap_or(
                                if job.stage == JobStage::Completed {
                                    "—"
                                } else {
                                    job.options.source.label()
                                },
                            ),
                        );
                    });
                    row.col(|ui| {
                        let label = file.map(|f| f.quality.label()).unwrap_or_else(|| {
                            if job.stage == JobStage::Completed {
                                "—".into()
                            } else {
                                job.options.quality.label().into()
                            }
                        });
                        ui.add(
                            egui::Label::new(
                                RichText::new(label).size(12.5).color(palette.secondary),
                            )
                            .truncate(),
                        )
                        .on_hover_text(job_detail(job));
                    });
                }
                row.col(|ui| {
                    ui.allocate_ui_with_layout(
                        vec2(ui.available_width(), 40.0),
                        Layout::top_down(Align::Min),
                        |ui| {
                            let color = match job.stage {
                                JobStage::Completed => palette.accent,
                                JobStage::Failed | JobStage::Interrupted => palette.warning,
                                _ => palette.secondary,
                            };
                            ui.add(
                                egui::Label::new(
                                    RichText::new(
                                        job_status(job).split(" · ").next().unwrap_or_default(),
                                    )
                                    .font(theme::medium(12.5))
                                    .color(color),
                                )
                                .truncate(),
                            )
                            .on_hover_text(job_detail(job));
                            if job.stage == JobStage::Downloading {
                                if let Some(fraction) = job.progress.fraction() {
                                    ui.add(
                                        egui::ProgressBar::new(fraction)
                                            .desired_height(3.0)
                                            .fill(palette.accent),
                                    );
                                }
                                theme::text(
                                    ui,
                                    &transfer_label(job),
                                    theme::regular(11.0),
                                    palette.secondary,
                                );
                            } else if let Some(receipt) = &job.receipt {
                                let target = match (
                                    receipt.file.is_some(),
                                    receipt.library_song_id.is_some(),
                                ) {
                                    (true, true) => "Mac + library",
                                    (true, false) => "On this Mac",
                                    (false, true) => "In your library",
                                    _ => "",
                                };
                                theme::text(ui, target, theme::regular(11.5), palette.secondary);
                            }
                        },
                    );
                });
                row.col(|ui| {
                    ui.push_id(job.id, |ui| {
                        job_actions(ui, palette, job, actions);
                    });
                });
                let rect = row.response().rect;
                painter.hline(
                    rect.x_range(),
                    rect.bottom(),
                    Stroke::new(0.5, palette.outline.gamma_multiply(0.5)),
                );
            });
        });
}

fn job_actions(
    ui: &mut egui::Ui,
    palette: &Palette,
    job: &DownloadJob,
    actions: &mut Vec<DownloadAction>,
) {
    ui.spacing_mut().item_spacing.x = 6.0;
    let button = |ui: &mut egui::Ui, icon, text| {
        theme::icon_button(ui, icon, 16.0, palette.secondary, palette.text, text).clicked()
    };
    if job.stage == JobStage::Queued || job.stage.active() {
        if button(ui, Icon::X, "Cancel download") {
            actions.push(DownloadAction::Cancel(job.id));
        }
    } else {
        if let Some(receipt) = &job.receipt {
            if let Some(file) = &receipt.file {
                if button(ui, Icon::Play, "Open file") {
                    actions.push(DownloadAction::OpenFile(file.path.clone()));
                }
                if button(ui, Icon::Folder, "Reveal in Finder") {
                    actions.push(DownloadAction::Reveal(file.path.clone()));
                }
                if !file.warnings.is_empty() {
                    theme::icon_button(
                        ui,
                        Icon::CircleAlert,
                        15.0,
                        palette.secondary,
                        palette.text,
                        "Download details",
                    )
                    .on_hover_text(job_detail(job));
                }
            } else if let Some(id) = &receipt.library_song_id {
                if button(ui, Icon::Play, "Play in your library") {
                    actions.push(DownloadAction::OpenLibrarySong(id.clone()));
                }
            }
        }
        if job.stage.retryable() && button(ui, Icon::Refresh, "Retry download") {
            actions.push(DownloadAction::Retry(job.id));
        }
    }
}

fn job_status(job: &DownloadJob) -> String {
    let mut status = job.stage.label().to_owned();
    if let Some(receipt) = &job.receipt {
        if job.error.is_some() && receipt.succeeded() {
            status = "Partially saved".into();
        } else if receipt.file.as_ref().is_some_and(|file| file.skipped) {
            status = "Existing file kept".into();
        }
        if receipt.library_song_id.is_some() {
            status.push_str(" · In your library");
        }
    }
    status
}

fn job_detail(job: &DownloadJob) -> String {
    if let Some(error) = &job.error {
        return error.clone();
    }
    if let Some(file) = job
        .receipt
        .as_ref()
        .and_then(|receipt| receipt.file.as_ref())
    {
        let mut detail = file.quality.label();
        if let Some(source) = &file.source {
            detail.push_str(&format!(" · {source}"));
        }
        if !file.source_quality.lossless && file.quality.lossless {
            detail.push_str(" · Lossy source");
        }
        if !file.warnings.is_empty() {
            detail.push_str(&format!(" · {}", file.warnings.join(" · ")));
        }
        return detail;
    }
    match job.stage {
        JobStage::Queued => format!(
            "{} · {}",
            job.options.source.label(),
            job.options.quality.label()
        ),
        JobStage::Resolving => "Looking for the requested audio source…".into(),
        JobStage::Processing => "Checking audio and preparing your files…".into(),
        JobStage::SavingLibrary => "Adding this track to your music library…".into(),
        JobStage::Completed => "Saved to your music library".into(),
        JobStage::Cancelled => "Cancelled. You can retry this track whenever you like.".into(),
        JobStage::Interrupted => "The app closed before this finished. Retry to continue.".into(),
        _ => String::new(),
    }
}

fn transfer_label(job: &DownloadJob) -> String {
    match job.progress.total {
        Some(total) => format!("{} of {}", bytes(job.progress.received), bytes(total)),
        None => format!("{} received", bytes(job.progress.received)),
    }
}

fn bytes(value: u64) -> String {
    if value >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", value as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if value >= 1024 * 1024 {
        format!("{:.1} MB", value as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", value / 1024)
    }
}

fn duration(ms: u64) -> String {
    crate::util::format_duration_ms(ms.min(u32::MAX as u64) as u32)
}
fn track_count(count: usize) -> String {
    format!("{count} {}", if count == 1 { "track" } else { "tracks" })
}
fn nonempty(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}
fn matches_track(track: &DownloadTrack, needle: &str) -> bool {
    needle.is_empty()
        || track.title.to_lowercase().contains(needle)
        || track.album.to_lowercase().contains(needle)
        || track
            .artists
            .iter()
            .any(|artist| artist.to_lowercase().contains(needle))
}

fn labeled_combo<T: Copy + PartialEq>(
    ui: &mut egui::Ui,
    label: &str,
    id: &str,
    selected: &mut T,
    choices: &[(T, &str)],
) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(label).size(12.0).weak());
        let current = choices
            .iter()
            .find(|(choice, _)| *choice == *selected)
            .map(|(_, label)| *label)
            .unwrap_or("Custom");
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            egui::ComboBox::from_id_salt(id)
                .selected_text(current)
                .width(165.0)
                .show_ui(ui, |ui| {
                    for &(choice, label) in choices {
                        ui.selectable_value(selected, choice, label);
                    }
                })
                .response
                .widget_info(|| {
                    egui::WidgetInfo::labeled(egui::WidgetType::ComboBox, ui.is_enabled(), label)
                });
        });
    });
}

fn template_field(ui: &mut egui::Ui, locale: Locale, label: &str, value: &mut String) {
    ui.horizontal(|ui| {
        ui.add_sized(
            vec2(60.0, 28.0),
            egui::Label::new(RichText::new(label).size(13.0)),
        );
        widgets::text_edit(
            ui,
            locale,
            egui::TextEdit::singleline(value)
                .desired_width(ui.available_width())
                .font(theme::regular(13.0)),
        );
    });
}

fn notice(ui: &mut egui::Ui, palette: &Palette, message: &str, error: bool) {
    Frame::new()
        .fill(palette.panel)
        .stroke(Stroke::new(1.0, palette.outline))
        .corner_radius(CornerRadius::same(8))
        .inner_margin(Margin::same(12))
        .show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                theme::icon(
                    ui,
                    if error { Icon::CircleAlert } else { Icon::Info },
                    18.0,
                    if error {
                        palette.warning
                    } else {
                        palette.secondary
                    },
                );
                ui.label(RichText::new(message).size(13.0).color(palette.text));
            });
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collection(ids: &[&str]) -> Arc<DownloadCollection> {
        Arc::new(DownloadCollection {
            tracks: ids
                .iter()
                .map(|id| DownloadTrack {
                    id: (*id).into(),
                    title: (*id).into(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        })
    }

    #[test]
    fn new_results_replace_selection_and_filter_without_carrying_old_tracks() {
        let mut state = DownloadViewState::default();
        state.set_collection(collection(&["first", "second"]));
        state.filter = "first".into();
        assert_eq!(
            state
                .filtered_tracks(state.metadata.get().cloned().unwrap().as_ref())
                .as_ref(),
            &[0]
        );
        state.set_collection(collection(&["third"]));
        assert!(state.filter.is_empty());
        assert_eq!(
            state
                .selected_tracks()
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            ["third"]
        );
        assert_eq!(
            state
                .filtered_tracks(state.metadata.get().cloned().unwrap().as_ref())
                .as_ref(),
            &[0]
        );
    }

    #[test]
    fn selected_tracks_keep_release_order_even_when_filter_hides_them() {
        let mut state = DownloadViewState::default();
        state.set_collection(collection(&["second", "first", "third"]));
        state.selected.remove("first");
        state.filter = "third".into();
        assert_eq!(
            state
                .filtered_tracks(state.metadata.get().cloned().unwrap().as_ref())
                .as_ref(),
            &[2]
        );
        assert_eq!(
            state
                .selected_tracks()
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            ["second", "third"]
        );
    }
}
