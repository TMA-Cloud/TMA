//! The parts of the sign-in card: labelled fields, the password eye, the
//! requirement hint, the error banner and the full-width button.

use egui::{Align2, Color32, FontId, RichText, Sense, Stroke, Ui, Vec2};

use crate::icons::ph;
use crate::login_form::{self, Field, Kind};
use crate::theme::{self, Weight};
use crate::widgets;

/// Fields and the button are this tall: a comfortable touch target.
pub(super) const HEIGHT: f32 = 44.0;
const RADIUS: u8 = 10;
/// The new-password rule the server enforces.
pub(super) const MIN_PASSWORD: usize = 8;

fn shown_id(kind: Kind) -> egui::Id {
    egui::Id::unique(("show-password", kind))
}

fn shown(ui: &Ui, kind: Kind) -> bool {
    ui.data(|d| d.get_temp::<bool>(shown_id(kind))).unwrap_or(false)
}

/// The eye at the right end of a password field, which shows what was typed.
/// True while it is pressed or clicked, so the field can keep its focus.
fn eye(ui: &mut Ui, field: egui::Rect, kind: Kind) -> bool {
    let t = widgets::tokens(ui);
    let on = shown(ui, kind);
    let rect = egui::Rect::from_center_size(field.right_center() - egui::vec2(22.0, 0.0), Vec2::splat(30.0));
    let toggle = ui.interact(rect, shown_id(kind).with("toggle"), Sense::click());
    let color = if toggle.hovered() { t.label } else { t.label_tertiary };
    ui.painter().text(
        rect.center(),
        Align2::CENTER_CENTER,
        if on { ph::EYE_SLASH } else { ph::EYE },
        FontId::proportional(17.0),
        color,
    );
    let toggle = toggle.on_hover_text(if on { "Hide password" } else { "Show password" });
    if toggle.clicked() {
        ui.data_mut(|d| d.insert_temp(shown_id(kind), !on));
    }
    toggle.is_pointer_button_down_on() || toggle.clicked()
}

/// A label above its field, as forms should have: a placeholder vanishes as
/// soon as typing starts. True when Enter is pressed in the field.
pub(super) fn labelled(ui: &mut Ui, label: &str, add: impl FnOnce(&mut Ui) -> bool) -> bool {
    let t = widgets::tokens(ui);
    ui.label(RichText::new(label).size(13.0).medium().color(t.label));
    ui.add_space(6.0 - ui.spacing().item_spacing.y);
    add(ui)
}

/// A sign-in field. On the web it is a browser input over a drawn frame, so
/// password managers can fill and save it; the desktop app draws its own.
pub(super) fn entry(ui: &mut Ui, value: &mut String, kind: Kind, placeholder: &str, signing_up: bool) -> bool {
    let password = kind == Kind::Password;
    let on = password && shown(ui, kind);
    if !login_form::NATIVE_INPUTS {
        let r = text_field(ui, value, password && !on, placeholder);
        if password && eye(ui, r.rect, kind) {
            r.request_focus();
        }
        return r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
    }
    let t = widgets::tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), HEIGHT), Sense::hover());
    let text = egui::Rect::from_min_max(
        rect.min + egui::vec2(14.0, 0.0),
        rect.max - egui::vec2(if password { 44.0 } else { 14.0 }, 0.0),
    );
    let seen = login_form::field(ui.ctx(), Field { kind, rect: text, value, placeholder, shown: on, signing_up }, &t);
    frame(ui, rect, seen.focused);
    if password {
        eye(ui, rect, kind);
    }
    seen.enter
}

/// The drawn field: a filled box with a hairline, ringed in the accent when focused.
fn frame(ui: &Ui, rect: egui::Rect, focused: bool) {
    let t = widgets::tokens(ui);
    let (width, color) = if focused { (1.5, t.accent) } else { (1.0, t.separator_strong) };
    ui.painter().rect(rect, RADIUS, t.fill_quaternary, Stroke::new(width, color), egui::StrokeKind::Inside);
}

/// An egui field drawn like the web one, for the desktop app and the server address.
pub(super) fn text_field(ui: &mut Ui, value: &mut String, password: bool, placeholder: &str) -> egui::Response {
    let t = widgets::tokens(ui);
    let width = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, HEIGHT), Sense::hover());
    let inner = egui::Rect::from_min_max(rect.min + egui::vec2(14.0, 0.0), rect.max - egui::vec2(44.0, 0.0));
    let id = ui.next_auto_id().with("field");
    // Under the text, so a press on the text reaches it; on top, egui drops the focus until release.
    let whole = ui.interact(rect, id.with("box"), Sense::click());
    let edit = egui::TextEdit::singleline(value)
        .id(id)
        .password(password)
        .hint_text(RichText::new(placeholder).color(t.label_tertiary))
        .font(FontId::proportional(14.0))
        .frame(egui::Frame::NONE)
        .align(egui::Align2::LEFT_CENTER)
        .desired_width(inner.width());
    let response = ui.put(inner, edit);
    // The whole box focuses the field, not just the text line inside it.
    if whole.is_pointer_button_down_on() || whole.clicked() {
        response.request_focus();
    }
    frame(ui, rect, response.has_focus());
    response.with_new_rect(rect)
}

/// The new-password rule under the field, ticked once the password meets it.
pub(super) fn password_rule(ui: &mut Ui, password: &str) {
    let t = widgets::tokens(ui);
    let met = password.chars().count() >= MIN_PASSWORD;
    let (icon, color) = if met { (ph::CHECK_CIRCLE, t.positive_text) } else { (ph::CIRCLE, t.label_tertiary) };
    ui.add_space(4.0 - ui.spacing().item_spacing.y);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        ui.label(RichText::new(icon).size(13.0).color(color));
        ui.label(RichText::new(format!("At least {MIN_PASSWORD} characters")).size(12.0).color(color));
    });
}

/// What went wrong, in a tinted box with an icon, so it is seen and read.
pub(super) fn error_banner(ui: &mut Ui, text: &str) {
    let t = widgets::tokens(ui);
    egui::Frame::new()
        .fill(theme::with_alpha(t.destructive, 28))
        .stroke(Stroke::new(1.0, theme::with_alpha(t.destructive, 70)))
        .corner_radius(egui::CornerRadius::same(RADIUS))
        .inner_margin(egui::Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                ui.label(RichText::new(ph::WARNING_CIRCLE).size(15.0).color(t.destructive_text));
                ui.add(egui::Label::new(RichText::new(text).size(13.0).color(t.destructive_text)).wrap());
            });
        });
}

/// The full-width main button; while busy it spins and says what it is doing.
pub(super) fn button(ui: &mut Ui, label: &str, busy: Option<&str>) -> bool {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), HEIGHT), Sense::click());
    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
    let hover = widgets::ease(ui, response.id.with("hover"), response.hovered() && busy.is_none(), widgets::SNAP);
    let fill = theme::mix(t.accent, t.accent_hover, hover);
    ui.painter().rect_filled(
        rect,
        RADIUS,
        if busy.is_some() { theme::mix(t.accent, Color32::TRANSPARENT, 0.25) } else { fill },
    );
    let font = FontId::new(14.0, theme::semibold());
    match busy {
        Some(text) => {
            let galley = ui.painter().layout_no_wrap(text.to_string(), font, t.on_accent);
            let spinner = 14.0;
            let left = rect.center().x - (galley.size().x + spinner + 8.0) / 2.0;
            let spin =
                egui::Rect::from_center_size(egui::pos2(left + spinner / 2.0, rect.center().y), Vec2::splat(spinner));
            egui::Spinner::new().size(spinner).color(t.on_accent).paint_at(ui, spin);
            let at = egui::pos2(left + spinner + 8.0, rect.center().y - galley.size().y / 2.0);
            ui.painter().galley(at, galley, t.on_accent);
            false
        }
        None => {
            ui.painter().text(rect.center(), Align2::CENTER_CENTER, label, font, t.on_accent);
            response.clicked()
        }
    }
}

/// A line of muted text with a link at its end: "No account yet? Create one".
pub(super) fn switch_link(ui: &mut Ui, text: &str, link: &str) -> bool {
    let t = widgets::tokens(ui);
    let mut clicked = false;
    let galley_width =
        |ui: &Ui, s: &str, font: FontId| ui.painter().layout_no_wrap(s.to_string(), font, t.label).size().x;
    let width = galley_width(ui, text, FontId::proportional(13.0))
        + galley_width(ui, link, FontId::new(13.0, theme::semibold()))
        + 4.0;
    ui.horizontal(|ui| {
        ui.add_space(((ui.available_width() - width) / 2.0).max(0.0));
        ui.spacing_mut().item_spacing.x = 4.0;
        ui.label(RichText::new(text).size(13.0).color(t.label_secondary));
        let link = egui::Button::new(RichText::new(link).size(13.0).semibold().color(t.accent)).frame(false);
        clicked = ui.add(link).on_hover_cursor(egui::CursorIcon::PointingHand).clicked();
    });
    clicked
}
