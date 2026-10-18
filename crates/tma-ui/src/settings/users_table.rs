//! The registered users table: one card with a row per account, sub-users
//! indented under their owner, and the least needed columns dropping away as
//! the dialog narrows.

use egui::{Align, Align2, Color32, CornerRadius, FontId, Frame, Layout, Margin, RichText, Sense, Stroke, Ui, Vec2};
use tma_core::api::AdminUser;

use crate::icons::{self, ph};
use crate::theme::{self, Weight};
use crate::widgets;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Col {
    User,
    Storage,
    Limit,
    Mfa,
    Joined,
}

impl Col {
    fn title(self) -> &'static str {
        match self {
            Col::User => "User",
            Col::Storage => "Storage",
            Col::Limit => "Limit",
            Col::Mfa => "Two-factor",
            Col::Joined => "Joined",
        }
    }
}

/// A column with its left edge and width, from the row's inner left.
pub type Placed = (Col, f32, f32);

/// The user column keeps at least this much before other columns are dropped.
const USER_MIN: f32 = 200.0;
/// Space between a row's edge and its first and last column.
const ROW_PAD: f32 = 14.0;

/// Columns that fit `width`: the user column takes what the fixed ones leave,
/// and Joined, then Two-factor, give way when it would get too narrow.
pub fn layout(width: f32) -> Vec<Placed> {
    let mut fixed = vec![(Col::Storage, 130.0), (Col::Limit, 112.0), (Col::Mfa, 92.0), (Col::Joined, 100.0)];
    let fits = |fixed: &[(Col, f32)]| width - fixed.iter().map(|c| c.1).sum::<f32>() >= USER_MIN;
    for drop in [Col::Joined, Col::Mfa] {
        if !fits(&fixed) {
            fixed.retain(|c| c.0 != drop);
        }
    }
    let user = (width - fixed.iter().map(|c| c.1).sum::<f32>()).max(0.0);
    let mut placed = vec![(Col::User, 0.0, user)];
    let mut x = user;
    for (col, w) in fixed {
        placed.push((col, x, w));
        x += w;
    }
    placed
}

/// The card the table sits in, edge to edge with the dialog.
pub fn card<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> R {
    let t = widgets::tokens(ui);
    Frame::new()
        .fill(t.surface_raised)
        .stroke(Stroke::new(1.0, t.separator))
        .corner_radius(CornerRadius::same(theme::RADIUS_LG))
        .inner_margin(Margin::same(6))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            add(ui)
        })
        .inner
}

pub fn header(ui: &mut Ui, cols: &[Placed]) {
    let t = widgets::tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::hover());
    for &(col, x, _) in cols {
        let at = egui::pos2(rect.left() + ROW_PAD + x, rect.center().y);
        ui.painter().text(at, Align2::LEFT_CENTER, col.title(), FontId::new(12.0, theme::medium()), t.label_tertiary);
    }
}

/// One row, `height` tall, with a hairline above it and a soft fill under the
/// pointer; `cell` fills each column, vertically centred.
pub fn row(ui: &mut Ui, cols: &[Placed], height: f32, mut cell: impl FnMut(&mut Ui, Col)) {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), height), Sense::hover());
    let hover = widgets::ease(ui, response.id.with("hover"), ui.rect_contains_pointer(rect), widgets::SNAP);
    ui.painter().rect_filled(rect, 8.0, theme::mix(Color32::TRANSPARENT, t.fill_quaternary, hover));
    let line = (rect.left() + 8.0)..=(rect.right() - 8.0);
    ui.painter().hline(line, rect.top(), Stroke::new(1.0, theme::mix(t.separator, Color32::TRANSPARENT, hover)));
    for &(col, x, w) in cols {
        let left = rect.left() + ROW_PAD + x;
        let right = (left + w - 12.0).min(rect.right() - ROW_PAD);
        let area = egui::Rect::from_x_y_ranges(left..=right.max(left), rect.y_range());
        let mut child =
            ui.new_child(egui::UiBuilder::new().max_rect(area).layout(Layout::left_to_right(Align::Center)));
        child.set_clip_rect(area.intersect(ui.clip_rect()));
        cell(&mut child, col);
    }
}

/// An avatar with initials, then the name over the email; sub-users sit
/// indented under their owner with a smaller, quieter avatar.
pub fn identity(ui: &mut Ui, user: &AdminUser, sub: bool) {
    let t = widgets::tokens(ui);
    let name = user.name.clone().filter(|n| !n.is_empty());
    if sub {
        ui.add_space(8.0);
        ui.label(RichText::new(ph::ARROW_ELBOW_DOWN_RIGHT).size(13.0).color(t.label_tertiary));
        ui.add_space(2.0);
    }
    let radius = if sub { 12.0 } else { 15.0 };
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(radius * 2.0), Sense::hover());
    let (fill, ink) = if sub { (t.fill_tertiary, t.label_secondary) } else { (t.accent_fill, t.accent) };
    ui.painter().circle_filled(rect.center(), radius, fill);
    let initials = icons::initials(name.as_deref().unwrap_or(&user.email));
    ui.painter().text(
        rect.center(),
        Align2::CENTER_CENTER,
        initials,
        FontId::new(radius * 0.8, theme::semibold()),
        ink,
    );
    ui.add_space(10.0);
    ui.vertical(|ui| {
        ui.spacing_mut().item_spacing.y = 1.0;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            let label = name.unwrap_or_else(|| "Unnamed".into());
            ui.add(egui::Label::new(RichText::new(label).size(13.0).medium().color(t.label)).truncate());
            if sub {
                ui.label(RichText::new("· Sub-user").size(12.0).color(t.label_tertiary));
            }
        });
        ui.add(egui::Label::new(RichText::new(&user.email).size(12.0).color(t.label_secondary)).truncate());
    });
}

/// What an account stores, with a thin bar against its limit when it has one;
/// a sub-user's files count toward the owner above it.
pub fn storage(ui: &mut Ui, user: &AdminUser, sub: bool) {
    let t = widgets::tokens(ui);
    if sub {
        ui.label(RichText::new("Owner's storage").size(12.0).color(t.label_tertiary));
        return;
    }
    let used = tma_core::format::file_size(user.storage_used);
    let Some(total) = user.storage_total.filter(|t| *t > 0) else {
        ui.label(RichText::new(used).size(13.0).color(t.label));
        return;
    };
    ui.vertical(|ui| {
        ui.spacing_mut().item_spacing.y = 5.0;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            ui.label(RichText::new(used).size(13.0).color(t.label));
            let of = format!("of {}", tma_core::format::file_size(total));
            ui.label(RichText::new(of).size(12.0).color(t.label_tertiary));
        });
        let share = (user.storage_used as f32 / total as f32).clamp(0.0, 1.0);
        let (bar, _) = ui.allocate_exact_size(Vec2::new(ui.available_width().min(96.0), 4.0), Sense::hover());
        ui.painter().rect_filled(bar, 2.0, t.fill_tertiary);
        let color = super::parts::usage_color(&t, f64::from(share) * 100.0);
        let filled = egui::Rect::from_min_size(bar.min, Vec2::new(bar.width() * share, bar.height()));
        ui.painter().rect_filled(filled, 2.0, color);
    });
}

pub fn mfa(ui: &mut Ui, on: bool) {
    let t = widgets::tokens(ui);
    let (icon, text, color) =
        if on { (ph::SHIELD_CHECK, "On", t.positive_text) } else { (ph::SHIELD, "Off", t.label_tertiary) };
    ui.label(RichText::new(format!("{icon}  {text}")).size(13.0).color(color));
}

/// The day an account joined; the exact time is a hover away.
pub fn joined(ui: &mut Ui, user: &AdminUser) {
    let t = widgets::tokens(ui);
    let day = tma_core::format::day(user.created_at);
    ui.label(RichText::new(day).size(13.0).color(t.label_secondary))
        .on_hover_text(tma_core::format::full_date(user.created_at));
}

/// Two-factor adoption in one line: how many have it, and a bar for the share.
pub fn adoption(ui: &mut Ui, users: &[AdminUser]) {
    let t = widgets::tokens(ui);
    let (on, _, percent) = super::forms::mfa_adoption(users);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        let color = if on == users.len() { t.positive_text } else { t.label_tertiary };
        ui.label(RichText::new(ph::SHIELD_CHECK).size(14.0).color(color));
        let text = format!("Two-factor is on for {on} of {}", tma_core::format::count(users.len(), "user", "users"));
        ui.label(RichText::new(text).size(13.0).color(t.label_secondary));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(RichText::new(format!("{percent}%")).size(13.0).medium().color(t.label));
            let (bar, _) = ui.allocate_exact_size(Vec2::new(120.0, 4.0), Sense::hover());
            ui.painter().rect_filled(bar, 2.0, t.fill_tertiary);
            let filled = egui::Rect::from_min_size(bar.min, Vec2::new(bar.width() * percent as f32 / 100.0, 4.0));
            ui.painter().rect_filled(filled, 2.0, t.positive);
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(width: f32) -> Vec<Col> {
        layout(width).into_iter().map(|c| c.0).collect()
    }

    #[test]
    fn columns_give_way_as_the_table_narrows() {
        assert_eq!(cols(840.0), [Col::User, Col::Storage, Col::Limit, Col::Mfa, Col::Joined]);
        assert_eq!(cols(500.0), [Col::User, Col::Storage, Col::Limit]);
        let wide = layout(840.0);
        assert_eq!(wide[0].2, 840.0 - 130.0 - 112.0 - 92.0 - 100.0);
        assert!(wide.windows(2).all(|w| w[0].1 + w[0].2 == w[1].1));
    }
}
