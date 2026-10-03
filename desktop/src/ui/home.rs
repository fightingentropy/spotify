//! The Home page.

use std::sync::Arc;

use crate::api::models::{PlayableItem, Playlist, pick_image};
use crate::app::App;
use crate::i18n::gettext;
use crate::model::{Action, DISCOVER_TERMS, Loadable, Page, RowContext};
use crate::theme;

use super::widgets::{self, TrackRow};

pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let palette = app.palette;
    let greeting = crate::util::greeting(app.locale);
    theme::text(ui, greeting.as_ref(), theme::semibold(24.0), palette.text);
    ui.add_space(12.0);

    // Familiar music is the first thing in reach. Library destinations already
    // have persistent homes in the sidebar, so this page needs no shortcut grid.
    recently_played(app, ui);
    if app.settings.home.made_for_you.visible {
        made_for_you(app, ui);
    }
    top_tracks(app, ui);
}

fn made_for_you(app: &mut App, ui: &mut egui::Ui) {
    let palette = app.palette;
    let mut playlists: Vec<Playlist> = Vec::new();
    let mut loading = false;
    let mut failed = false;
    for term in DISCOVER_TERMS {
        match app.home.discover.get(*term) {
            Some(Loadable::Loaded(list)) => {
                for playlist in list {
                    let duplicate = playlists.iter().any(|existing| {
                        existing.id == playlist.id
                            || existing.name.eq_ignore_ascii_case(&playlist.name)
                    });
                    if !duplicate {
                        playlists.push(playlist.clone());
                    }
                }
            }
            Some(Loadable::Loading) => loading = true,
            Some(Loadable::Failed(_)) => failed = true,
            _ => {}
        }
    }
    if playlists.is_empty() && !loading && !failed {
        return;
    }
    widgets::shelf(
        ui,
        &palette,
        "made-for-you",
        &gettext(app.locale, "Made for you"),
        |ui| {
            if playlists.is_empty() && loading {
                for _ in 0..4 {
                    widgets::skeleton_card(ui, &palette);
                }
            } else if playlists.is_empty() && failed {
                let message = gettext(app.locale, "Couldn't load this shelf");
                widgets::error_row(ui, app, &message, Some(Page::Home));
            }
            for playlist in &playlists {
                let subtitle = playlist
                    .description
                    .as_deref()
                    .map(crate::util::strip_html)
                    .filter(|d| !d.is_empty())
                    .unwrap_or_else(|| {
                        // Translators: {owner} is the name of the playlist's owner.
                        gettext(app.locale, "By {owner}").replace("{owner}", playlist.owner_name())
                    });
                let card = widgets::card_for_uri(
                    ui,
                    app,
                    pick_image(&playlist.images, 640),
                    &playlist.name,
                    &subtitle,
                    false,
                    true,
                    &playlist.uri,
                );
                if card.play {
                    app.actions.push(Action::PlayContext {
                        uri: playlist.uri.clone(),
                        offset_uri: None,
                        offset_index: None,
                    });
                }
                if card.clicked {
                    app.actions
                        .push(Action::Open(Page::Playlist(playlist.id.clone())));
                }
                egui::Popup::context_menu(&card.response)
                    .id(ui.make_persistent_id(("home-made_for_you-menu", &playlist.uri)))
                    .frame(widgets::menu_frame(&palette))
                    .show(|ui| {
                        let owned = app.user_id().is_some_and(|id| playlist.owned_by(id));
                        widgets::context_menu_items(
                            ui,
                            app,
                            &playlist.uri,
                            &playlist.name,
                            owned.then_some(playlist),
                        );
                    });
            }
        },
    );
}

fn recently_played(app: &mut App, ui: &mut egui::Ui) {
    let palette = app.palette;
    let history = match app.home.recently_played.clone() {
        Loadable::Loaded(history) => history,
        Loadable::Loading | Loadable::NotLoaded => {
            widgets::shelf(
                ui,
                &palette,
                "recent",
                &gettext(app.locale, "Recently played"),
                |ui| {
                    for _ in 0..4 {
                        widgets::skeleton_card(ui, &palette);
                    }
                },
            );
            return;
        }
        Loadable::Failed(message) => {
            widgets::shelf(
                ui,
                &palette,
                "recent",
                &gettext(app.locale, "Recently played"),
                |ui| {
                    widgets::error_row(ui, app, &message, Some(Page::Home));
                },
            );
            return;
        }
    };
    let mut seen = std::collections::HashSet::new();
    let tracks: Vec<_> = history
        .into_iter()
        .filter(|entry| {
            entry
                .track
                .id
                .as_ref()
                .is_some_and(|id| seen.insert(id.clone()))
        })
        .take(16)
        .collect();
    if tracks.is_empty() {
        return;
    }
    widgets::shelf(
        ui,
        &palette,
        "recent",
        &gettext(app.locale, "Recently played"),
        |ui| {
            for entry in &tracks {
                let track = &entry.track;
                let card = widgets::card_for_uri(
                    ui,
                    app,
                    track.image(640),
                    &track.name,
                    &track.artist_names(),
                    false,
                    true,
                    &track.uri,
                );
                let album_id = track
                    .album
                    .as_ref()
                    .map(|album| album.id.as_str())
                    .filter(|id| !id.is_empty());
                if card.play || (card.clicked && album_id.is_none()) {
                    app.actions.push(Action::PlayUris {
                        uris: vec![track.uri.clone()],
                        index: 0,
                    });
                } else if card.clicked
                    && let Some(id) = album_id
                {
                    app.actions.push(Action::Open(Page::Album(id.to_owned())));
                }
                egui::Popup::context_menu(&card.response)
                    .id(ui.make_persistent_id(("home-recently_played-menu", &track.uri)))
                    .frame(widgets::menu_frame(&palette))
                    .show(|ui| {
                        widgets::item_menu(
                            ui,
                            app,
                            &PlayableItem::Track(track.clone()),
                            None,
                            None,
                        );
                    });
            }
        },
    );
}

fn track_list(
    app: &mut App,
    ui: &mut egui::Ui,
    title: &str,
    tracks: Loadable<Vec<crate::api::models::Track>>,
    limit: usize,
    title_page: Option<Page>,
    more_label: Option<&str>,
) {
    let palette = app.palette;
    let tracks = match tracks {
        Loadable::Loaded(tracks) => tracks,
        Loadable::Loading | Loadable::NotLoaded => {
            if let Some(page) = title_page {
                if theme::link(ui, title, theme::bold(17.0), palette.text).clicked() {
                    app.actions.push(Action::Open(page));
                }
            } else {
                theme::section_title(ui, &palette, title);
            }
            widgets::loading_row(ui, &palette, app.locale);
            ui.add_space(12.0);
            return;
        }
        Loadable::Failed(message) => {
            theme::section_title(ui, &palette, title);
            widgets::error_row(ui, app, &message, Some(title_page.unwrap_or(Page::Home)));
            ui.add_space(12.0);
            return;
        }
    };
    if tracks.is_empty() {
        return;
    }
    if let Some(page) = title_page {
        if theme::link(ui, title, theme::bold(17.0), palette.text).clicked() {
            app.actions.push(Action::Open(page));
        }
    } else {
        theme::section_title(ui, &palette, title);
    }
    ui.add_space(4.0);
    let uris: Arc<[String]> = tracks
        .iter()
        .map(|track| track.uri.clone())
        .collect::<Vec<_>>()
        .into();
    let context = RowContext::Uris(Arc::clone(&uris));
    for (index, track) in tracks.iter().take(limit).enumerate() {
        let item = PlayableItem::Track(track.clone());
        widgets::track_row(
            ui,
            app,
            TrackRow {
                index,
                number: None,
                item: &item,
                context: &context,
                show_cover: !app.settings.tracklist_compact,
                show_album: true,
                added_at: None,
                added_by: None,
                show_added_by: false,
                compact: false,
                thin: app.settings.tracklist_compact,
                shift: 0.0,
                picked: false,
                picked_songs: &[],
            },
        );
    }
    if let Some(label) = more_label
        && tracks.len() > limit
        && theme::link(ui, label, theme::semibold(14.0), palette.secondary).clicked()
    {
        app.actions.push(Action::Open(Page::TopSongs));
    }
    ui.add_space(16.0);
}

fn top_tracks(app: &mut App, ui: &mut egui::Ui) {
    let tracks = app.home.top_tracks.clone();
    let title = gettext(app.locale, "Your top songs");
    let more = gettext(app.locale, "Show more top songs");
    track_list(
        app,
        ui,
        &title,
        tracks,
        10,
        Some(Page::TopSongs),
        Some(&more),
    );
}
