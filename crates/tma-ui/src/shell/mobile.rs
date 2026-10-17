//! The phone and tablet frame, as the web app had it: a compact top bar with
//! the place's title, upload and the account menu, and a tab bar at the bottom.

use egui::{Align, Align2, CornerRadius, FontId, Layout, Margin, RichText, Sense, Stroke, Vec2};

use super::{navigate, round_icon};
use crate::app::{App, Screen, Section};
use crate::files::{Action, Place, run_action};
use crate::icons::{self, ph};
use crate::theme::{self, ThemeChoice, Weight};

const TABS: [(Section, Place, &str, &str); 6] = [
    (Section::Dashboard, Place::Folder, ph::HOUSE, "Home"),
    (Section::Files, Place::Folder, ph::FOLDER_OPEN, "Files"),
    (Section::Shared, Place::Shared, ph::SHARE_NETWORK, "Shared"),
    (Section::Starred, Place::Starred, ph::STAR, "Starred"),
    (Section::Trash, Place::Trash, ph::TRASH, "Trash"),
    (Section::Settings, Place::Folder, ph::GEAR_SIX, "Settings"),
];

fn title(main: &crate::app::Main) -> String {
    match main.section {
        Section::Dashboard => "Home".into(),
        Section::Settings => "Settings".into(),
        _ => main.browser.title(),
    }
}

pub(super) fn top_bar(app: &mut App, root: &mut egui::Ui) {
    let t = app.t;
    let (mut upload, mut sign_out, mut searching, mut search) = (false, false, false, None);
    let open_id = egui::Id::unique("mobile-search");
    let Screen::Main(main) = &mut app.screen else { return };
    let search_open = root.ctx().data(|d| d.get_temp::<bool>(open_id)).unwrap_or(false);
    egui::Panel::top("mobile-header")
        .show_separator_line(false)
        .frame(egui::Frame::new().fill(t.canvas).inner_margin(Margin::symmetric(14, 8)))
        .show(root, |ui| {
            ui.horizontal(|ui| {
                let (rect, _) = ui.allocate_exact_size(Vec2::splat(24.0), Sense::hover());
                icons::logo(ui.painter(), rect, &t);
                ui.add(egui::Label::new(RichText::new(title(main)).size(17.0).semibold().color(t.label)).truncate());
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let name =
                        main.user.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| main.user.email.clone());
                    let (rect, menu) = ui.allocate_exact_size(Vec2::splat(34.0), Sense::click());
                    icons::avatar(ui.painter(), rect.center(), 14.0, &name, &t);
                    egui::Popup::menu(&menu).show(|ui| {
                        ui.set_min_width(200.0);
                        ui.label(RichText::new(&main.user.email).size(12.0).color(t.label_tertiary));
                        let (icon, label, next) = if t.dark {
                            (ph::SUN, "Light mode", ThemeChoice::Light)
                        } else {
                            (ph::MOON, "Dark mode", ThemeChoice::Dark)
                        };
                        if ui.button(format!("{icon}  {label}")).clicked() {
                            app.prefs.theme = next;
                        }
                        let out = RichText::new(format!("{}  Sign out", ph::SIGN_OUT)).color(t.destructive_text);
                        if ui.button(out).clicked() {
                            sign_out = true;
                        }
                    });
                    if main.user.can(tma_core::Permission::Upload)
                        && round_icon(ui, ph::UPLOAD_SIMPLE, "Upload").clicked()
                    {
                        upload = true;
                    }
                    if round_icon(ui, ph::MAGNIFYING_GLASS, "Search").clicked() {
                        searching = true;
                    }
                });
            });
            if search_open {
                let (_, query) =
                    crate::widgets::search_field(ui, &mut main.search, "Search files and folders", f32::INFINITY, &t);
                if query.is_some() {
                    search = query;
                }
            }
        });
    if searching {
        root.ctx().data_mut(|d| d.insert_temp(open_id, !search_open));
    }
    if let Some(q) = search {
        navigate(app, Section::Search, Place::Search(q));
    }
    if upload {
        run_action(app, Action::OpenUpload);
    }
    if sign_out {
        app.sign_out();
    }
}

pub(super) fn tab_bar(app: &mut App, root: &mut egui::Ui) {
    let t = app.t;
    let mut go = None;
    let Screen::Main(main) = &mut app.screen else { return };
    let current = main.section;
    egui::Panel::bottom("tab-bar")
        .exact_size(60.0)
        .show_separator_line(false)
        .frame(egui::Frame::new().fill(t.surface))
        .show(root, |ui| {
            let full = ui.max_rect();
            ui.painter().hline(full.x_range(), full.top() + 0.5, Stroke::new(1.0, t.separator));
            let width = full.width() / TABS.len() as f32;
            for (i, (section, place, icon, label)) in TABS.iter().enumerate() {
                let rect = egui::Rect::from_min_size(
                    egui::pos2(full.left() + width * i as f32, full.top()),
                    Vec2::new(width, full.height()),
                );
                let response = ui.interact(rect, egui::Id::unique(("tab", i)), Sense::click());
                let active = current == *section;
                let color = if active { t.accent } else { t.label_tertiary };
                if active {
                    let pill = egui::Rect::from_center_size(rect.center() - Vec2::new(0.0, 9.0), Vec2::new(44.0, 26.0));
                    ui.painter().rect_filled(pill, CornerRadius::same(13), t.accent_fill);
                }
                ui.painter().text(
                    rect.center() - Vec2::new(0.0, 9.0),
                    Align2::CENTER_CENTER,
                    *icon,
                    FontId::proportional(19.0),
                    color,
                );
                let font = FontId::new(11.0, if active { theme::semibold() } else { egui::FontFamily::Proportional });
                ui.painter().text(rect.center() + Vec2::new(0.0, 15.0), Align2::CENTER_CENTER, *label, font, color);
                if response.clicked() {
                    go = Some((*section, place.clone()));
                }
            }
        });
    if let Some((section, place)) = go {
        navigate(app, section, place);
    }
}
