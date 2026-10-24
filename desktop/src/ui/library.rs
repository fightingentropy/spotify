//! The Podcasts page: the shows saved to the library.

use crate::api::models::pick_image;
use crate::app::App;
use crate::i18n::gettext;
use crate::model::{Action, Page};
use crate::theme::{self, Icon};

use super::widgets;

pub fn show(app: &mut App, ui: &mut egui::Ui, page: Page) {
    let palette = app.palette;
    ui.add_space(8.0);
    let locale = app.locale;
    let (title, empty_title, empty_body) = (
        gettext(locale, "Podcasts"),
        gettext(locale, "No podcasts yet"),
        gettext(locale, "Followed podcasts appear here."),
    );
    theme::text(
        ui,
        title.as_ref(),
        theme::semibold(theme::PAGE_TITLE_SIZE),
        palette.text,
    );
    theme::subtle(
        ui,
        &palette,
        "Science, ideas, comedy, and conversations. The same shows as your web library.",
    );
    ui.add_space(24.0);
    let card_height = widgets::card_row_height(ui);
    let count = app.library.shows.items.len();
    if count == 0 && app.library.shows.loading {
        widgets::skeleton_cards(ui, &palette, 6);
    }
    widgets::virtual_wrapped_cards(ui, count, card_height, |ui, index| {
        let show = app.library.shows.items[index].show.clone();
        let id = show.id.clone();
        let card = widgets::card(
            ui,
            app,
            pick_image(&show.images, 640),
            &show.name,
            &show.publisher,
            false,
            false,
        );
        if card.clicked {
            app.actions.push(Action::Open(Page::Show(id)));
        }
    });
    let list = &app.library.shows;
    let (loading, error, can_load, empty) = (
        list.loading,
        list.error.clone(),
        list.can_load_more(),
        list.items.is_empty() && list.loaded_once,
    );
    footer(
        app,
        ui,
        page,
        loading,
        error,
        can_load,
        empty,
        &empty_title,
        &empty_body,
        Icon::Mic,
    );
}

#[allow(clippy::too_many_arguments)]
fn footer(
    app: &mut App,
    ui: &mut egui::Ui,
    page: Page,
    loading: bool,
    error: Option<String>,
    can_load: bool,
    empty: bool,
    empty_title: &str,
    empty_body: &str,
    icon: Icon,
) {
    let palette = app.palette;
    if loading {
        ui.add_space(8.0);
        widgets::loading_row(ui, &palette, app.locale);
    }
    if let Some(error) = error {
        widgets::error_row(ui, app, &error, Some(page.clone()));
    }
    if empty && !loading {
        widgets::empty_state(ui, &palette, icon, empty_title, empty_body);
    }
    widgets::load_more_when_near_end(ui, app, page, can_load && !loading);
}
