//! Settings: a section list on the left and the chosen section on the right.
//! Each section loads what it shows when it opens.

mod account;
mod admin;
mod dialogs;
mod dialogs_admin;
mod integrations;
mod storage;
mod subusers;
mod updates;

pub use dialogs::show as modals;

use std::future::Future;

use egui::{Align2, CornerRadius, FontId, Margin, RichText, Sense, Stroke, Vec2};
use tma_client::rt::MaybeSend;
use tma_client::{ApiResult, Client};
use tma_core::api::*;

use crate::app::{App, Main, Screen};
use crate::host::Host;
use crate::icons::{self, ph};
use crate::tasks::Tasks;
use crate::theme::Tokens;
use crate::theme::Weight;
use crate::widgets;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Page {
    #[default]
    Profile,
    Storage,
    SubUsers,
    Administration,
    Updates,
    Security,
    Host,
}

/// Values a form edits before saving.
#[derive(Default)]
pub struct Forms {
    pub old_password: String,
    pub new_password: String,
    pub confirm_password: String,
    pub password_mfa: String,
    pub onlyoffice_url: String,
    pub onlyoffice_secret: String,
    pub share_url: String,
    pub max_upload_gb: String,
    pub proxies: String,
    pub idle_days: String,
    pub access_window: String,
    pub access_flush: String,
    pub access_enabled: bool,
    pub storage: StorageSettingsInput,
    pub storage_checks: Vec<String>,
    pub google: GoogleAuthInput,
    pub orphan_grace: String,
}

#[derive(Default)]
pub struct SettingsState {
    pub page: Page,
    pub forms: Forms,
    pub signup: Option<SignupStatus>,
    pub mfa: Option<bool>,
    pub backup_codes: Option<i64>,
    pub sessions: Option<Vec<SessionInfo>>,
    pub sub_users: Option<SubUserList>,
    pub users: Option<AdminUserPage>,
    pub clients: Option<ActiveClients>,
    pub onlyoffice: Option<OnlyOfficeSettings>,
    pub share_url: Option<UrlSetting>,
    pub max_upload: Option<MaxUploadSize>,
    pub proxies: Option<KnownProxies>,
    pub activity: Option<ActivitySettings>,
    pub cloud_drive: Option<CloudDriveConfig>,
    pub storage: Option<StorageSettingsSummary>,
    pub google: Option<GoogleAuthSummary>,
    pub versions: Option<Versions>,
    pub latest: Option<Versions>,
    pub orphans: Option<OrphanReport>,
    pub busy: Option<&'static str>,
    pub dialog: Option<dialogs::Dialog>,
}

/// Fetch with the session's client and store the result in the settings state.
pub fn fetch<T, Fut>(
    tasks: &Tasks,
    main: &Main,
    call: impl FnOnce(Client) -> Fut,
    store: impl FnOnce(&mut SettingsState, T) + MaybeSend + 'static,
) where
    T: MaybeSend + 'static,
    Fut: Future<Output = ApiResult<T>> + MaybeSend + 'static,
{
    let generation = main.generation;
    tasks.run(call(main.client.clone()), move |app, result| {
        app.finish(generation, result, |main, _, value| store(&mut main.settings, value))
    });
}

/// Save with the session's client; `done` sees the result and the toasts.
pub fn save<T, Fut>(
    tasks: &Tasks,
    main: &mut Main,
    label: &'static str,
    call: impl FnOnce(Client) -> Fut,
    done: impl FnOnce(&mut Main, &mut crate::toast::Toasts, T) + MaybeSend + 'static,
) where
    T: MaybeSend + 'static,
    Fut: Future<Output = ApiResult<T>> + MaybeSend + 'static,
{
    let generation = main.generation;
    main.settings.busy = Some(label);
    tasks.run(call(main.client.clone()), move |app, result: ApiResult<T>| {
        if let Some(main) = app.main_mut(generation) {
            main.settings.busy = None;
        }
        app.finish(generation, result, done);
    });
}

/// Load what the current page needs.
pub fn opened(main: &mut Main, tasks: &Tasks) {
    match main.settings.page {
        Page::Profile => fetch(tasks, main, |c| async move { c.mfa_status().await }, |s, v| s.mfa = Some(v.enabled)),
        Page::Storage => storage::load(main, tasks),
        Page::SubUsers => fetch(tasks, main, |c| async move { c.sub_users().await }, |s, v| s.sub_users = Some(v)),
        Page::Administration => admin::load(main, tasks),
        Page::Updates => updates::load(main, tasks),
        Page::Security => account::load_security(main, tasks),
        Page::Host => {}
    }
}

fn nav_row(ui: &mut egui::Ui, icon: &str, label: &str, active: bool) -> bool {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::click());
    let fill = if active {
        t.accent_fill
    } else if response.hovered() {
        t.fill_quaternary
    } else {
        egui::Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, CornerRadius::same(10), fill);
    let (icon_color, text_color) = if active { (t.accent, t.accent) } else { (t.label_tertiary, t.label_secondary) };
    ui.painter().text(
        rect.left_center() + Vec2::new(19.0, 0.0),
        Align2::CENTER_CENTER,
        icon,
        FontId::proportional(17.0),
        icon_color,
    );
    let font = FontId::new(13.0, if active { crate::theme::semibold() } else { egui::FontFamily::Proportional });
    ui.painter().text(rect.left_center() + Vec2::new(37.0, 0.0), Align2::LEFT_CENTER, label, font, text_color);
    if active {
        ui.painter().circle_filled(rect.right_center() - Vec2::new(12.0, 0.0), 2.5, t.accent);
    }
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    response.clicked()
}

pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let t = app.t;
    let host_title = app.host.settings_title();
    let Screen::Main(main) = &mut app.screen else { return };
    let mut pages = vec![(Page::Profile, ph::USER, "Profile"), (Page::Storage, ph::HARD_DRIVES, "Storage")];
    if !main.user.is_sub_user {
        pages.push((Page::SubUsers, ph::USERS, "Sub-users"));
    }
    if main.instance.is_first_user {
        pages.push((Page::Administration, ph::GEAR_SIX, "Administration"));
    }
    pages.push((Page::Updates, ph::ARROWS_CLOCKWISE, "Updates"));
    pages.push((Page::Security, ph::SHIELD, "Security"));
    if let Some(title) = host_title {
        pages.push((Page::Host, ph::DESKTOP, title));
    }
    let mut switch = None;
    if ui.available_width() < NARROW_BELOW {
        // A menu above the page instead of beside it, so the page keeps the whole width.
        let current = pages.iter().find(|p| p.0 == main.settings.page).map_or("Settings", |p| p.2);
        egui::ComboBox::from_id_salt("settings-menu").selected_text(current).width(220.0).show_ui(ui, |ui| {
            for (page, icon, label) in &pages {
                if ui.selectable_label(main.settings.page == *page, format!("{icon}  {label}")).clicked() {
                    switch = Some(*page);
                }
            }
        });
        ui.add_space(10.0);
        egui::ScrollArea::vertical().id_salt("settings-page").auto_shrink([false, false]).show(ui, |ui| {
            page_body(main, &mut *app.host, &app.tasks, ui);
        });
    } else {
        side_menu_layout(main, ui, &pages, &mut switch, &mut *app.host, &app.tasks, t);
    }
    if let Some(page) = switch
        && let Screen::Main(main) = &mut app.screen
    {
        main.settings.page = page;
        opened(main, &app.tasks);
    }
}

/// The settings menu as a column beside the page, when there is room for both.
fn side_menu_layout(
    main: &mut Main,
    ui: &mut egui::Ui,
    pages: &[(Page, &str, &str)],
    switch: &mut Option<Page>,
    host: &mut dyn Host,
    tasks: &Tasks,
    t: Tokens,
) {
    const MENU: f32 = 234.0;
    let height = ui.available_height();
    let outer =
        egui::Frame::new().fill(t.surface).stroke(Stroke::new(1.0, t.separator)).corner_radius(CornerRadius::same(18));
    outer.show(ui, |ui| {
        ui.set_min_size(egui::vec2(ui.available_width(), height - 2.0));
        let card = ui.max_rect();
        // The menu column is a lighter panel along the card's left edge.
        let column = egui::Rect::from_min_size(card.min, egui::vec2(MENU, card.height()));
        ui.painter().rect_filled(column, CornerRadius { nw: 18, sw: 18, ne: 0, se: 0 }, t.surface_raised);
        ui.painter().vline(column.right(), column.y_range(), Stroke::new(1.0, t.separator));
        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing = egui::vec2(0.0, 0.0);
            ui.allocate_ui_with_layout(
                egui::vec2(MENU, height - 2.0),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    ui.set_width(MENU);
                    menu_column(main, ui, pages, switch, &t, height - 2.0);
                },
            );
            let width = (ui.available_width() - 64.0).min(860.0);
            ui.allocate_ui_with_layout(
                egui::vec2(ui.available_width(), height - 2.0),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    egui::ScrollArea::vertical().id_salt("settings-page").auto_shrink([false, false]).show(ui, |ui| {
                        egui::Frame::new().inner_margin(Margin { left: 32, right: 32, top: 28, bottom: 28 }).show(
                            ui,
                            |ui| {
                                ui.set_width(width);
                                ui.spacing_mut().item_spacing = egui::vec2(8.0, 8.0);
                                page_body(main, host, tasks, ui);
                            },
                        );
                    });
                },
            );
        });
    });
}

fn hairline(ui: &mut egui::Ui, t: &Tokens) {
    let rect = ui.available_rect_before_wrap();
    ui.painter().hline(rect.x_range(), rect.top(), Stroke::new(1.0, t.separator));
}

fn menu_column(
    main: &Main,
    ui: &mut egui::Ui,
    pages: &[(Page, &str, &str)],
    switch: &mut Option<Page>,
    t: &Tokens,
    height: f32,
) {
    let top = ui.cursor().top();
    egui::Frame::new().inner_margin(Margin { left: 16, right: 16, top: 22, bottom: 12 }).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 4.0;
        ui.label(RichText::new("CONTROL CENTER").size(10.5).semibold().extra_letter_spacing(3.5).color(t.accent));
        ui.label(RichText::new("Settings").size(20.0).bold().color(t.label));
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            let name = main.user.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| main.user.email.clone());
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(26.0), Sense::hover());
            icons::avatar(ui.painter(), rect.center(), 13.0, &name, t);
            ui.add_space(6.0);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                ui.add(egui::Label::new(RichText::new(name).size(12.0).semibold().color(t.label)).truncate());
                ui.add(egui::Label::new(RichText::new(&main.user.email).size(11.0).color(t.label_tertiary)).truncate());
            });
        });
    });
    hairline(ui, t);
    if let Some(usage) = main.instance.usage {
        egui::Frame::new().inner_margin(Margin::symmetric(16, 12)).show(ui, |ui| {
            let total = usage.total.filter(|t| *t > 0);
            let used = tma_core::format::storage_size(usage.used);
            let of = total.map(tma_core::format::storage_size).unwrap_or_else(|| "Unlimited".into());
            ui.horizontal(|ui| {
                ui.label(RichText::new("Storage").size(11.0).semibold().color(t.label));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(RichText::new(format!("{used} of {of}")).size(11.0).color(t.label_secondary));
                });
            });
            ui.add_space(4.0);
            let fraction = total.map(|t| usage.used as f32 / t as f32).unwrap_or(0.0);
            widgets::progress_bar(ui, fraction, ui.available_width());
        });
        hairline(ui, t);
    }
    egui::Frame::new().inner_margin(Margin::symmetric(10, 10)).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 2.0;
        for (page, icon, label) in pages {
            if nav_row(ui, icon, label, main.settings.page == *page) {
                *switch = Some(*page);
            }
        }
    });
    // A short note pinned to the bottom of the column.
    let used = ui.cursor().top() - top;
    ui.add_space((height - used - 62.0).max(8.0));
    hairline(ui, t);
    egui::Frame::new().inner_margin(Margin::symmetric(16, 12)).show(ui, |ui| {
        ui.label(RichText::new("Manage your preferences and application controls").size(11.5).color(t.label_tertiary));
    });
}

/// Below this width the settings menu moves above the page.
const NARROW_BELOW: f32 = 640.0;

fn page_body(main: &mut Main, host: &mut dyn Host, tasks: &Tasks, ui: &mut egui::Ui) {
    match main.settings.page {
        Page::Profile => account::profile(main, ui, tasks),
        Page::Storage => storage::show(main, ui, tasks),
        Page::SubUsers => subusers::show(main, ui, tasks),
        Page::Administration => {
            admin::show(main, ui, tasks);
            ui.add_space(12.0);
            integrations::show(main, ui, tasks);
        }
        Page::Updates => updates::show(main, ui, tasks, host.app_version()),
        Page::Security => account::security(main, ui, tasks),
        Page::Host => {
            let client = main.client.clone();
            host.settings_ui(ui, &client, tasks);
        }
    }
}

pub use crate::widgets::section;
