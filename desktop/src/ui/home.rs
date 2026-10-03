//! Home is a shelf of playable collections, with a compact recent-listening grid.

use super::widgets;
use crate::api::models::{Image, Owner, PlayableItem, Playlist, TrackCount, pick_image};
use crate::app::App;
use crate::model::{Action, Loadable, Page};
use crate::theme::{self, Icon};
use egui::{Rect, Sense, Vec2, pos2, vec2};

pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let palette = app.palette;
    let greeting = crate::util::greeting(app.locale);
    theme::text(ui, greeting.as_ref(), theme::semibold(26.0), palette.text);
    ui.add_space(14.0);
    collections(app, ui);
    library_playlists(app, ui);
    recently_played(app, ui);
}

fn personal_playlist(
    id: &str,
    title: &str,
    subtitle: &str,
    artwork: &str,
    count: usize,
) -> Playlist {
    Playlist {
        id: id.into(),
        uri: if id == "streamarena-liked" {
            "spotify:collection:tracks".into()
        } else {
            format!("spotify:playlist:{id}")
        },
        name: title.into(),
        description: Some(subtitle.into()),
        images: vec![Image {
            url: artwork.into(),
            ..Default::default()
        }],
        owner: Owner {
            display_name: Some("Your library".into()),
            ..Default::default()
        },
        tracks: Some(TrackCount {
            total: count as u32,
        }),
        ..Default::default()
    }
}

fn collections(app: &mut App, ui: &mut egui::Ui) {
    let palette = app.palette;
    let mut playlists = Vec::new();
    if app.settings.home.made_for_you.visible {
        if let Some(featured) = app.home.discover.get() {
            playlists.extend(featured.iter().cloned());
        }
    }
    if let Some(tracks) = app
        .home
        .top_tracks
        .get()
        .filter(|tracks| !tracks.is_empty())
    {
        playlists.push(personal_playlist(
            "streamarena-top",
            "On repeat",
            "Your most-played songs",
            "music-cover:repeat",
            tracks.len(),
        ));
    }
    if let Some(tracks) = app
        .home
        .recently_played
        .get()
        .filter(|tracks| !tracks.is_empty())
    {
        playlists.push(personal_playlist(
            "streamarena-recent",
            "Recently played",
            "Pick up where you left off",
            "music-cover:recent",
            tracks.len(),
        ));
    }
    playlists.push(personal_playlist(
        "streamarena-liked",
        "Liked Songs",
        "All your favourites in one place",
        "music-cover:liked",
        app.library.liked.total.unwrap_or(0) as usize,
    ));

    theme::section_title(ui, &palette, "Playlists & mixes");
    ui.add_space(6.0);
    widgets::grid(ui, |ui| {
        for playlist in &playlists {
            collection_card(app, ui, playlist, false);
        }
        if app.settings.home.made_for_you.visible
            && matches!(app.home.discover, Loadable::NotLoaded | Loadable::Loading)
        {
            for _ in 0..3 {
                widgets::skeleton_card(ui, &palette);
            }
        }
    });
    if app.settings.home.made_for_you.visible {
        if let Loadable::Failed(message) = app.home.discover.clone() {
            widgets::error_row(ui, app, &message, Some(Page::Home));
        }
    }
    ui.add_space(20.0);
}

fn collection_card(app: &mut App, ui: &mut egui::Ui, playlist: &Playlist, menu: bool) {
    let subtitle = playlist
        .description
        .as_deref()
        .map(crate::util::strip_html)
        .filter(|description| !description.is_empty())
        .unwrap_or_else(|| {
            let count = playlist
                .tracks
                .as_ref()
                .map(|tracks| tracks.total)
                .unwrap_or(0);
            if count > 0 {
                format!("{count} songs")
            } else {
                "Playlist".into()
            }
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
            .push(Action::Open(if playlist.id == "streamarena-liked" {
                Page::LikedSongs
            } else {
                Page::Playlist(playlist.id.clone())
            }));
    }
    if menu {
        egui::Popup::context_menu(&card.response)
            .id(ui.make_persistent_id(("home-playlist-menu", &playlist.uri)))
            .frame(widgets::menu_frame(&app.palette))
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
}

fn library_playlists(app: &mut App, ui: &mut egui::Ui) {
    let playlists: Vec<_> = app
        .library
        .playlists
        .get()
        .into_iter()
        .flatten()
        .filter(|playlist| !playlist.id.is_empty() && playlist.id != "streamarena-all")
        .take(18)
        .cloned()
        .collect();
    if playlists.is_empty() {
        return;
    }
    let palette = app.palette;
    widgets::shelf(
        ui,
        &palette,
        "home-library-playlists",
        "Your playlists",
        |ui| {
            for playlist in &playlists {
                collection_card(app, ui, playlist, true);
            }
        },
    );
    ui.add_space(6.0);
}

fn recently_played(app: &mut App, ui: &mut egui::Ui) {
    let Some(history) = app.home.recently_played.get() else {
        return;
    };
    let mut seen = std::collections::HashSet::new();
    let tracks: Vec<_> = history
        .iter()
        .filter(|entry| seen.insert(entry.track.uri.clone()))
        .take(8)
        .map(|entry| entry.track.clone())
        .collect();
    if tracks.is_empty() {
        return;
    }
    let palette = app.palette;
    theme::section_title(ui, &palette, "Jump back in");
    ui.add_space(14.0);
    let gap = 10.0;
    let columns = ((ui.available_width() + gap) / 260.0)
        .floor()
        .clamp(1.0, 4.0) as usize;
    let width = (ui.available_width() - gap * (columns - 1) as f32) / columns as f32;
    egui::Grid::new("home-recent-grid")
        .num_columns(columns)
        .spacing(vec2(gap, gap))
        .show(ui, |ui| {
            for (index, track) in tracks.iter().enumerate() {
                let (rect, response) = ui.allocate_exact_size(vec2(width, 68.0), Sense::click());
                response.widget_info(|| {
                    egui::WidgetInfo::labeled(
                        egui::WidgetType::Button,
                        true,
                        format!("{}, {}", track.name, track.artist_names()),
                    )
                });
                if response.gained_focus() {
                    response.scroll_to_me(None);
                }
                let mut playback_clicked = false;
                let mut play = false;
                if ui.is_rect_visible(rect) {
                    let current = app.current_track_uri().as_deref() == Some(track.uri.as_str());
                    let play_id = response.id.with("play");
                    let hovered = response.hovered()
                        || response.has_focus()
                        || ui.memory(|memory| memory.has_focus(play_id));
                    ui.painter().rect_filled(
                        rect,
                        6,
                        if hovered {
                            palette.surface_hover
                        } else {
                            palette.panel
                        },
                    );
                    let cover = Rect::from_min_size(rect.min, Vec2::splat(68.0));
                    widgets::paint_cover(
                        ui,
                        &palette,
                        track.image(160),
                        cover,
                        5.0,
                        Icon::Music,
                        Some(app.backend.art()),
                    );
                    let left = cover.right() + 12.0;
                    let text_width = (rect.right() - left - 46.0).max(16.0);
                    let title = widgets::ellipsized(
                        ui,
                        &track.name,
                        theme::semibold(14.0),
                        if current {
                            palette.accent
                        } else {
                            palette.text
                        },
                        text_width,
                        1,
                    );
                    ui.painter()
                        .galley(pos2(left, rect.top() + 16.0), title, palette.text);
                    let artist = widgets::ellipsized(
                        ui,
                        &track.artist_names(),
                        theme::regular(12.5),
                        palette.secondary,
                        text_width,
                        1,
                    );
                    ui.painter()
                        .galley(pos2(left, rect.top() + 37.0), artist, palette.secondary);
                    if hovered || current || app.play_pending(&track.uri) {
                        let button = Rect::from_center_size(
                            pos2(rect.right() - 26.0, rect.center().y),
                            Vec2::splat(34.0),
                        );
                        (playback_clicked, play) =
                            widgets::cover_play_button(ui, app, button, play_id, Some(&track.uri));
                    }
                }
                if play || (response.clicked() && !playback_clicked) {
                    if app.current_track_uri().as_deref() == Some(track.uri.as_str()) {
                        app.actions.push(Action::TogglePlay);
                    } else {
                        app.actions.push(Action::PlayUris {
                            uris: vec![track.uri.clone()],
                            index: 0,
                        });
                    }
                }
                theme::focus_ring(ui, &response);
                egui::Popup::context_menu(&response)
                    .id(ui.make_persistent_id(("home-recent-menu", &track.uri)))
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
                if (index + 1) % columns == 0 {
                    ui.end_row();
                }
            }
        });
    ui.add_space(20.0);
}
