//! Settings: a section list on the left and the chosen section on the right.
//! Each section loads what it shows when it opens.

mod account;
mod admin;
mod admin_activity;
mod bucket_form;
mod dialogs;
mod dialogs_admin;
mod forms;
mod integrations;
mod mfa;
mod orphans;
mod parts;
mod storage;
mod subusers;
pub(crate) mod updates;

pub use dialogs::show as modals;

use std::collections::BTreeSet;
use std::future::Future;

use egui::{Align2, CornerRadius, FontId, Margin, RichText, Sense, Stroke, Vec2};
use tma_client::rt::MaybeSend;
use tma_client::{ApiResult, Client};
use tma_core::api::*;

use crate::app::{App, Main, Screen};
use crate::host::Host;
use crate::icons::ph;
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
    pub onlyoffice_url: String,
    pub onlyoffice_secret: String,
    pub share_url: String,
    pub max_upload: String,
    pub max_upload_unit: forms::Unit,
    pub proxies: String,
    pub idle_days: String,
    pub access_window: String,
    pub access_flush: String,
    pub access_enabled: bool,
    pub bucket: bucket_form::BucketForm,
    pub bucket_result: Option<bucket_form::CheckResult>,
    pub google: GoogleAuthInput,
    pub google_secret: String,
}

/// A storage limit being edited in the user list.
pub struct LimitEdit {
    pub user_id: String,
    pub value: String,
    pub unit: forms::Unit,
}

#[derive(Default)]
pub struct SettingsState {
    pub page: Page,
    pub forms: Forms,
    /// Configuration cards that are expanded, by key.
    pub open: BTreeSet<&'static str>,
    pub signup: Option<SignupStatus>,
    pub mfa: Option<bool>,
    pub backup_codes: Option<i64>,
    /// When backup codes may be regenerated again (egui time, seconds).
    pub regenerate_after: Option<f64>,
    pub regenerate_from_now: Option<f64>,
    /// Backup codes to save as a file on the next frame (the browser downloads them at once).
    pub save_codes: Option<Vec<String>>,
    pub sessions: Option<Vec<SessionInfo>>,
    pub sub_users: Option<SubUserList>,
    pub sub_user_form: Option<subusers::NewSubUser>,
    pub sub_user_draft: Option<(String, Vec<String>)>,
    pub sub_user_removing: Option<String>,
    pub users: Option<AdminUserPage>,
    pub users_more: bool,
    pub limit_edit: Option<LimitEdit>,
    pub limit_error: Option<String>,
    /// The account's own limit changed; reload its usage on the next frame.
    pub reload_usage: bool,
    pub clients: Option<ActiveClients>,
    pub onlyoffice: Option<OnlyOfficeSettings>,
    pub share_url: Option<UrlSetting>,
    pub max_upload: Option<MaxUploadSize>,
    pub proxies: Option<KnownProxies>,
    pub restart_required: bool,
    pub activity: Option<ActivitySettings>,
    pub cloud_drive: Option<CloudDriveConfig>,
    pub storage: Option<StorageSettingsSummary>,
    pub google: Option<GoogleAuthSummary>,
    pub versions: Option<Versions>,
    pub latest: Option<Versions>,
    pub version_error: Option<String>,
    pub orphans: Option<OrphanReport>,
    pub orphan_notes: Vec<String>,
    pub orphan_error: Option<String>,
    /// Entries a delete kept; set when it finishes so the dialog rescans.
    pub orphan_rescan: Option<Vec<String>>,
    pub busy: Option<&'static str>,
    pub end_session: Option<String>,
    /// A form problem to show as an error toast on the next frame.
    pub notice: Option<String>,
    /// A confirmation to show as a toast on the next frame.
    pub notice_ok: Option<String>,
    pub dialog: Option<dialogs::Dialog>,
}

impl SettingsState {
    /// Show a form problem as an error toast.
    pub fn report(&mut self, message: String) {
        self.notice = Some(message);
    }

    /// Open or close a configuration card; true when it is now open.
    pub fn toggle_card(&mut self, key: &'static str) -> bool {
        if self.open.remove(key) {
            false
        } else {
            self.open.insert(key);
            true
        }
    }
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
    attempt(tasks, main, label, call, move |main, toasts, result| match result {
        Ok(value) => done(main, toasts, value),
        Err(err) => toasts.error(err.message),
    });
}

/// Like `save`, but `done` also handles failures (an ended session still signs out).
pub fn attempt<T, Fut>(
    tasks: &Tasks,
    main: &mut Main,
    label: &'static str,
    call: impl FnOnce(Client) -> Fut,
    done: impl FnOnce(&mut Main, &mut crate::toast::Toasts, ApiResult<T>) + MaybeSend + 'static,
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
        if let Err(err) = &result
            && err.is_unauthorized()
        {
            app.fail(generation, err);
            return;
        }
        if let Screen::Main(main) = &mut app.screen
            && main.generation == generation
        {
            done(main, &mut app.toasts, result);
        }
    });
}

/// End this session here after the server ended every session (password
/// change, sign out everywhere); the dialogs pass applies it with the whole app.
pub fn sign_out_after_now(main: &mut Main, message: &str) {
    main.settings.end_session = Some(message.to_string());
}

/// Load what the current page needs.
pub fn opened(main: &mut Main, tasks: &Tasks) {
    match main.settings.page {
        Page::Profile => fetch(tasks, main, |c| async move { c.mfa_status().await }, |s, v| s.mfa = Some(v.enabled)),
        Page::Storage => storage::load(main, tasks),
        Page::SubUsers => subusers::load(main, tasks),
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

/// The settings menu as a plain column beside the page, when there is room for
/// both: no card around it, no repeated name or storage meter (the header and the
/// Storage page show those), and the page next to it at a readable width.
fn side_menu_layout(
    main: &mut Main,
    ui: &mut egui::Ui,
    pages: &[(Page, &str, &str)],
    switch: &mut Option<Page>,
    host: &mut dyn Host,
    tasks: &Tasks,
    t: Tokens,
) {
    const MENU: f32 = 216.0;
    let height = ui.available_height();
    ui.horizontal_top(|ui| {
        ui.spacing_mut().item_spacing = egui::vec2(0.0, 0.0);
        ui.allocate_ui_with_layout(egui::vec2(MENU, height), egui::Layout::top_down(egui::Align::Min), |ui| {
            ui.set_width(MENU);
            egui::Frame::new().inner_margin(Margin { left: 4, right: 16, top: 6, bottom: 12 }).show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                ui.label(RichText::new("Settings").size(20.0).semibold().color(t.label));
                ui.add_space(12.0);
                for (page, icon, label) in pages {
                    if nav_row(ui, icon, label, main.settings.page == *page) {
                        *switch = Some(*page);
                    }
                }
            });
        });
        let rule = ui.available_rect_before_wrap();
        ui.painter().vline(rule.left(), rule.top()..=rule.top() + height, Stroke::new(1.0, t.separator));
        ui.allocate_ui_with_layout(
            egui::vec2(ui.available_width(), height),
            egui::Layout::top_down(egui::Align::Min),
            |ui| {
                egui::ScrollArea::vertical().id_salt("settings-page").auto_shrink([false, false]).show(ui, |ui| {
                    egui::Frame::new().inner_margin(Margin { left: 40, right: 28, top: 6, bottom: 32 }).show(
                        ui,
                        |ui| {
                            ui.set_width(page_width(ui.available_width()));
                            ui.spacing_mut().item_spacing = egui::vec2(8.0, 8.0);
                            page_body(main, host, tasks, ui);
                        },
                    );
                });
            },
        );
    });
}

/// Settings read best in a column: it grows with the window up to this width.
fn page_width(available: f32) -> f32 {
    available.clamp(0.0, 780.0)
}

/// Below this width the settings menu moves above the page.
const NARROW_BELOW: f32 = 640.0;

fn page_body(main: &mut Main, host: &mut dyn Host, tasks: &Tasks, ui: &mut egui::Ui) {
    let desktop = host.kind() == crate::host::HostKind::Desktop;
    match main.settings.page {
        Page::Profile => account::profile(main, ui, tasks),
        Page::Storage => storage::show(main, ui, tasks),
        Page::SubUsers => subusers::show(main, ui, tasks),
        Page::Administration => admin::show(main, ui, tasks, desktop),
        Page::Updates => updates::show(main, ui, tasks, host),
        Page::Security => account::security(main, ui, tasks),
        Page::Host => {
            let client = main.client.clone();
            host.settings_ui(ui, &client, tasks);
        }
    }
}

pub use crate::widgets::section;
