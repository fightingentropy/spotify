//! Curated live stations, sharing the normal native transport and queue.
use super::widgets;
use crate::{
    api::models::{PlayableItem, pick_image},
    app::App,
    model::{Action, Loadable, Page},
    theme::{self, Icon},
};
use egui::{Align, Layout, RichText, vec2};

pub fn radio(app: &mut App, ui: &mut egui::Ui) {
    ui.vertical(|ui| {
        ui.set_max_width(1180.0);
        radio_content(app, ui);
    });
}

fn radio_content(app: &mut App, ui: &mut egui::Ui) {
    let id = "streamarena-radio";
    if !app.playlist_pages.contains_key(id) {
        app.ensure_loaded(Page::Playlist(id.into()));
    }
    let Some(page) = app.playlist_pages.remove(id) else {
        return;
    };
    let palette = app.palette;
    ui.set_max_width(1180.0);
    ui.add_space(8.0);
    theme::text(
        ui,
        "Radio",
        theme::semibold(theme::PAGE_TITLE_SIZE),
        palette.text,
    );
    theme::subtle(ui, &palette, "Live stations, always on.");
    ui.add_space(28.0);
    if let Loadable::Failed(error) = &page.playlist {
        widgets::error_row(ui, app, error, Some(Page::Playlist(id.into())));
    } else if page.items.items.is_empty() && (page.items.loading || !page.items.loaded_once) {
        widgets::skeleton_rows(ui, &palette, 2, 108.0);
    } else {
        for entry in &page.items.items {
            let Some(PlayableItem::Track(track)) = &entry.item else {
                continue;
            };
            ui.push_id(&track.uri, |ui| {
                let current = app.now_playing().is_some_and(|now| now.uri == track.uri);
                let playing = current && app.believed_playing();
                ui.allocate_ui_with_layout(
                    vec2(ui.available_width(), 108.0),
                    Layout::left_to_right(Align::Center),
                    |ui| {
                        widgets::cover(
                            ui,
                            &palette,
                            track
                                .album
                                .as_ref()
                                .and_then(|a| pick_image(&a.images, 128)),
                            76.0,
                            6.0,
                            Icon::Radio,
                        );
                        ui.add_space(12.0);
                        let width = (ui.available_width() - 80.0).max(100.0);
                        ui.allocate_ui_with_layout(
                            vec2(width, 74.0),
                            Layout::top_down(Align::Min),
                            |ui| {
                                ui.add_space(5.0);
                                ui.add(
                                    egui::Label::new(
                                        RichText::new(&track.name)
                                            .font(theme::semibold(19.0))
                                            .color(if current {
                                                palette.accent
                                            } else {
                                                palette.text
                                            }),
                                    )
                                    .truncate(),
                                );
                                theme::subtle(
                                    ui,
                                    &palette,
                                    &track
                                        .artists
                                        .iter()
                                        .map(|a| a.name.as_str())
                                        .collect::<Vec<_>>()
                                        .join(", "),
                                );
                                theme::text(ui, "LIVE", theme::medium(10.5), palette.accent);
                            },
                        );
                        if app.play_pending(&track.uri) {
                            theme::circle_spinner(
                                ui,
                                42.0,
                                palette.surface_active,
                                palette.text,
                                "Tuning in…",
                            );
                        } else if theme::circle_button(
                            ui,
                            if playing {
                                Icon::PauseFilled
                            } else {
                                Icon::PlayFilled
                            },
                            42.0,
                            if playing {
                                palette.accent
                            } else {
                                palette.text
                            },
                            palette.accent_hover,
                            palette.window,
                            &format!("{} {}", if playing { "Pause" } else { "Play" }, track.name),
                        )
                        .clicked()
                        {
                            if current {
                                app.actions.push(Action::TogglePlay);
                            } else {
                                app.actions.push(Action::PlayUris {
                                    uris: vec![track.uri.clone()],
                                    index: 0,
                                });
                            }
                        }
                    },
                );
                ui.separator();
            });
        }
        if let Some(error) = &page.items.error {
            widgets::error_row(ui, app, error, Some(Page::Playlist(id.into())));
        }
    }
    app.playlist_pages.insert(id.into(), page);
}
