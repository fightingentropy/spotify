//! Instant artwork for personal collections and cold editorial cards.
use crate::theme;
use egui::{Align2, Color32, Rect, Stroke, Ui, pos2, vec2};

pub(super) fn paint(ui: &Ui, uri: &str, rect: Rect, radius: f32) -> bool {
    let (title, subtitle, color) = match uri {
        "music-cover:repeat" => (
            "On\nrepeat",
            "YOUR ROTATION",
            Color32::from_rgb(173, 67, 44),
        ),
        "music-cover:recent" => (
            "Recently\nplayed",
            "BACK IN THE MIX",
            Color32::from_rgb(47, 95, 108),
        ),
        "music-cover:global" => ("Top\n50", "GLOBAL", Color32::from_rgb(30, 84, 81)),
        "music-cover:uk" => ("Top\n50", "UNITED KINGDOM", Color32::from_rgb(56, 74, 117)),
        "music-cover:discover" => (
            "Discover\nMix",
            "YOUTUBE MUSIC",
            Color32::from_rgb(99, 58, 62),
        ),
        "music-cover:liked" => {
            super::sidebar::liked_cover(ui, rect, radius);
            return true;
        }
        _ => return false,
    };
    let painter = ui.painter().with_clip_rect(rect);
    painter.rect_filled(rect, egui::CornerRadius::same(radius as u8), color);
    let scale = rect.width() / 192.0;
    // Quiet concentric arcs give the covers a shared identity at every size.
    for index in 0..5 {
        painter.circle_stroke(
            rect.right_top() + vec2(12.0 * scale, 16.0 * scale),
            (42.0 + index as f32 * 16.0) * scale,
            Stroke::new(1.3 * scale, Color32::from_white_alpha(27)),
        );
    }
    let inset = 17.0 * scale;
    painter.text(
        rect.left_top() + vec2(inset, inset),
        Align2::LEFT_TOP,
        subtitle,
        theme::semibold(9.0 * scale),
        Color32::from_white_alpha(210),
    );
    for (index, line) in title.lines().enumerate() {
        painter.text(
            pos2(
                rect.left() + inset,
                rect.top() + (59.0 + index as f32 * 37.0) * scale,
            ),
            Align2::LEFT_TOP,
            line,
            theme::bold(33.0 * scale),
            Color32::WHITE,
        );
    }
    true
}
