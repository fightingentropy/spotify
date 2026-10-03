//! Native sign-in for the StreamArena Music service.

use egui::{Align, CornerRadius, Frame, Layout, Margin, Rect, Stroke, Vec2};

use crate::app::App;
use crate::backend::{AuthStatus, Command};
use crate::theme::{self, Icon};

/// In-memory form state only; credentials are never part of persisted settings.
#[derive(Clone, Default)]
struct SignInForm {
    email: String,
    password: String,
}

pub fn show(app: &mut App, ui: &mut egui::Ui, connecting: bool) {
    let palette = app.palette;
    let form_id = egui::Id::new("music-sign-in-form");
    let mut form = ui
        .data(|data| data.get_temp::<SignInForm>(form_id))
        .unwrap_or_default();
    egui::CentralPanel::default()
        .frame(Frame::new().fill(palette.window))
        .show(ui, |ui| {
            let rect = ui.max_rect();
            let drag_rect = Rect::from_min_size(
                rect.min,
                Vec2::new(
                    rect.width(),
                    theme::TOP_BAR_HEIGHT + theme::titlebar_inset(ui.ctx()),
                ),
            );
            super::titlebar_drag(ui, drag_rect);
            let width = 440.0_f32.min((rect.width() - 32.0).max(0.0));
            let card = Rect::from_center_size(
                rect.center(),
                Vec2::new(width, 450.0_f32.min(rect.height() - 32.0)),
            );
            let mut card_ui = ui.new_child(
                egui::UiBuilder::new()
                    .max_rect(card)
                    .layout(Layout::top_down(Align::Min)),
            );
            Frame::new()
                .fill(palette.panel)
                .stroke(Stroke::new(1.0, palette.outline))
                .corner_radius(CornerRadius::same(theme::RADIUS))
                .inner_margin(Margin::same(28))
                .show(&mut card_ui, |ui| {
                    ui.set_width((width - 56.0).max(0.0));
                    egui::ScrollArea::vertical()
                        .id_salt("music-sign-in-scroll")
                        .max_height((card.height() - 56.0).max(0.0))
                        .show(ui, |ui| {
                            ui.add(Icon::Music.image(palette.accent, 36.0));
                            ui.add_space(12.0);
                            theme::text(ui, "Spotify", theme::bold(26.0), palette.text);
                            theme::text(
                                ui,
                                "Sign in with your music account.",
                                theme::regular(14.0),
                                palette.secondary,
                            );
                            ui.add_space(20.0);
                            let mut submit = false;
                            ui.add_enabled_ui(!connecting, |ui| {
                                theme::text(ui, "Email", theme::medium(13.0), palette.text);
                                let email = super::widgets::text_edit(
                                    ui,
                                    app.locale,
                                    egui::TextEdit::singleline(&mut form.email)
                                        .id(egui::Id::new("music-sign-in-email"))
                                        .hint_text("you@example.com")
                                        .desired_width(f32::INFINITY),
                                );
                                ui.add_space(10.0);
                                theme::text(ui, "Password", theme::medium(13.0), palette.text);
                                let password = super::widgets::text_edit(
                                    ui,
                                    app.locale,
                                    egui::TextEdit::singleline(&mut form.password)
                                        .id(egui::Id::new("music-sign-in-password"))
                                        .password(true)
                                        .hint_text("Password")
                                        .desired_width(f32::INFINITY),
                                );
                                let enter = ui.input(|input| input.key_pressed(egui::Key::Enter));
                                if email.lost_focus() && enter {
                                    password.request_focus();
                                }
                                submit = password.lost_focus() && enter;
                                ui.add_space(18.0);
                                submit |= ui
                                    .add_enabled_ui(
                                        !form.email.trim().is_empty() && !form.password.is_empty(),
                                        |ui| theme::pill_button(ui, &palette, "Sign in", true),
                                    )
                                    .inner
                                    .clicked();
                            });
                            if submit
                                && !connecting
                                && !form.email.trim().is_empty()
                                && !form.password.is_empty()
                            {
                                app.auth = AuthStatus::Connecting;
                                app.backend.send(Command::MusicSignIn {
                                    email: form.email.trim().to_string(),
                                    password: std::mem::take(&mut form.password),
                                });
                            }
                            ui.add_space(12.0);
                            if connecting {
                                ui.horizontal(|ui| {
                                    theme::spinner(ui, 16.0, palette.accent);
                                    theme::text(
                                        ui,
                                        "Connecting…",
                                        theme::regular(13.0),
                                        palette.secondary,
                                    );
                                });
                            } else if let AuthStatus::Failed(message) = &app.auth {
                                ui.add(
                                    egui::Label::new(
                                        egui::RichText::new(message)
                                            .font(theme::regular(13.0))
                                            .color(palette.danger),
                                    )
                                    .wrap(),
                                );
                            }
                            ui.add_space(10.0);
                            if theme::link(
                                ui,
                                "Manage your account on the website",
                                theme::regular(12.5),
                                palette.secondary,
                            )
                            .clicked()
                            {
                                ui.ctx().open_url(egui::OpenUrl::new_tab(
                                    "https://music.streamarena.xyz",
                                ));
                            }
                        });
                });
        });
    ui.data_mut(|data| data.insert_temp(form_id, form));
}
