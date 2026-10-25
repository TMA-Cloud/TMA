//! Drawing the listing as rows or tiles, with selection, the context menu,
//! dragging items onto folders and keyboard shortcuts.

use egui::{Align2, CornerRadius, FontId, Id, Modifiers, Rect, Sense, Stroke, Ui, Vec2};
use tma_core::api::FileItem;

use super::Place;
use super::actions::{Action, run};
use crate::app::{App, Main};
use crate::host::HostKind;
use crate::icons::{self, ph};
use crate::theme::Tokens;
use crate::widgets;

/// Two-line rows as in the web app: name above, size and date below.
const ROW_HEIGHT: f32 = 52.0;
const ROW_GAP: f32 = 4.0;
pub(super) const TILE: Vec2 = Vec2::new(156.0, 116.0);

/// Ids being dragged between rows.
#[derive(Clone)]
struct DragIds(Vec<String>);

pub fn show(app: &mut App, ui: &mut Ui) {
    let mut actions = Vec::new();
    let desktop = app.host.kind() == HostKind::Desktop;
    let t = app.t;
    let prefs = app.prefs.clone();
    let ctx = ui.ctx().clone();
    let system_clip = app.host.clipboard_has_files();
    let crate::app::Screen::Main(main) = &mut app.screen else { return };
    main.browser.system_clip = system_clip;
    super::toolbar::show(main, ui, &prefs, &mut actions);
    ui.add_space(8.0);
    super::keys::handle(main, ui, &mut actions);
    if let Some(err) = main.browser.error.clone().filter(|_| main.browser.items.is_empty()) {
        widgets::empty_state(ui, ph::WARNING_CIRCLE, "Could not load this folder", &err);
    } else if !main.browser.loaded {
        skeleton(ui, &t);
    } else if main.browser.items.is_empty() {
        let (icon, title, body) = match &main.browser.place {
            Place::Folder => (ph::FOLDER_OPEN, "This folder is empty", "Drop files here or use Upload."),
            Place::Starred => (ph::STAR, "No starred items", "Star files to find them quickly here."),
            Place::Shared => (ph::SHARE_NETWORK, "Nothing shared yet", "Shared files and folders appear here."),
            Place::Trash => (ph::TRASH, "Trash is empty", "Deleted items stay here for 15 days."),
            Place::Search(_) => (ph::MAGNIFYING_GLASS, "No results", "Try a different name."),
        };
        let area = ui.available_rect_before_wrap();
        widgets::empty_state(ui, icon, title, body);
        ui.interact(area, Id::unique("empty-listing"), Sense::click())
            .context_menu(|ui| super::menu::background_menu(main, ui, &mut actions));
    } else if prefs.grid_view {
        super::grid::grid(main, ui, &t, desktop, &mut actions);
    } else {
        list(main, ui, &t, desktop, &mut actions);
    }
    super::thumbs::pump(app);
    super::conflicts::show(app, &ctx);
    for action in actions {
        run(app, action);
    }
}

fn skeleton(ui: &mut Ui, t: &Tokens) {
    for i in 0..8 {
        let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_HEIGHT), Sense::hover());
        let alpha = 1.0 - i as f32 * 0.1;
        ui.painter().rect_filled(
            Rect::from_min_size(rect.min + Vec2::new(12.0, 10.0), Vec2::splat(20.0)),
            4.0,
            t.fill_tertiary.gamma_multiply(alpha),
        );
        ui.painter().rect_filled(
            Rect::from_min_size(rect.min + Vec2::new(44.0, 14.0), Vec2::new(rect.width() * 0.35, 12.0)),
            4.0,
            t.fill_tertiary.gamma_multiply(alpha),
        );
    }
}

/// Click, Ctrl/Cmd-click and Shift-click selection.
fn click_select(main: &mut Main, id: &str, modifiers: Modifiers) {
    let b = &mut main.browser;
    if modifiers.command {
        if !b.selected.remove(id) {
            b.selected.insert(id.to_string());
        }
        b.anchor = Some(id.to_string());
    } else if modifiers.shift
        && let Some(anchor) = b.anchor.clone()
    {
        let a = b.items.iter().position(|i| i.id == anchor);
        let z = b.items.iter().position(|i| i.id == id);
        if let (Some(a), Some(z)) = (a, z) {
            b.selected = b.items[a.min(z)..=a.max(z)].iter().map(|i| i.id.clone()).collect();
        }
    } else {
        b.select_only(id);
    }
}

/// Selection, drag and drop, and the context menu for one row or tile.
/// An item's surface: the whole `rect` selects and opens; dragging `grab` (its icon
/// and name) moves it, while a drag elsewhere on the row draws a selection band, as
/// in Finder and Explorer.
pub(super) fn interact(
    main: &mut Main,
    ui: &mut Ui,
    rect: Rect,
    grab: Rect,
    item: &FileItem,
    desktop: bool,
    actions: &mut Vec<Action>,
) -> egui::Response {
    // Not focusable: the listing handles the keyboard itself, so egui must not move focus between rows.
    // On touch a drag scrolls, so rows only take taps (and long presses, for the menu).
    let touch = crate::widgets::touch_mode(ui.ctx());
    let row = ui.interact(rect, Id::unique(("item", &item.id)), Sense::CLICK);
    let response = if touch {
        row
    } else {
        // Registered after the row, so it wins where they overlap.
        row.union(ui.interact(grab.intersect(rect), Id::unique(("grab", &item.id)), Sense::CLICK | Sense::DRAG))
    };
    // Rows are surfaces, not buttons: the arrow over them, a closed hand while dragging items.
    if response.dragged() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::Grabbing);
    } else if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::Default);
    }
    if touch && response.clicked() {
        // A tap opens, as on any phone; in selection mode it adds or removes the item.
        if main.browser.select_mode {
            if !main.browser.selected.remove(&item.id) {
                main.browser.selected.insert(item.id.clone());
            }
        } else {
            actions.push(Action::Open(item.clone()));
        }
    } else if response.clicked() {
        let modifiers = ui.input(|i| i.modifiers);
        click_select(main, &item.id, modifiers);
    }
    if !touch && response.double_clicked() {
        actions.push(Action::Open(item.clone()));
    }
    if response.secondary_clicked() && !main.browser.selected.contains(&item.id) {
        main.browser.select_only(&item.id);
    }
    let trash = main.browser.place == Place::Trash;
    if !trash && response.drag_started() {
        if !main.browser.selected.contains(&item.id) {
            main.browser.select_only(&item.id);
        }
        response.dnd_set_drag_payload(DragIds(main.browser.selected.iter().cloned().collect()));
    }
    if item.is_folder() && !trash {
        if let Some(payload) = response.dnd_hover_payload::<DragIds>()
            && !payload.0.contains(&item.id)
        {
            main.browser.drop_target = Some(item.id.clone());
        }
        if let Some(payload) = response.dnd_release_payload::<DragIds>()
            && !payload.0.contains(&item.id)
        {
            actions.push(Action::DropOnto(payload.0.clone(), item.id.clone()));
        }
    }
    let selection = main.browser.selected_items();
    response.context_menu(|ui| super::menu::context_menu(main, ui, &selection, desktop, actions));
    response
}

/// When the item was shared and how long its link lasts, on hovering the link badge.
pub(super) fn share_tip(ui: &Ui, item: &FileItem, badge: Rect, now: chrono::DateTime<chrono::Utc>) {
    let hovered = ui.rect_contains_pointer(badge.expand(3.0));
    if hovered {
        let since = item.shared_at.map(|at| format!("Shared {}", tma_core::format::full_date(at)));
        let left = tma_core::format::share_remaining(item.expires_at, now);
        let tip = [since.unwrap_or_else(|| "Shared".into()), left].join(" · ");
        egui::Tooltip::always_open(
            ui.ctx().clone(),
            ui.layer_id(),
            Id::unique(("share-tip", &item.id)),
            egui::PopupAnchor::Pointer,
        )
        .show(|ui| ui.label(tip));
    }
}

pub(super) fn name_label(main: &Main, item: &FileItem) -> String {
    tma_core::names::display_name(&item.name, !item.is_folder(), main.instance.hide_extensions).to_string()
}

/// Row background: drop target, selected (tinted with a hairline ring), hovered.
pub(super) fn paint_item_fill(
    ui: &Ui,
    main: &Main,
    item: &FileItem,
    rect: Rect,
    hovered: bool,
    radius: u8,
    t: &Tokens,
) {
    let selected = main.browser.selected.contains(&item.id);
    let target = main.browser.drop_target.as_deref() == Some(item.id.as_str());
    let (fill, stroke) = if target {
        (t.accent_fill_strong, Stroke::new(1.0, t.accent))
    } else if selected {
        (t.accent_fill, Stroke::new(1.0, t.accent.gamma_multiply(0.45)))
    } else if hovered {
        (t.fill_quaternary, Stroke::NONE)
    } else {
        return;
    };
    ui.painter().rect(rect, CornerRadius::same(radius), fill, stroke, egui::StrokeKind::Inside);
}

/// "35.9 KB · Sep 24": size for files, then the modified (or deleted) date.
pub(super) fn meta_line(main: &Main, item: &FileItem, now: chrono::DateTime<chrono::Utc>) -> String {
    let date =
        if main.browser.place == Place::Trash { item.deleted_at.unwrap_or(item.modified) } else { item.modified };
    let date = tma_core::format::relative_date(date, now);
    let line = match item.size.filter(|_| !item.is_folder()) {
        Some(size) => format!("{}  ·  {date}", tma_core::format::file_size(size)),
        None => date,
    };
    match super::editing_note(item, &main.user.id) {
        Some(note) => format!("{line}  ·  {note}"),
        None => line,
    }
}

fn list(main: &mut Main, ui: &mut Ui, t: &Tokens, desktop: bool, actions: &mut Vec<Action>) {
    let width = ui.available_width();
    main.browser.drop_target = None;
    let now = chrono::Utc::now();
    let count = main.browser.items.len();
    let more = main.browser.cursor.is_some();
    // Dragging on empty space draws a selection band rather than scrolling.
    let mut area =
        egui::ScrollArea::vertical().auto_shrink([false, false]).scroll_source(super::marquee::scroll_source(ui.ctx()));
    ui.spacing_mut().item_spacing.y = ROW_GAP;
    let pitch = ROW_HEIGHT + ROW_GAP;
    // Keyboard moves bring their row to the middle of the view.
    if let Some(index) = main.browser.scroll_to.take() {
        area = area.vertical_scroll_offset((index as f32 * pitch - ui.available_height() / 2.0).max(0.0));
    }
    if let Some(offset) = main.browser.scroll_set.take() {
        area = area.vertical_scroll_offset(offset);
    }
    let output = area.show_rows(ui, ROW_HEIGHT, count + usize::from(more), |ui, range| {
        let background = super::marquee::background(ui);
        let origin = egui::pos2(ui.max_rect().left(), ui.max_rect().top() - range.start as f32 * pitch);
        let layout = super::marquee::Layout::Rows { pitch, height: ROW_HEIGHT, width };
        for index in range {
            let Some(item) = main.browser.items.get(index).cloned() else {
                actions.push(Action::LoadMore);
                ui.add_space(ROW_HEIGHT);
                continue;
            };
            let (rect, _) = ui.allocate_exact_size(Vec2::new(width, ROW_HEIGHT), Sense::hover());
            let text_left = rect.min.x + 50.0;
            let label = name_label(main, &item);
            let galley = ui.painter().layout_no_wrap(label, FontId::new(15.0, crate::theme::semibold()), t.label);
            let name_width = galley.size().x;
            // The icon and name move the item; the rest of the row starts a selection band.
            let grab = Rect::from_min_max(rect.min, egui::pos2(text_left + name_width + 8.0, rect.max.y));
            let response = interact(main, ui, rect, grab, &item, desktop, actions);
            paint_item_fill(ui, main, &item, rect, response.hovered(), 12, t);
            let opening = super::opening::look(ui.ctx(), &item.id);
            let icon_rect = Rect::from_center_size(rect.left_center() + Vec2::new(25.0, 0.0), Vec2::splat(29.0));
            super::opening::paint(ui.painter(), rect, 12, icon_rect, opening, t);
            let icon_rect = super::opening::icon_rect(icon_rect, opening);
            if item.is_folder() {
                icons::folder(ui.painter(), icon_rect, t, false);
            } else {
                icons::file(ui.painter(), icon_rect, t, &item.name, item.mime_type.as_deref());
            }
            let name_rect =
                Rect::from_min_max(egui::pos2(text_left, rect.min.y), egui::pos2(rect.max.x - 12.0, rect.max.y));
            let painter = ui.painter().with_clip_rect(name_rect);
            painter.galley(egui::pos2(text_left, rect.center().y - 20.0), galley, t.label);
            let mut x = text_left + name_width + 6.0;
            for (show, icon, color) in [
                (item.starred, egui_phosphor::fill::STAR, t.warning),
                (super::is_shared(&item), ph::LINK, t.accent),
                (super::editor(&item, &main.user.id).is_some(), ph::PENCIL_SIMPLE, t.warning),
            ] {
                if show {
                    let badge = painter.text(
                        egui::pos2(x, rect.center().y - 10.0),
                        Align2::LEFT_CENTER,
                        icon,
                        FontId::proportional(13.0),
                        color,
                    );
                    if icon == ph::LINK {
                        share_tip(ui, &item, badge, now);
                    }
                    x += 16.0;
                }
            }
            painter.text(
                egui::pos2(text_left, rect.center().y + 11.0),
                Align2::LEFT_CENTER,
                meta_line(main, &item, now),
                FontId::proportional(13.0),
                t.label_tertiary,
            );
        }
        super::marquee::update(main, ui, &background, origin, layout, t);
        background.context_menu(|ui| super::menu::background_menu(main, ui, actions));
    });
    main.browser.scroll = output.state.clamped_offset().y;
}
