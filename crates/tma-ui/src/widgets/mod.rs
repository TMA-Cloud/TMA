//! Small styled controls used across screens: buttons, cards, fields, the
//! switch, badges and empty states.

use egui::{Color32, CornerRadius, Frame, Margin, Response, RichText, Sense, Stroke, Ui, Vec2, WidgetText};

use crate::icons::ph;
use crate::theme::Weight;
use crate::theme::{RADIUS_LG, RADIUS_MD, Tokens};

mod rows;

pub use rows::*;

pub fn tokens(ui: &Ui) -> Tokens {
    tokens_ctx(ui.ctx())
}

pub fn tokens_ctx(ctx: &egui::Context) -> Tokens {
    ctx.data(|d| d.get_temp::<TokensCell>(egui::Id::NULL)).map(|c| c.0).unwrap_or_else(Tokens::light)
}

/// Tokens stored in egui memory so any widget can read the active palette.
#[derive(Clone, Copy)]
pub struct TokensCell(pub Tokens);

pub fn store_tokens(ctx: &egui::Context, t: Tokens) {
    ctx.data_mut(|d| d.insert_temp(egui::Id::NULL, TokensCell(t)));
}

pub fn card<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> R {
    let t = tokens(ui);
    // Inside a section card it is a row of that card, not a card within it.
    if in_section(ui) {
        return row_frame(ui).show(ui, add).inner;
    }
    Frame::new()
        .fill(t.surface_raised)
        .stroke(Stroke::new(1.0, t.separator))
        .corner_radius(CornerRadius::same(RADIUS_LG))
        .inner_margin(Margin::same(16))
        .show(ui, add)
        .inner
}

fn sized(button: egui::Button<'_>) -> egui::Button<'_> {
    button.corner_radius(CornerRadius::same(16)).min_size(Vec2::new(0.0, 32.0))
}

/// A dialog's title row with a round close button, above a hairline; true when closed.
pub fn dialog_header(ui: &mut Ui, title: &str) -> bool {
    dialog_header_with(ui, title, "")
}

/// A dialog's title, with a line under it saying where or what it acts on.
pub fn dialog_header_with(ui: &mut Ui, title: &str, subtitle: &str) -> bool {
    let t = tokens(ui);
    let mut close = false;
    ui.horizontal(|ui| {
        ui.vertical(|ui| {
            ui.set_max_width(ui.available_width() - 34.0);
            ui.spacing_mut().item_spacing.y = 2.0;
            let title = RichText::new(title).size(17.0).family(crate::theme::bold()).color(t.label);
            ui.add(egui::Label::new(title).truncate());
            if !subtitle.is_empty() {
                ui.add(egui::Label::new(RichText::new(subtitle).size(12.0).color(t.label_tertiary)).truncate());
            }
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let (rect, response) = ui.allocate_exact_size(Vec2::splat(26.0), Sense::click());
            let fill = if response.hovered() { t.fill_secondary } else { t.fill_tertiary };
            ui.painter().circle_filled(rect.center(), 13.0, fill);
            ui.painter().text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                ph::X,
                egui::FontId::proportional(12.0),
                t.label_secondary,
            );
            close = response.on_hover_text("Close").clicked();
        });
    });
    ui.add_space(6.0);
    let rect = ui.available_rect_before_wrap();
    ui.painter().hline((rect.left() - 22.0)..=(rect.right() + 22.0), rect.top(), Stroke::new(1.0, t.separator));
    ui.add_space(14.0);
    close
}

/// The buttons at the foot of a dialog, right-aligned; add the main action first.
pub fn dialog_footer<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> R {
    ui.add_space(8.0);
    // One row tall: a bare right-to-left layout would claim the remaining height
    // and keep a dialog from shrinking when its content does.
    let size = Vec2::new(ui.available_width(), ui.spacing().interact_size.y);
    ui.allocate_ui_with_layout(size, egui::Layout::right_to_left(egui::Align::Center), add).inner
}

pub fn primary(ui: &mut Ui, text: impl Into<String>) -> Response {
    let t = tokens(ui);
    ui.add(sized(egui::Button::new(RichText::new(text.into()).color(t.on_accent).semibold()).fill(t.accent)))
}

pub fn primary_enabled(ui: &mut Ui, enabled: bool, text: impl Into<String>) -> Response {
    let t = tokens(ui);
    ui.add_enabled(
        enabled,
        sized(egui::Button::new(RichText::new(text.into()).color(t.on_accent).semibold()).fill(t.accent)),
    )
}

pub fn secondary(ui: &mut Ui, text: impl Into<WidgetText>) -> Response {
    let t = tokens(ui);
    if ui.data(|d| d.get_temp::<bool>(egui::Id::unique(ROW_ACTIONS)).unwrap_or(false)) {
        // Neutral, so the accent is left for the one action a page leads with.
        return ui.add(
            egui::Button::new(text)
                .fill(t.fill_quaternary)
                .stroke(Stroke::new(1.0, t.separator_strong))
                .corner_radius(CornerRadius::same(15))
                .min_size(Vec2::new(0.0, 30.0)),
        );
    }
    ui.add(sized(egui::Button::new(text).fill(t.fill_quaternary).stroke(Stroke::new(1.0, t.separator))))
}

/// Set while a setting row draws its control, so buttons there take the quieter row style.
pub(super) const ROW_ACTIONS: &str = "tma-row-actions";

pub fn danger(ui: &mut Ui, text: impl Into<String>) -> Response {
    let t = tokens(ui);
    ui.add(sized(egui::Button::new(RichText::new(text.into()).color(t.on_accent).semibold()).fill(t.destructive)))
}

pub fn ghost(ui: &mut Ui, text: impl Into<WidgetText>) -> Response {
    ui.add(sized(egui::Button::new(text).frame(false)))
}

/// A square icon button with a tooltip.
/// The header's rounded search box. Returns its response, and the query when Enter is pressed.
pub fn search_field(ui: &mut Ui, text: &mut String, hint: &str, width: f32, t: &Tokens) -> (Response, Option<String>) {
    let frame = egui::Frame::new()
        .fill(t.fill_quaternary)
        .corner_radius(CornerRadius::same(18))
        .inner_margin(Margin::symmetric(14, 8));
    let r = ui.add(egui::TextEdit::singleline(text).hint_text(hint).desired_width(width).frame(frame));
    let entered = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) && !text.trim().is_empty();
    let query = entered.then(|| text.trim().to_string());
    (r, query)
}

pub fn icon_button(ui: &mut Ui, icon: &str, tip: &str) -> Response {
    let t = tokens(ui);
    ui.add(
        egui::Button::new(RichText::new(icon).size(16.0).color(t.label_secondary))
            .frame(false)
            .min_size(Vec2::splat(28.0)),
    )
    .on_hover_text(tip)
}

/// An iOS-style switch.
pub fn toggle(ui: &mut Ui, on: &mut bool) -> Response {
    let id = ui.next_auto_id();
    toggle_with_id(ui, id, on)
}

/// A switch with a stable id, for lists whose rows can appear while loading:
/// an id from widget order could hand a click to the switch that was there before.
pub fn toggle_with_id(ui: &mut Ui, id: egui::Id, on: &mut bool) -> Response {
    let t = tokens(ui);
    let size = Vec2::new(36.0, 21.0);
    let (rect, _) = ui.allocate_exact_size(size, Sense::hover());
    let mut response = ui.interact(rect, id, Sense::click());
    if response.clicked() {
        *on = !*on;
        response.mark_changed();
    }
    if ui.is_rect_visible(rect) {
        let how_on = ui.ctx().animate_bool_responsive(response.id, *on);
        let fill = crate::theme::mix(t.toggle_off, t.positive, how_on);
        ui.painter().rect_filled(rect, rect.height() / 2.0, fill);
        let radius = rect.height() / 2.0 - 2.0;
        let x = egui::lerp((rect.left() + radius + 2.0)..=(rect.right() - radius - 2.0), how_on);
        ui.painter().circle_filled(egui::pos2(x, rect.center().y + 0.5), radius, Color32::from_black_alpha(30));
        ui.painter().circle_filled(egui::pos2(x, rect.center().y), radius, t.on_accent);
    }
    response
}

/// Add a text field with a hairline border, so it reads as a field on any surface.
pub fn bordered_field(ui: &mut Ui, edit: egui::TextEdit<'_>) -> Response {
    let t = tokens(ui);
    ui.scope(|ui| {
        let widgets = &mut ui.visuals_mut().widgets;
        widgets.inactive.bg_stroke = Stroke::new(1.0, t.separator_strong);
        widgets.hovered.bg_stroke = Stroke::new(1.0, t.label_tertiary);
        ui.add(edit.background_color(t.surface_raised))
    })
    .inner
}

/// Space between the groups of a form (a label with its field and hint), on the 4-point grid.
pub const FORM_GAP: f32 = 12.0;

/// Lay out a form: groups `FORM_GAP` apart, whatever spacing the container uses
/// (section cards stack their rows with none).
pub fn form<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> R {
    ui.scope(|ui| {
        ui.spacing_mut().item_spacing.y = FORM_GAP;
        add(ui)
    })
    .inner
}

/// A field's label, 6 points above what it labels.
pub fn labelled<R>(ui: &mut Ui, label: &str, add: impl FnOnce(&mut Ui) -> R) -> R {
    let t = tokens(ui);
    ui.scope(|ui| {
        ui.spacing_mut().item_spacing.y = 6.0;
        ui.label(RichText::new(label).size(13.0).medium().color(t.label_secondary));
        add(ui)
    })
    .inner
}

/// A labelled single-line field; `password` hides the text.
pub fn field(ui: &mut Ui, label: &str, value: &mut String, password: bool, hint: &str) -> Response {
    labelled(ui, label, |ui| {
        let edit = egui::TextEdit::singleline(value)
            .password(password)
            .hint_text(hint)
            .desired_width(f32::INFINITY)
            .margin(Margin::symmetric(10, 8));
        bordered_field(ui, edit)
    })
}

pub fn text_edit(ui: &mut Ui, value: &mut String, hint: &str, width: f32) -> Response {
    let edit = egui::TextEdit::singleline(value).hint_text(hint).desired_width(width).margin(Margin::symmetric(10, 6));
    bordered_field(ui, edit)
}

pub fn badge(ui: &mut Ui, text: &str, color: Color32) -> Response {
    let fill = crate::theme::with_alpha(color, 34);
    Frame::new()
        .fill(fill)
        .corner_radius(CornerRadius::same(RADIUS_MD))
        .inner_margin(Margin::symmetric(7, 2))
        .show(ui, |ui| ui.label(RichText::new(text).size(12.0).color(color).semibold()))
        .response
}

/// A page header: the title and a line of context. The menu beside it already
/// shows the page's icon, so the header does not repeat it.
pub fn heading(ui: &mut Ui, _icon: &str, title: &str, subtitle: &str) {
    let t = tokens(ui);
    ui.vertical(|ui| {
        ui.spacing_mut().item_spacing.y = 4.0;
        ui.label(RichText::new(title).size(24.0).semibold().color(t.label));
        if !subtitle.is_empty() {
            ui.label(RichText::new(subtitle).size(14.0).color(t.label_secondary));
        }
    });
    ui.add_space(12.0);
}

pub fn section_title(ui: &mut Ui, title: &str) {
    let t = tokens(ui);
    // Sentence case: a quiet title, not a tracked-out capital label.
    ui.add_space(6.0);
    ui.label(RichText::new(title).size(13.0).semibold().color(t.label_secondary));
    ui.add_space(2.0);
}

pub fn muted(ui: &Ui, text: impl Into<String>) -> RichText {
    RichText::new(text.into()).color(tokens(ui).label_secondary)
}

pub fn error_text(ui: &mut Ui, text: &str) {
    let t = tokens(ui);
    ui.horizontal_wrapped(|ui| {
        ui.label(RichText::new(ph::WARNING_CIRCLE).color(t.destructive_text));
        ui.label(RichText::new(text).color(t.destructive_text));
    });
}

pub fn empty_state(ui: &mut Ui, icon: &str, title: &str, body: &str) {
    let t = tokens(ui);
    ui.vertical_centered(|ui| {
        ui.add_space(48.0);
        ui.label(RichText::new(icon).size(42.0).color(t.label_quaternary));
        ui.add_space(8.0);
        ui.label(RichText::new(title).size(16.0).semibold());
        ui.label(RichText::new(body).color(t.label_secondary));
    });
}

pub fn separator(ui: &mut Ui) {
    let t = tokens(ui);
    let rect = ui.available_rect_before_wrap();
    let y = rect.top() + 4.0;
    ui.painter().hline(rect.x_range(), y, Stroke::new(1.0, t.separator));
    ui.add_space(9.0);
}

/// A thin progress bar in the accent colour.
pub fn progress_bar(ui: &mut Ui, fraction: f32, width: f32) {
    let t = tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 4.0), Sense::hover());
    ui.painter().rect_filled(rect, 2.0, t.fill_secondary);
    let mut done = rect;
    done.set_width(rect.width() * fraction.clamp(0.0, 1.0));
    ui.painter().rect_filled(done, 2.0, t.accent);
}

/// A bar for work of unknown length: a segment that sweeps across.
pub fn busy_bar(ui: &mut Ui, width: f32) {
    let t = tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 4.0), Sense::hover());
    ui.painter().rect_filled(rect, 2.0, t.fill_secondary);
    let phase = (ui.input(|i| i.time) * 0.8).fract() as f32;
    let segment = rect.width() * 0.3;
    let left = rect.left() - segment + (rect.width() + segment) * phase;
    let bar = egui::Rect::from_x_y_ranges(left.max(rect.left())..=(left + segment).min(rect.right()), rect.y_range());
    ui.painter().rect_filled(bar, 2.0, t.accent);
    ui.ctx().request_repaint();
}

/// A dialog over a dimmed backdrop, in the app's surface style.
pub fn modal(ctx: &egui::Context, id: &str) -> egui::Modal {
    let t = tokens_ctx(ctx);
    egui::Modal::new(egui::Id::unique(id)).backdrop_color(t.scrim).frame(
        Frame::new()
            .fill(t.surface)
            .stroke(Stroke::new(1.0, t.separator))
            .corner_radius(CornerRadius::same(24))
            .inner_margin(Margin::same(22))
            .shadow(egui::epaint::Shadow {
                offset: [0, 12],
                blur: 40,
                spread: 0,
                color: Color32::from_black_alpha(if t.dark { 120 } else { 45 }),
            }),
    )
}

/// Whether the last pointer input came from a touch screen: touch turns it on,
/// a mouse moving without touch turns it off, so a laptop with both follows use.
pub fn touch_mode(ctx: &egui::Context) -> bool {
    let id = egui::Id::unique("touch-mode");
    let (touched, moved) = ctx.input(|i| {
        let touched = i.raw.events.iter().any(|e| matches!(e, egui::Event::Touch { .. }));
        let moved = i.raw.events.iter().any(|e| matches!(e, egui::Event::PointerMoved(_)));
        (touched, moved)
    });
    let mut on = ctx.data(|d| d.get_temp::<bool>(id)).unwrap_or(false);
    if touched {
        on = true;
    } else if moved {
        on = false;
    }
    ctx.data_mut(|d| d.insert_temp(id, on));
    on
}

/// The phone and tablet layout (tab bar, compact header): a narrow window, or a
/// touch screen up to tablet width, as the web app decided.
pub fn is_mobile(width: f32, touch: bool) -> bool {
    width < 720.0 || (touch && width <= 1024.0)
}

/// `is_mobile` for this frame's window.
pub fn mobile(ctx: &egui::Context) -> bool {
    is_mobile(ctx.content_rect().width(), touch_mode(ctx))
}

#[cfg(test)]
mod layout_tests {
    #[test]
    fn mobile_layout_follows_width_and_touch() {
        assert!(super::is_mobile(390.0, false));
        assert!(super::is_mobile(900.0, true));
        assert!(!super::is_mobile(900.0, false), "the desktop app's narrowest window keeps the sidebar");
        assert!(!super::is_mobile(1280.0, true));
    }
}
