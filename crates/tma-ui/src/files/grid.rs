//! The listing as tiles.

use egui::{Align2, CornerRadius, FontId, Rect, Sense, Stroke, Ui, Vec2};

use super::actions::Action;
use super::view::{TILE, interact, meta_line, name_label, paint_item_fill};
use crate::app::Main;
use crate::icons::{self, ph};
use crate::theme::Tokens;

/// As many columns of at least `min` as fit in `width`, widened to fill it, so the
/// row ends flush with the edge instead of leaving a strip of space.
pub fn columns(width: f32, min: f32, gap: f32) -> (usize, f32) {
    let per_row = (((width + gap) / (min + gap)).floor() as usize).max(1);
    let tile = ((width - gap * (per_row - 1) as f32) / per_row as f32).max(min.min(width));
    (per_row, tile.floor())
}

pub(super) fn grid(main: &mut Main, ui: &mut Ui, t: &Tokens, desktop: bool, actions: &mut Vec<Action>) {
    let width = ui.available_width();
    let gap = ui.spacing().item_spacing;
    let (per_row, tile_width) = columns(width, TILE.x, gap.x);
    let tile = Vec2::new(tile_width, TILE.y);
    // Each row is exactly this tall, the height show_rows assumes, so offsets stay exact.
    let row_height = TILE.y + 4.0;
    let count = main.browser.items.len();
    let rows = count.div_ceil(per_row) + usize::from(main.browser.cursor.is_some());
    main.browser.drop_target = None;
    let pitch = Vec2::new(tile.x + gap.x, row_height + gap.y);
    let mut area =
        egui::ScrollArea::vertical().auto_shrink([false, false]).scroll_source(super::marquee::scroll_source(ui.ctx()));
    if let Some(index) = main.browser.scroll_to.take() {
        area = area.vertical_scroll_offset(((index / per_row) as f32 * pitch.y - ui.available_height() / 2.0).max(0.0));
    }
    if let Some(offset) = main.browser.scroll_set.take() {
        area = area.vertical_scroll_offset(offset);
    }
    let output = area.show_rows(ui, row_height, rows, |ui, range| {
        let background = super::marquee::background(ui);
        let origin = egui::pos2(ui.max_rect().left(), ui.max_rect().top() - range.start as f32 * pitch.y);
        let layout = super::marquee::Layout::Tiles { per_row, pitch, tile };
        let now = chrono::Utc::now();
        for row in range {
            ui.horizontal(|ui| {
                ui.set_min_height(row_height);
                for col in 0..per_row {
                    let index = row * per_row + col;
                    let Some(item) = main.browser.items.get(index).cloned() else {
                        if index == count && main.browser.cursor.is_some() {
                            actions.push(Action::LoadMore);
                        }
                        break;
                    };
                    let (rect, _) = ui.allocate_exact_size(tile, Sense::hover());
                    let response = interact(main, ui, rect, rect, &item, desktop, actions);
                    // Every tile is a card; selection and hover tint it.
                    ui.painter().rect(
                        rect,
                        CornerRadius::same(16),
                        t.surface,
                        Stroke::new(1.0, t.separator),
                        egui::StrokeKind::Inside,
                    );
                    paint_item_fill(ui, main, &item, rect, response.hovered(), 16, t);
                    let icon_rect = Rect::from_center_size(rect.center_top() + Vec2::new(0.0, 34.0), Vec2::splat(44.0));
                    let thumb = super::thumbs::wants_thumbnail(&item).then(|| main.browser.thumbs.get(&item)).flatten();
                    if let Some(texture) = thumb {
                        let area = Rect::from_center_size(
                            rect.center_top() + Vec2::new(0.0, 36.0),
                            Vec2::new(rect.width() - 24.0, 52.0),
                        );
                        let shown = super::thumbs::fit(area, texture.size_vec2());
                        let uv = Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0));
                        ui.painter().image(texture.id(), shown, uv, crate::theme::NO_TINT);
                    } else if item.is_folder() {
                        icons::folder(ui.painter(), icon_rect, t, false);
                    } else {
                        icons::file(ui.painter(), icon_rect, t, &item.name, item.mime_type.as_deref());
                    }
                    let text_rect =
                        Rect::from_min_max(rect.min + Vec2::new(10.0, 66.0), rect.max - Vec2::new(10.0, 6.0));
                    let job = egui::text::LayoutJob {
                        wrap: egui::text::TextWrapping {
                            max_rows: 2,
                            break_anywhere: true,
                            overflow_character: Some('…'),
                            max_width: text_rect.width(),
                        },
                        halign: egui::Align::Center,
                        ..egui::text::LayoutJob::simple(
                            name_label(main, &item),
                            FontId::new(12.0, crate::theme::semibold()),
                            t.label,
                            text_rect.width(),
                        )
                    };
                    let galley = ui.painter().layout_job(job);
                    let name_height = galley.size().y;
                    ui.painter().galley(egui::pos2(text_rect.center().x, text_rect.min.y), galley, t.label);
                    ui.painter().with_clip_rect(rect).text(
                        egui::pos2(text_rect.center().x, text_rect.min.y + name_height + 3.0),
                        Align2::CENTER_TOP,
                        meta_line(main, &item, now),
                        FontId::proportional(11.0),
                        t.label_tertiary,
                    );
                    let mut corner = rect.right_top() + Vec2::new(-16.0, 16.0);
                    if item.starred {
                        ui.painter().text(
                            corner,
                            Align2::CENTER_CENTER,
                            egui_phosphor::fill::STAR,
                            FontId::proportional(12.0),
                            t.warning,
                        );
                        corner.x -= 16.0;
                    }
                    if super::is_shared(&item) {
                        let badge = ui.painter().text(
                            corner,
                            Align2::CENTER_CENTER,
                            ph::LINK,
                            FontId::proportional(12.0),
                            t.accent,
                        );
                        super::view::share_tip(ui, &item, badge, now);
                    }
                }
            });
        }
        super::marquee::update(main, ui, &background, origin, layout, t);
    });
    main.browser.scroll = output.state.clamped_offset().y;
}

#[cfg(test)]
mod tests {
    #[test]
    fn tiles_fill_the_row() {
        // 5 tiles of 156 and 4 gaps of 8 need 812; the 100 left are shared out.
        let (n, w) = super::columns(912.0, 156.0, 8.0);
        assert_eq!(n, 5);
        assert!((n as f32 * w + 4.0 * 8.0 - 912.0).abs() < 5.0);
        assert_eq!(super::columns(100.0, 156.0, 8.0), (1, 100.0));
    }
}
