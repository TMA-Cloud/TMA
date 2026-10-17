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

use egui::Margin;
use tma_client::rt::MaybeSend;
use tma_client::{ApiResult, Client};
use tma_core::api::*;

use crate::app::{App, Main, Screen};
use crate::host::Host;
use crate::icons::ph;
use crate::tasks::Tasks;
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

/// The settings pages this account can open, in menu order.
pub(crate) fn pages(main: &Main, host_title: Option<&'static str>) -> Vec<(Page, &'static str, &'static str)> {
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
    pages
}

/// Open a settings page, loading what it shows.
pub(crate) fn switch_to(main: &mut Main, page: Page, tasks: &Tasks) {
    main.settings.page = page;
    opened(main, tasks);
}

/// A settings page. Its menu is in the app's sidebar, which turns into it while
/// Settings is open (see `shell`); without that sidebar (hidden, or on a phone)
/// a picker above the page takes its place.
pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let host_title = app.host.settings_title();
    let menu_in_sidebar = !app.prefs.sidebar_hidden && !widgets::mobile(ui.ctx());
    let Screen::Main(main) = &mut app.screen else { return };
    let mut switch = None;
    if !menu_in_sidebar {
        let pages = pages(main, host_title);
        let current = pages.iter().find(|p| p.0 == main.settings.page).map_or("Settings", |p| p.2);
        egui::ComboBox::from_id_salt("settings-menu").selected_text(current).width(220.0).show_ui(ui, |ui| {
            for (page, icon, label) in &pages {
                if ui.selectable_label(main.settings.page == *page, format!("{icon}  {label}")).clicked() {
                    switch = Some(*page);
                }
            }
        });
        ui.add_space(12.0);
    }
    let arrival = page_arrival(ui, main.settings.page);
    egui::ScrollArea::vertical().id_salt("settings-page").auto_shrink([false, false]).show(ui, |ui| {
        let margin = if menu_in_sidebar { Margin { left: 40, right: 32, top: 8, bottom: 40 } } else { Margin::same(0) };
        egui::Frame::new().inner_margin(margin).show(ui, |ui| {
            // A new page fades in and rises a few points, so switching reads as a change of place.
            ui.set_opacity(arrival);
            ui.add_space((1.0 - arrival) * 8.0);
            ui.set_width(page_width(ui.available_width()));
            ui.spacing_mut().item_spacing = egui::vec2(8.0, 8.0);
            page_body(main, &mut *app.host, &app.tasks, ui);
        });
    });
    if let Some(page) = switch
        && let Screen::Main(main) = &mut app.screen
    {
        switch_to(main, page, &app.tasks);
    }
}

/// How far the page shown has come in since it was opened, from 0 to 1, eased out.
fn page_arrival(ui: &egui::Ui, page: Page) -> f32 {
    let key = egui::Id::unique("settings-page-arrival");
    let now = ui.input(|i| i.time);
    let since = match ui.data(|d| d.get_temp::<(Page, f64)>(key)) {
        Some((shown, since)) if shown == page => since,
        _ => {
            ui.data_mut(|d| d.insert_temp(key, (page, now)));
            now
        }
    };
    let t = ((now - since) as f32 / (crate::widgets::SNAP + 0.04)).clamp(0.0, 1.0);
    if t < 1.0 {
        ui.ctx().request_repaint();
    }
    egui::emath::easing::cubic_out(t)
}

/// Settings read best in a column: it grows with the window up to this width.
fn page_width(available: f32) -> f32 {
    available.clamp(0.0, 680.0)
}

fn page_body(main: &mut Main, host: &mut dyn Host, tasks: &Tasks, ui: &mut egui::Ui) {
    let desktop = host.kind() == crate::host::HostKind::Desktop;
    match main.settings.page {
        Page::Profile => account::profile(main, ui),
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
