//! The app: which screen shows, the signed-in state, and the per-frame loop
//! that applies finished background work before drawing.

use tma_client::events::Subscription;
use tma_client::{ApiError, ApiResult, Client};
use tma_core::api::{FileItem, SortBy, SortOrder, StorageUsage, User};

use crate::auth::AuthState;
use crate::host::{Host, HostKind, SavedSession};
use crate::tasks::Tasks;
use crate::theme::{self, TextSize, ThemeChoice, Tokens};
use crate::toast::Toasts;
use crate::{dashboard, files, modals, settings, transfers, widgets};

/// Settings the app remembers between runs.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub theme: ThemeChoice,
    pub grid_view: bool,
    pub sort: SortBy,
    pub order: SortOrder,
    /// The sidebar is folded away (the menu button in the header).
    pub sidebar_hidden: bool,
    /// How large the app draws (Settings → Appearance).
    pub text_size: TextSize,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme: ThemeChoice::System,
            grid_view: false,
            sort: SortBy::Name,
            order: SortOrder::Asc,
            sidebar_hidden: false,
            text_size: TextSize::Default,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Dashboard,
    Files,
    Shared,
    Starred,
    Trash,
    Search,
    Settings,
}

/// Instance facts the UI adapts to.
#[derive(Debug, Clone, Default)]
pub struct Instance {
    pub hide_extensions: bool,
    pub onlyoffice: bool,
    pub is_first_user: bool,
    pub storage_configured: bool,
    pub max_upload: i64,
    pub usage: Option<StorageUsage>,
}

pub struct Main {
    pub client: Client,
    pub user: User,
    /// Bumped on every sign-in, so results for an old session are dropped.
    pub generation: u64,
    pub section: Section,
    pub browser: files::Browser,
    pub dashboard: dashboard::Dashboard,
    pub settings: settings::SettingsState,
    pub transfers: transfers::Transfers,
    pub modal: Option<modals::Modal>,
    pub instance: Instance,
    pub search: String,
    pub search_results: Option<Vec<FileItem>>,
    pub(crate) events: Option<Subscription>,
    /// A live event arrived since the last frame.
    pub(crate) change_pending: bool,
    /// When the current burst of events started; the listing refreshes shortly after.
    pub(crate) changed_at: Option<f64>,
}

pub enum Screen {
    Loading,
    Auth(Box<AuthState>),
    Reconnect(Box<crate::reconnect::Reconnect>),
    Main(Box<Main>),
}

pub struct App {
    pub t: Tokens,
    pub prefs: Prefs,
    pub tasks: Tasks,
    pub toasts: Toasts,
    pub host: Box<dyn Host>,
    pub screen: Screen,
    generation: u64,
}

impl App {
    /// `system_font` is a TTF/OTF to prefer over egui's built-in face.
    pub fn new(ctx: &egui::Context, host: Box<dyn Host>, prefs: Prefs, system_font: Option<Vec<u8>>) -> Self {
        theme::install_fonts(ctx, system_font);
        egui_extras_install(ctx);
        let mut app = Self {
            t: Tokens::light(),
            prefs,
            tasks: Tasks::new(ctx.clone()),
            toasts: Toasts::default(),
            host,
            screen: Screen::Loading,
            generation: 0,
        };
        app.resume();
        app
    }

    /// Restore a session: the web page's cookie, or the desktop app's saved one.
    fn resume(&mut self) {
        let client = match self.host.kind() {
            HostKind::Web => web_client(),
            HostKind::Desktop => match self.host.saved_session() {
                Some(SavedSession { server, token: Some(token) }) => {
                    Client::new(&server).inspect(|c| c.restore_session(&token))
                }
                Some(saved) => {
                    self.screen = Screen::Auth(Box::new(AuthState::new(&saved.server)));
                    return;
                }
                None => {
                    self.screen = Screen::Auth(Box::new(AuthState::new("")));
                    return;
                }
            },
        };
        let Ok(client) = client else {
            self.screen = Screen::Auth(Box::new(AuthState::new("")));
            return;
        };
        self.check_session(client);
    }

    /// Check a restored session: sign in on success, ask for the password only
    /// when the server refused it, and keep retrying when it could not be reached.
    pub(crate) fn check_session(&mut self, client: Client) {
        let c = client.clone();
        self.tasks.run(async move { c.profile().await }, move |app, result| match result {
            Ok(user) => app.enter(client, user),
            Err(err) if err.is_unauthorized() || err.status == 403 => {
                app.screen = Screen::Auth(Box::new(AuthState::new(client.base_url())));
            }
            Err(err) => {
                let attempts = match &app.screen {
                    Screen::Reconnect(r) => r.attempts + 1,
                    _ => 1,
                };
                app.screen = Screen::Reconnect(Box::new(crate::reconnect::Reconnect {
                    client,
                    error: err.message,
                    attempts,
                    next_at: None,
                    trying: false,
                }));
            }
        });
    }

    /// Save the session token as it is now: the server renews it while the
    /// app is used, and a restart must not fall back to the one from sign-in.
    pub fn remember_session(&mut self) {
        if self.host.kind() != HostKind::Desktop {
            return;
        }
        let Screen::Main(main) = &self.screen else { return };
        let token = main.client.session_token();
        if token.is_some() {
            let server = main.client.base_url().to_string();
            self.host.save_session(Some(&SavedSession { server, token }));
        }
    }

    /// Signed in: build the main screen and start live events.
    pub fn enter(&mut self, client: Client, user: User) {
        self.generation += 1;
        let generation = self.generation;
        if self.host.kind() == HostKind::Desktop {
            self.host.save_session(Some(&SavedSession {
                server: client.base_url().to_string(),
                token: client.session_token(),
            }));
        }
        let sender = self.tasks.sender();
        let ctx = self.tasks.ctx().clone();
        #[cfg_attr(
            target_arch = "wasm32",
            expect(
                clippy::arc_with_non_send_sync,
                reason = "the web build is single-threaded, so a non-Send sink is fine"
            )
        )]
        let sink: tma_client::events::Sink = std::sync::Arc::new(move |event: tma_core::api::FileEvent| {
            if !event.is_change() {
                return;
            }
            let _ = sender.send(Box::new(move |app: &mut App| {
                if let Some(main) = app.main_mut(generation) {
                    main.change_pending = true;
                }
            }));
            ctx.request_repaint();
        });
        let events = tma_client::events::subscribe(&client, sink);
        self.host.signed_in(&client, &user, &self.tasks);
        let mut main = Main {
            client,
            user,
            generation,
            section: Section::Files,
            browser: files::Browser::default(),
            dashboard: dashboard::Dashboard::default(),
            settings: settings::SettingsState::default(),
            transfers: transfers::Transfers::default(),
            modal: None,
            instance: Instance::default(),
            search: String::new(),
            search_results: None,
            events: Some(events),
            change_pending: false,
            changed_at: None,
        };
        main.browser.load(&self.tasks, &main.client, generation, &self.prefs);
        dashboard::load(&self.tasks, &main.client, generation);
        load_instance(&self.tasks, &main.client, generation);
        settings::updates::check(&main, &self.tasks);
        self.screen = Screen::Main(Box::new(main));
    }

    pub fn sign_out(&mut self) {
        let Screen::Main(main) = &mut self.screen else { return };
        let client = main.client.clone();
        main.events = None;
        let server = client.base_url().to_string();
        self.tasks.run(async move { client.logout().await }, |_, _| {});
        self.host.signed_out();
        if self.host.kind() == HostKind::Desktop {
            self.host.save_session(Some(&SavedSession { server: server.clone(), token: None }));
        }
        self.generation += 1;
        self.screen = Screen::Auth(Box::new(AuthState::new(&server)));
    }

    /// The signed-in server, for the shell to remember.
    /// Still checking the saved sign-in: only a spinner shows yet.
    pub fn is_loading(&self) -> bool {
        matches!(self.screen, Screen::Loading)
    }

    pub fn server_url(&self) -> Option<String> {
        match &self.screen {
            Screen::Main(main) => Some(main.client.base_url().to_string()),
            _ => None,
        }
    }

    /// The signed-in session's transfer list, for work the host runs itself.
    pub fn transfers_mut(&mut self) -> Option<&mut crate::transfers::Transfers> {
        match &mut self.screen {
            Screen::Main(main) => Some(&mut main.transfers),
            _ => None,
        }
    }

    pub fn main_mut(&mut self, generation: u64) -> Option<&mut Main> {
        match &mut self.screen {
            Screen::Main(main) if main.generation == generation => Some(main),
            _ => None,
        }
    }

    /// Apply a result for the session `generation`: `ok` on success, a toast
    /// (or sign-out when the session ended) on failure.
    pub fn finish<T>(&mut self, generation: u64, result: ApiResult<T>, ok: impl FnOnce(&mut Main, &mut Toasts, T)) {
        match result {
            Ok(value) => {
                if let Screen::Main(main) = &mut self.screen
                    && main.generation == generation
                {
                    ok(main, &mut self.toasts, value);
                }
            }
            Err(err) => self.fail(generation, &err),
        }
    }

    pub fn fail(&mut self, generation: u64, err: &ApiError) {
        if generation != self.generation {
            return;
        }
        if err.is_unauthorized() && matches!(self.screen, Screen::Main(_)) {
            self.sign_out();
            self.toasts.info("Your session ended. Sign in again.");
        } else {
            self.toasts.error(err.message.clone());
        }
    }

    /// One frame: apply finished work, then draw the current screen into the root `ui`.
    pub fn ui(&mut self, ui: &mut egui::Ui) {
        let ctx = &ui.ctx().clone();
        let system_dark = ctx.system_theme().is_some_and(|t| t == egui::Theme::Dark);
        let tokens = Tokens::for_choice(self.prefs.theme, system_dark);
        if tokens.dark != self.t.dark || ctx.cumulative_frame_nr() == 0 {
            theme::apply(ctx, &tokens);
            crate::platform::use_app_cursors(tokens.dark);
        }
        // The Text size setting is the one zoom; egui's Ctrl +/- would only undo it.
        let zoom = self.prefs.text_size.zoom();
        if (ctx.zoom_factor() - zoom).abs() > f32::EPSILON {
            ctx.options_mut(|o| o.zoom_with_keyboard = false);
            ctx.set_zoom_factor(zoom);
        }
        self.t = tokens;
        widgets::store_tokens(ctx, tokens);
        for apply in self.tasks.drain() {
            apply(self);
        }
        self.host.tick(ctx, &self.tasks);
        self.refresh_after_events(ctx);
        if !matches!(self.screen, Screen::Auth(_)) {
            crate::login_form::remove();
        }
        match &mut self.screen {
            Screen::Loading => {
                egui::CentralPanel::default().show(ui, |ui| {
                    ui.centered_and_justified(|ui| ui.spinner());
                });
            }
            Screen::Auth(_) => crate::auth::show(self, ui),
            Screen::Reconnect(_) => crate::reconnect::show(self, ui),
            Screen::Main(_) => crate::shell::show(self, ui),
        }
        self.toasts.show(ctx, &self.t);
    }

    /// Live events arrive in bursts; one refresh covers a burst.
    fn refresh_after_events(&mut self, ctx: &egui::Context) {
        let now = ctx.input(|i| i.time);
        let Screen::Main(main) = &mut self.screen else { return };
        if std::mem::take(&mut main.change_pending) {
            main.changed_at.get_or_insert(now);
        }
        let Some(at) = main.changed_at else { return };
        if now - at < 0.3 {
            ctx.request_repaint_after(std::time::Duration::from_millis(100));
            return;
        }
        main.changed_at = None;
        let generation = main.generation;
        main.browser.reload(&self.tasks, &main.client, generation, &self.prefs);
        dashboard::load(&self.tasks, &main.client, generation);
        load_usage(&self.tasks, &main.client, generation);
    }
}

#[cfg(target_arch = "wasm32")]
fn web_client() -> ApiResult<Client> {
    Client::same_origin()
}

#[cfg(not(target_arch = "wasm32"))]
fn web_client() -> ApiResult<Client> {
    Err(ApiError::local("The web host only runs in a browser"))
}

fn egui_extras_install(ctx: &egui::Context) {
    ctx.options_mut(|o| o.zoom_with_keyboard = true);
}

pub fn load_usage(tasks: &Tasks, client: &Client, generation: u64) {
    let c = client.clone();
    tasks.run(async move { c.storage_usage().await }, move |app, result| {
        if let (Some(main), Ok(usage)) = (app.main_mut(generation), result) {
            main.instance.usage = Some(usage);
        }
    });
}

/// The instance facts: extension hiding, OnlyOffice, storage and limits.
pub fn load_instance(tasks: &Tasks, client: &Client, generation: u64) {
    load_usage(tasks, client, generation);
    let c = client.clone();
    tasks.run(
        async move {
            let status = c.signup_status().await;
            let storage = c.storage_status().await;
            let onlyoffice = c.onlyoffice_configured().await.unwrap_or(false);
            let max = c.max_upload().await.map(|m| m.max_bytes).unwrap_or(0);
            (status, storage, onlyoffice, max)
        },
        move |app, (status, storage, onlyoffice, max)| {
            let Some(main) = app.main_mut(generation) else { return };
            if let Ok(s) = status {
                main.instance.hide_extensions = s.hide_file_extensions;
                main.instance.is_first_user = s.can_toggle;
            }
            if let Ok(s) = storage {
                main.instance.storage_configured = s.configured;
                main.instance.is_first_user |= s.can_configure;
            }
            main.instance.onlyoffice = onlyoffice;
            main.instance.max_upload = max;
        },
    );
}
