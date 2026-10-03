//! A single song details panel shared by artwork, lyrics, and queue controls.

use egui::{Align, Frame, Layout, Margin, Sense, Vec2};

use crate::app::{App, NowPlaying};
use crate::i18n::{gettext, pgettext};
use crate::model::{Action, Loadable, Page};
use crate::theme::{self, Icon};

use super::{lyrics, queue, widgets};

pub(crate) fn side_panel(app: &mut App, ui: &mut egui::Ui) {
    let palette = app.palette;
    let fit = super::yielding_panel(
        ui.ctx(),
        "now-playing-panel",
        theme::SIDE_PANEL_MIN_WIDTH..=560.0,
        app.settings.lyrics_width,
        ui.available_width() - super::topbar::least_width(ui.ctx()),
    );
    let response = egui::Panel::right("now-playing-panel")
        .resizable(true)
        .default_size(app.settings.lyrics_width)
        .size_range(fit.range.clone())
        .show_separator_line(false)
        .frame(
            Frame::new()
                .fill(palette.panel)
                .inner_margin(Margin::symmetric(20, 16)),
        )
        .show(ui, |ui| {
            let controls = super::window_controls_reservation(
                ui.ctx(),
                app.show_queue_panel,
                app.show_lyrics_panel,
                ui.available_width(),
            );
            ui.add_space(controls.queue_top.max(controls.lyrics_top));
            ui.horizontal(|ui| {
                theme::text(
                    ui,
                    gettext(app.locale, "Now Playing"),
                    theme::semibold(16.0),
                    palette.text,
                );
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if theme::icon_button(
                        ui,
                        Icon::X,
                        18.0,
                        palette.secondary,
                        palette.text,
                        &gettext(app.locale, "Close Now Playing (Esc)"),
                    )
                    .clicked()
                    {
                        app.actions.push(if app.show_queue_panel {
                            Action::ToggleQueuePanel
                        } else {
                            Action::ToggleLyricsPanel
                        });
                    }
                });
            });
            ui.add_space(16.0);
            track_details(app, ui);
            ui.add_space(16.0);
            let queue_tab = app.show_queue_panel;
            if let Some(tab) = widgets::chips(
                ui,
                &palette,
                &[
                    (false, &gettext(app.locale, "Lyrics")),
                    (true, &gettext(app.locale, "Queue")),
                ],
                queue_tab,
            ) && tab != queue_tab
            {
                app.actions.push(if tab {
                    Action::ToggleQueuePanel
                } else {
                    Action::ToggleLyricsPanel
                });
            }
            ui.add_space(12.0);
            if queue_tab {
                ui.horizontal(|ui| {
                    if theme::link(
                        ui,
                        gettext(app.locale, "View queue and history"),
                        theme::medium(13.0),
                        palette.secondary,
                    )
                    .clicked()
                    {
                        app.actions.push(Action::Open(Page::Queue));
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if queue::save_button(
                            ui,
                            &palette,
                            !app.queue_playlist_uris().is_empty(),
                            app.locale,
                        ) {
                            app.actions.push(Action::SaveQueueAsPlaylist);
                        }
                    });
                });
                crate::autoscroll::show(
                    ui,
                    egui::ScrollArea::vertical()
                        .id_salt("now-playing-queue-scroll")
                        .auto_shrink([false, false]),
                    egui::Vec2b::new(false, true),
                    |ui| queue::contents(app, ui, true),
                );
            } else {
                ui.horizontal(|ui| {
                    if matches!(&app.lyrics, Loadable::Loaded(Some(_)))
                        && !app.lyrics_following
                        && theme::pill_button(
                            ui,
                            &palette,
                            &pgettext(app.locale, "lyrics", "Follow"),
                            false,
                        )
                        .clicked()
                    {
                        app.actions.push(Action::FollowLyrics);
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if theme::icon_button(
                            ui,
                            Icon::Expand,
                            16.0,
                            palette.secondary,
                            palette.text,
                            &gettext(app.locale, "Expand lyrics"),
                        )
                        .clicked()
                        {
                            app.actions.push(Action::SetLyricsFullscreen(true));
                        }
                    });
                });
                lyrics::contents(app, ui);
            }
        });
    let width = response.response.rect.width();
    if (app.settings.lyrics_width - width).abs() > 1.0
        && super::panel_width_chosen(ui.ctx(), "now-playing-panel", &fit)
    {
        app.settings.lyrics_width = width;
        app.actions.push(Action::SettingsChanged);
    }
}

fn track_details(app: &mut App, ui: &mut egui::Ui) {
    let palette = app.palette;
    let Some(now) = app.now_playing() else {
        widgets::empty_state(
            ui,
            &palette,
            Icon::Music,
            &gettext(app.locale, "Nothing playing"),
            &gettext(app.locale, "Pick a song to see its artwork and details."),
        );
        return;
    };
    // A compact horizontal header reserves at least 140px for words or
    // upcoming songs at the supported minimum window height.
    if app.show_queue_panel || ui.available_height() < 460.0 {
        let side = 88.0;
        let (rect, _) =
            ui.allocate_exact_size(egui::vec2(ui.available_width(), 100.0), Sense::hover());
        let cover = egui::Rect::from_min_size(rect.min, Vec2::splat(side));
        widgets::paint_cover(
            ui,
            &palette,
            now.art_url.as_deref().or(now.art_small.as_deref()),
            cover,
            6.0,
            Icon::Music,
            Some(app.backend.art()),
        );
        let text = egui::Rect::from_min_max(egui::pos2(cover.right() + 12.0, rect.top()), rect.max);
        let mut text_ui = ui.new_child(egui::UiBuilder::new().max_rect(text));
        metadata(app, &mut text_ui, &now, 17.0);
    } else {
        let side = ui
            .available_width()
            .min((ui.available_height() - 335.0).clamp(120.0, 300.0));
        ui.vertical_centered(|ui| {
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(side), Sense::hover());
            widgets::paint_cover(
                ui,
                &palette,
                now.art_url.as_deref().or(now.art_small.as_deref()),
                rect,
                8.0,
                Icon::Music,
                Some(app.backend.art()),
            );
        });
        ui.add_space(14.0);
        metadata(app, ui, &now, 20.0);
    }
}

fn metadata(app: &mut App, ui: &mut egui::Ui, now: &NowPlaying, title_size: f32) {
    let palette = app.palette;
    egui::Sides::new().shrink_left().show(
        ui,
        |ui| {
            let title = widgets::ellipsized(
                ui,
                &now.title,
                theme::semibold(title_size),
                palette.text,
                ui.available_width(),
                2,
            );
            ui.add(egui::Label::new(title)).on_hover_text(&now.title);
        },
        |ui| {
            if now.is_episode {
                return;
            }
            if app.is_save_pending(&now.uri) {
                let response = theme::spinner(ui, 20.0, palette.secondary)
                    .on_hover_text(gettext(app.locale, "Saving…"));
                response.widget_info(|| {
                    egui::WidgetInfo::labeled(
                        egui::WidgetType::Label,
                        false,
                        gettext(app.locale, "Saving like…"),
                    )
                });
            } else {
                let saved = app.is_saved(&now.uri).unwrap_or(false);
                if theme::icon_button(
                    ui,
                    if saved {
                        Icon::HeartFilled
                    } else {
                        Icon::Heart
                    },
                    20.0,
                    if saved {
                        palette.accent
                    } else {
                        palette.secondary
                    },
                    palette.text,
                    &gettext(
                        app.locale,
                        if saved {
                            "Remove from Liked Songs"
                        } else {
                            "Save to Liked Songs"
                        },
                    ),
                )
                .clicked()
                {
                    app.actions.push(Action::ToggleSaved(now.uri.clone()));
                }
            }
        },
    );
    ui.add_space(4.0);
    theme::text(ui, &now.subtitle, theme::regular(13.0), palette.secondary)
        .on_hover_text(&now.subtitle);
    ui.add_space(4.0);
    if now.loading || app.any_play_pending() {
        theme::text(
            ui,
            gettext(app.locale, "Preparing track…"),
            theme::regular(12.0),
            palette.secondary,
        );
    } else if !now.album_name.is_empty() {
        if let Some(id) = &now.album_id {
            if theme::link(ui, &now.album_name, theme::regular(12.0), palette.dim)
                .on_hover_text(&now.album_name)
                .clicked()
            {
                app.actions.push(Action::Open(Page::Album(id.clone())));
            }
        } else {
            theme::text(ui, &now.album_name, theme::regular(12.0), palette.dim)
                .on_hover_text(&now.album_name);
        }
    } else {
        theme::text(
            ui,
            crate::util::format_duration_ms(now.duration_ms),
            theme::regular(12.0),
            palette.dim,
        );
    }
}
