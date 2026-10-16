//! The signed-in frame: sidebar, header (search, upload, account) and the
//! section in the middle, plus dropped files, transfers and dialogs.

use egui::{Align, Align2, Color32, CornerRadius, FontId, Layout, Margin, RichText, Sense, Stroke, Vec2};

use crate::app::{App, Screen, Section};
use crate::files::{Action, Place, run_action};
use crate::icons::{self, ph};
use crate::theme::{self, ThemeChoice, Weight};
use crate::widgets;

/// Switch section, opening its listing.
pub fn navigate(app: &mut App, section: Section, place: Place) {
    let prefs = app.prefs.clone();
    let Screen::Main(main) = &mut app.screen else { return };
    main.section = section;
    let (client, generation) = (main.client.clone(), main.generation);
    match section {
        Section::Files | Section::Shared | Section::Starred | Section::Trash | Section::Search => {
            main.browser.open(place, Vec::new(), &app.tasks, &client, generation, &prefs);
        }
        Section::Dashboard => crate::dashboard::load(&app.tasks, &client, generation),
        Section::Settings => crate::settings::opened(main, &app.tasks),
    }
}

const SIDEBAR_WIDTH: f32 = 208.0;

/// A sidebar row: the active one is tinted and set in the accent colour.
fn nav_item(ui: &mut egui::Ui, icon: &str, label: &str, active: bool) -> bool {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 36.0), Sense::click());
    let fill = if active {
        t.accent_fill
    } else if response.hovered() {
        t.fill_quaternary
    } else {
        Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, CornerRadius::same(10), fill);
    let (icon_color, text_color) = if active {
        (t.accent, t.accent)
    } else if response.hovered() {
        (t.label_tertiary, t.label)
    } else {
        (t.label_tertiary, t.label_secondary)
    };
    ui.painter().text(
        rect.left_center() + Vec2::new(19.0, 0.0),
        Align2::CENTER_CENTER,
        icon,
        FontId::proportional(18.0),
        icon_color,
    );
    let font = FontId::new(14.0, if active { theme::semibold() } else { egui::FontFamily::Proportional });
    ui.painter().text(rect.left_center() + Vec2::new(38.0, 0.0), Align2::LEFT_CENTER, label, font, text_color);
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    response.clicked()
}

fn sidebar(app: &mut App, root: &mut egui::Ui) {
    let t = app.t;
    let mut go = None;
    let Screen::Main(main) = &mut app.screen else { return };
    egui::Panel::left("sidebar")
        .exact_size(SIDEBAR_WIDTH)
        .resizable(false)
        .show_separator_line(false)
        .frame(egui::Frame::new().fill(t.canvas))
        .show(root, |ui| {
            // A hairline on the right edge only, as in the web app.
            let edge = ui.max_rect();
            ui.painter().vline(edge.right() - 0.5, edge.y_range(), Stroke::new(1.0, t.separator));
            ui.spacing_mut().item_spacing.y = 0.0;
            egui::Frame::new().inner_margin(Margin::symmetric(13, 13)).show(ui, |ui| {
                ui.horizontal(|ui| {
                    let (rect, _) = ui.allocate_exact_size(Vec2::splat(26.0), Sense::hover());
                    icons::logo(ui.painter(), rect, &t);
                    ui.add_space(2.0);
                    ui.label(RichText::new("TMA Cloud").size(17.0).semibold().color(t.label));
                });
            });
            let section = main.section;
            egui::Frame::new().inner_margin(Margin::symmetric(10, 0)).show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                for (sec, place, icon, label) in [
                    (Section::Dashboard, Place::Folder, ph::HOUSE, "Dashboard"),
                    (Section::Files, Place::Folder, ph::FOLDER_OPEN, "My Files"),
                    (Section::Shared, Place::Shared, ph::SHARE_NETWORK, "Shared"),
                    (Section::Starred, Place::Starred, ph::STAR, "Starred"),
                    (Section::Trash, Place::Trash, ph::TRASH, "Trash"),
                ] {
                    if nav_item(ui, icon, label, section == sec) {
                        go = Some((sec, place));
                    }
                }
            });
            ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
                egui::Frame::new().inner_margin(Margin::same(10)).show(ui, |ui| {
                    if nav_item(ui, ph::GEAR_SIX, "Settings", section == Section::Settings) {
                        go = Some((Section::Settings, Place::Folder));
                    }
                });
                let line = ui.available_rect_before_wrap();
                ui.painter().hline(line.x_range(), line.bottom(), Stroke::new(1.0, t.separator));
            });
        });
    if let Some((section, place)) = go {
        navigate(app, section, place);
    }
}

/// A round, borderless icon button for the header.
fn round_icon(ui: &mut egui::Ui, icon: &str, tip: &str) -> egui::Response {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::click());
    if response.hovered() {
        ui.painter().circle_filled(rect.center(), 16.0, t.fill_quaternary);
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let color = if response.hovered() { t.label } else { t.label_secondary };
    ui.painter().text(rect.center(), Align2::CENTER_CENTER, icon, FontId::proportional(18.0), color);
    response.on_hover_text(tip)
}

/// The accent pill used for the main action of a screen.
pub fn pill_button(ui: &mut egui::Ui, icon: &str, label: &str) -> egui::Response {
    let t = widgets::tokens(ui);
    let text = format!("{icon}  {label}");
    let galley = ui.painter().layout_no_wrap(text, FontId::new(14.0, theme::semibold()), Color32::WHITE);
    let size = Vec2::new(galley.size().x + 30.0, 32.0);
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    let fill = if response.hovered() { t.accent_hover } else { t.accent };
    ui.painter().rect_filled(rect, CornerRadius::same(16), fill);
    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, Color32::WHITE);
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    response
}

fn header(app: &mut App, root: &mut egui::Ui) {
    let t = app.t;
    let mut search = None;
    let mut sign_out = false;
    let mut upload = None;
    let desktop = app.host.kind() == crate::host::HostKind::Desktop;
    let Screen::Main(main) = &mut app.screen else { return };
    egui::Panel::top("header")
        .exact_size(52.0)
        .show_separator_line(false)
        .frame(egui::Frame::new().fill(t.canvas).inner_margin(Margin::symmetric(20, 10)))
        .show(root, |ui| {
            ui.horizontal_centered(|ui| {
                let menu_tip = if app.prefs.sidebar_hidden { "Show sidebar" } else { "Hide sidebar" };
                if round_icon(ui, ph::LIST, menu_tip).clicked() {
                    app.prefs.sidebar_hidden = !app.prefs.sidebar_hidden;
                }
                ui.add_space(4.0);
                let r = ui.add(
                    egui::TextEdit::singleline(&mut main.search)
                        .hint_text(format!("{}  Search files and folders", ph::MAGNIFYING_GLASS))
                        .desired_width(ui.available_width().clamp(160.0, 320.0) - 60.0)
                        .frame(
                            egui::Frame::new()
                                .fill(t.fill_quaternary)
                                .corner_radius(CornerRadius::same(18))
                                .inner_margin(Margin::symmetric(14, 8)),
                        ),
                );
                if r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) && !main.search.trim().is_empty() {
                    search = Some(main.search.trim().to_string());
                }
                if ui.input_mut(|i| i.consume_key(egui::Modifiers::COMMAND, egui::Key::K)) {
                    r.request_focus();
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let name =
                        main.user.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| main.user.email.clone());
                    let (rect, menu) = ui.allocate_exact_size(Vec2::new(170.0, 36.0), Sense::click());
                    if menu.hovered() {
                        ui.painter().rect_filled(rect, CornerRadius::same(18), t.fill_quaternary);
                    }
                    icons::avatar(ui.painter(), rect.left_center() + Vec2::new(17.0, 0.0), 13.0, &name, &t);
                    let text = ui.painter().with_clip_rect(rect.shrink2(Vec2::new(20.0, 0.0)));
                    text.text(
                        rect.left_center() + Vec2::new(36.0, -7.0),
                        Align2::LEFT_CENTER,
                        &name,
                        FontId::new(12.0, theme::semibold()),
                        t.label,
                    );
                    text.text(
                        rect.left_center() + Vec2::new(36.0, 8.0),
                        Align2::LEFT_CENTER,
                        &main.user.email,
                        FontId::proportional(11.0),
                        t.label_tertiary,
                    );
                    ui.painter().text(
                        rect.right_center() - Vec2::new(10.0, 0.0),
                        Align2::CENTER_CENTER,
                        ph::CARET_DOWN,
                        FontId::proportional(12.0),
                        t.label_tertiary,
                    );
                    egui::Popup::menu(&menu).show(|ui| {
                        ui.set_min_width(180.0);
                        let sign = egui::Button::new(
                            RichText::new(format!("{}  Sign out", ph::SIGN_OUT)).size(14.0).color(t.destructive_text),
                        )
                        .frame(false)
                        .min_size(Vec2::new(ui.available_width(), 32.0));
                        if ui.add(sign).clicked() {
                            sign_out = true;
                        }
                    });
                    if main.user.can(tma_core::Permission::Upload) {
                        ui.add_space(4.0);
                        let pill = pill_button(ui, ph::UPLOAD_SIMPLE, "Upload");
                        // Browsers cannot pick folders here, so only the desktop app asks which.
                        if desktop {
                            egui::Popup::menu(&pill).show(|ui| {
                                ui.set_min_width(170.0);
                                if ui.button(format!("{}  Upload files", ph::FILE)).clicked() {
                                    upload = Some(Action::PickUpload);
                                }
                                if ui.button(format!("{}  Upload folder", ph::FOLDER)).clicked() {
                                    upload = Some(Action::PickFolder);
                                }
                            });
                        } else if pill.clicked() {
                            upload = Some(Action::PickUpload);
                        }
                    }
                    ui.add_space(4.0);
                    let (icon, tip, next) = if t.dark {
                        (ph::SUN, "Light mode", ThemeChoice::Light)
                    } else {
                        (ph::MOON, "Dark mode", ThemeChoice::Dark)
                    };
                    if round_icon(ui, icon, tip).clicked() {
                        app.prefs.theme = next;
                    }
                    app.host.header_status(ui);
                });
            });
        });
    if let Some(q) = search {
        navigate(app, Section::Search, Place::Search(q));
    }
    if let Some(action) = upload {
        run_action(app, action);
    }
    if sign_out {
        app.sign_out();
    }
}

fn storage_banner(app: &App, ui: &mut egui::Ui) {
    let Screen::Main(main) = &app.screen else { return };
    if main.instance.storage_configured || main.instance.max_upload == 0 && !main.instance.is_first_user {
        return;
    }
    let t = app.t;
    egui::Frame::new()
        .fill(t.warning.gamma_multiply(0.15))
        .corner_radius(10)
        .inner_margin(Margin::symmetric(12, 8))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new(ph::WARNING).color(t.warning_text));
                let text = if main.instance.is_first_user {
                    "Storage is not set up yet. Connect a bucket in Settings > Storage to upload files."
                } else {
                    "Storage is not set up yet. Ask the administrator to connect a storage bucket."
                };
                ui.label(RichText::new(text).color(t.warning_text));
            });
        });
    ui.add_space(8.0);
}

pub fn show(app: &mut App, root: &mut egui::Ui) {
    let ctx = &root.ctx().clone();
    if !app.prefs.sidebar_hidden {
        sidebar(app, root);
    }
    header(app, root);
    let dropped = ctx.input(|i| i.raw.dropped_files.clone());
    if !dropped.is_empty() {
        app.tasks.run(crate::platform::dropped(dropped), crate::files::upload_files);
    }
    let hovering_files = ctx.input(|i| !i.raw.hovered_files.is_empty());
    let t = app.t;
    egui::CentralPanel::default()
        .frame(egui::Frame::new().fill(t.canvas).inner_margin(Margin { left: 26, right: 26, top: 28, bottom: 12 }))
        .show(root, |ui| {
            storage_banner(app, ui);
            let section = match &app.screen {
                Screen::Main(main) => main.section,
                _ => return,
            };
            match section {
                Section::Dashboard => crate::dashboard::show(app, ui),
                Section::Settings => crate::settings::show(app, ui),
                _ => crate::files::show(app, ui),
            }
            if hovering_files {
                let rect = ui.max_rect();
                ui.painter().rect(
                    rect,
                    CornerRadius::same(16),
                    t.accent_fill,
                    Stroke::new(2.0, t.accent),
                    egui::StrokeKind::Inside,
                );
                ui.painter().text(
                    rect.center(),
                    Align2::CENTER_CENTER,
                    format!("{}  Drop to upload", ph::UPLOAD_SIMPLE),
                    FontId::proportional(18.0),
                    t.accent,
                );
            }
        });
    let Screen::Main(main) = &mut app.screen else { return };
    crate::transfers::pump(main, &app.tasks);
    crate::transfers::show(main, ctx);
    crate::modals::show(app, ctx);
    crate::settings::modals(app, ctx);
}
