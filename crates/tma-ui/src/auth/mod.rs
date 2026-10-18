//! Sign in and create account. The desktop app also asks which server to use;
//! the web app always talks to the page's own server.
//!
//! Built to the usual sign-in form rules: a label above every field, examples
//! as placeholders, the password rule shown before it is broken, a show-password
//! eye instead of a confirm field, a button that always answers (it says what is
//! missing rather than ignoring the click), and two-factor as its own step.

mod form;

use egui::{RichText, Vec2};
use tma_client::{ApiResult, Client};

use crate::app::App;
use crate::host::HostKind;
use crate::icons::{self, ph};
use crate::login_form::{self, Kind};
use crate::widgets;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    SignIn,
    SignUp,
}

pub struct AuthState {
    server: String,
    mode: Mode,
    name: String,
    email: String,
    password: String,
    mfa_code: String,
    /// The password was right; the account wants its second step.
    needs_mfa: bool,
    busy: bool,
    error: Option<String>,
    signup_enabled: Option<bool>,
    /// Whether the server answered the last probe (desktop shows it under the address).
    reachable: Option<bool>,
    /// The server the signup flag was read from.
    probed: Option<String>,
}

impl AuthState {
    pub fn new(server: &str) -> Self {
        Self {
            server: server.to_string(),
            mode: Mode::SignIn,
            name: String::new(),
            email: String::new(),
            password: String::new(),
            mfa_code: String::new(),
            needs_mfa: false,
            busy: false,
            error: None,
            signup_enabled: None,
            reachable: None,
            probed: None,
        }
    }

    fn switch(&mut self, mode: Mode) {
        self.mode = mode;
        self.error = None;
        self.needs_mfa = false;
        self.mfa_code.clear();
    }
}

fn client_for(app: &App, server: &str) -> ApiResult<Client> {
    match app.host.kind() {
        HostKind::Desktop => Client::new(server),
        HostKind::Web => {
            #[cfg(target_arch = "wasm32")]
            return Client::same_origin();
            #[cfg(not(target_arch = "wasm32"))]
            Client::new(server)
        }
    }
}

/// Read whether this server answers and allows signup.
fn probe(app: &mut App) {
    let Some(server) = auth_state(app).map(|s| s.server.clone()) else { return };
    if auth_state(app).and_then(|s| s.probed.clone()).as_deref() == Some(server.as_str()) {
        return;
    }
    let Ok(client) = client_for(app, &server) else { return };
    if let Some(state) = auth_state(app) {
        state.probed = Some(server.clone());
        state.reachable = None;
    }
    app.tasks.run(
        async move { client.public_signup_status().await.map(|s| s.signup_enabled).ok() },
        move |app, signup| {
            if let Some(state) = auth_state(app).filter(|s| s.probed.as_deref() == Some(server.as_str())) {
                state.signup_enabled = signup;
                state.reachable = Some(signup.is_some());
            }
        },
    );
}

fn auth_state(app: &mut App) -> Option<&mut AuthState> {
    match &mut app.screen {
        crate::app::Screen::Auth(state) => Some(state),
        _ => None,
    }
}

/// What has to be fixed before sending, in words that say how.
fn problem(mode: Mode, needs_mfa: bool, email: &str, password: &str, code: &str) -> Option<String> {
    if needs_mfa {
        return code.trim().is_empty().then(|| "Enter the code from your authenticator app".into());
    }
    let email = email.trim();
    let (user, domain) = email.rsplit_once('@').unwrap_or(("", ""));
    if email.is_empty() {
        Some("Enter your email address".into())
    } else if user.is_empty() || domain.is_empty() {
        Some("Enter an email address like name@example.com".into())
    } else if password.is_empty() {
        Some(if mode == Mode::SignUp { "Choose a password" } else { "Enter your password" }.into())
    } else if mode == Mode::SignUp && password.chars().count() < form::MIN_PASSWORD {
        Some(format!("Use at least {} characters for your password", form::MIN_PASSWORD))
    } else {
        None
    }
}

fn submit(app: &mut App) {
    let Some(state) = auth_state(app) else { return };
    state.error = problem(state.mode, state.needs_mfa, &state.email, &state.password, &state.mfa_code);
    if state.error.is_some() {
        return;
    }
    login_form::submitted();
    let (mode, server) = (state.mode, state.server.clone());
    let (name, email, password) =
        (state.name.trim().to_string(), state.email.trim().to_string(), state.password.clone());
    let code = Some(state.mfa_code.trim().to_string()).filter(|c| state.needs_mfa && !c.is_empty());
    let client = match client_for(app, &server) {
        Ok(c) => c,
        Err(err) => {
            if let Some(state) = auth_state(app) {
                state.error = Some(err.message);
            }
            return;
        }
    };
    if let Some(state) = auth_state(app) {
        state.busy = true;
    }
    let c = client.clone();
    app.tasks.run(
        async move {
            match mode {
                Mode::SignIn => c.login(&email, &password, code.as_deref()).await,
                Mode::SignUp => {
                    c.signup(Some(&name).filter(|n| !n.is_empty()).map(String::as_str), &email, &password).await
                }
            }
        },
        move |app, result| match result {
            Ok(user) => app.enter(client, user),
            Err(err) => {
                let Some(state) = auth_state(app) else { return };
                state.busy = false;
                if err.needs_mfa() {
                    // The step itself says what to do, so no error to show yet.
                    state.needs_mfa = true;
                    state.error = None;
                } else if state.needs_mfa && err.status == 401 {
                    state.error = Some("That code didn't work. Check it and try again.".into());
                    state.mfa_code.clear();
                } else {
                    state.error = Some(err.message);
                }
            }
        },
    );
}

/// The card's title and the line under it, for where the user is.
fn heading(state: &AuthState) -> (&'static str, &'static str) {
    match (state.needs_mfa, state.mode) {
        (true, _) => ("Two-step verification", "Enter the 6-digit code from your authenticator app, or a backup code."),
        (false, Mode::SignIn) => ("Sign in to TMA Cloud", "Welcome back. Enter your details to continue."),
        (false, Mode::SignUp) => ("Create your account", "Store and share your files on this server."),
    }
}

/// The desktop app's server address, and whether that server answers.
fn server_field(ui: &mut egui::Ui, state: &mut AuthState) -> bool {
    let t = widgets::tokens(ui);
    let mut changed = false;
    form::labelled(ui, "Server", |ui| {
        let r = form::text_field(ui, &mut state.server, false, "https://cloud.example.com");
        changed = r.lost_focus();
        false
    });
    let (icon, text, color) = match state.reachable {
        Some(true) => (ph::CHECK_CIRCLE, "Connected", t.positive_text),
        Some(false) => (ph::WARNING_CIRCLE, "Can't reach this server. Check the address.", t.destructive_text),
        None => (ph::INFO, "The address of your TMA Cloud server", t.label_tertiary),
    };
    ui.add_space(4.0 - ui.spacing().item_spacing.y);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        ui.label(RichText::new(icon).size(13.0).color(color));
        ui.label(RichText::new(text).size(12.0).color(color));
    });
    changed
}

/// The fields for this step; true when Enter was pressed in one.
fn fields(ui: &mut egui::Ui, state: &mut AuthState) -> bool {
    let up = state.mode == Mode::SignUp;
    let gap = 16.0 - ui.spacing().item_spacing.y;
    let mut enter = false;
    login_form::begin();
    if state.needs_mfa {
        enter |= form::labelled(ui, "Verification code", |ui| {
            form::entry(ui, &mut state.mfa_code, Kind::Code, "123456", up)
        });
    } else {
        if up {
            form::labelled(ui, "Name", |ui| form::entry(ui, &mut state.name, Kind::Name, "Your name", up));
            ui.add_space(gap);
        }
        enter |=
            form::labelled(ui, "Email", |ui| form::entry(ui, &mut state.email, Kind::Email, "name@example.com", up));
        ui.add_space(gap);
        let hint = if up { "Create a password" } else { "Enter your password" };
        enter |= form::labelled(ui, "Password", |ui| form::entry(ui, &mut state.password, Kind::Password, hint, up));
        if up {
            form::password_rule(ui, &state.password);
        }
    }
    login_form::end();
    enter
}

/// The card's body below the heading; true when the form should be sent.
fn card(ui: &mut egui::Ui, state: &mut AuthState, desktop: bool, probe_again: &mut bool) -> bool {
    let gap = 16.0 - ui.spacing().item_spacing.y;
    if desktop && !state.needs_mfa {
        *probe_again = server_field(ui, state);
        ui.add_space(gap);
    }
    let enter = fields(ui, state) && !state.busy;
    ui.add_space(gap + 4.0);
    if let Some(err) = &state.error {
        form::error_banner(ui, err);
        ui.add_space(gap);
    }
    let (label, busy) = match (state.needs_mfa, state.mode) {
        (true, _) => ("Verify", "Verifying…"),
        (false, Mode::SignIn) => ("Sign in", "Signing in…"),
        (false, Mode::SignUp) => ("Create account", "Creating account…"),
    };
    let send = form::button(ui, label, state.busy.then_some(busy)) || enter;
    if state.needs_mfa {
        ui.add_space(gap - 4.0);
        ui.vertical_centered(|ui| {
            let back = RichText::new(format!("{}  Use a different account", ph::ARROW_LEFT)).size(13.0);
            if ui.add(egui::Button::new(back).frame(false)).clicked() {
                state.needs_mfa = false;
                state.mfa_code.clear();
                state.error = None;
            }
        });
    }
    send
}

pub fn show(app: &mut App, root: &mut egui::Ui) {
    let t = app.t;
    let desktop = app.host.kind() == HostKind::Desktop;
    if !desktop || auth_state(app).is_some_and(|s| !s.server.trim().is_empty() && s.probed.is_none()) {
        probe(app);
    }
    let mut do_submit = false;
    let mut do_probe = false;
    let mut flip_theme = false;
    egui::CentralPanel::default().frame(egui::Frame::new().fill(t.canvas)).show(root, |ui| {
        let Some(state) = (match &mut app.screen {
            crate::app::Screen::Auth(s) => Some(s.as_mut()),
            _ => None,
        }) else {
            return;
        };
        let corner = egui::Rect::from_min_size(ui.max_rect().right_top() + Vec2::new(-48.0, 14.0), Vec2::splat(32.0));
        let icon = if t.dark { ph::SUN } else { ph::MOON };
        let toggle = egui::Button::new(RichText::new(icon).size(18.0).color(t.label_secondary)).frame(false);
        if ui.put(corner, toggle).on_hover_text("Switch theme").clicked() {
            flip_theme = true;
        }
        // Centred on the card's height from the last frame, so steps of any length sit in the middle.
        let height_key = egui::Id::unique("auth-card-height");
        let last = ui.data(|d| d.get_temp::<f32>(height_key)).unwrap_or(520.0);
        let narrow = ui.available_width() < 440.0;
        let width = (ui.available_width() - 32.0).min(380.0);
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            ui.add_space(((ui.available_height() - last) / 2.0).max(24.0));
            let block = ui.vertical_centered(|ui| {
                egui::Frame::new()
                    .fill(t.surface)
                    .stroke(egui::Stroke::new(1.0, t.separator))
                    .corner_radius(egui::CornerRadius::same(20))
                    .inner_margin(egui::Margin::same(if narrow { 22 } else { 32 }))
                    .shadow(egui::epaint::Shadow {
                        offset: [0, 16],
                        blur: 48,
                        spread: 0,
                        color: egui::Color32::from_black_alpha(if t.dark { 110 } else { 26 }),
                    })
                    .show(ui, |ui| {
                        ui.set_width(width - if narrow { 44.0 } else { 64.0 });
                        ui.spacing_mut().item_spacing.y = 4.0;
                        ui.vertical_centered(|ui| {
                            let (rect, _) = ui.allocate_exact_size(Vec2::splat(40.0), egui::Sense::hover());
                            icons::logo(ui.painter(), rect, &t);
                            ui.add_space(10.0);
                            let (title, line) = heading(state);
                            ui.label(RichText::new(title).size(24.0).family(crate::theme::bold()).color(t.label));
                            ui.add(egui::Label::new(RichText::new(line).size(14.0).color(t.label_secondary)).wrap());
                        });
                        ui.add_space(24.0);
                        ui.with_layout(egui::Layout::top_down(egui::Align::Min), |ui| {
                            do_submit = card(ui, state, desktop, &mut do_probe);
                        });
                    });
                ui.add_space(20.0);
                if !state.needs_mfa {
                    match (state.mode, state.signup_enabled) {
                        (Mode::SignIn, Some(true))
                            if form::switch_link(ui, "New to TMA Cloud?", "Create an account") =>
                        {
                            state.switch(Mode::SignUp);
                        }
                        (Mode::SignUp, _) if form::switch_link(ui, "Already have an account?", "Sign in") => {
                            state.switch(Mode::SignIn);
                        }
                        _ => {}
                    }
                }
            });
            ui.add_space(24.0);
            let height = block.response.rect.height();
            if (height - last).abs() > 0.5 {
                ui.data_mut(|d| d.insert_temp(height_key, height));
                ui.ctx().request_repaint();
            }
        });
    });
    if flip_theme {
        app.prefs.theme = if t.dark { crate::theme::ThemeChoice::Light } else { crate::theme::ThemeChoice::Dark };
    }
    if do_probe && let Some(state) = auth_state(app) {
        state.probed = None;
    }
    if do_submit {
        submit(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_says_what_is_missing() {
        let sign_in = |email, password| problem(Mode::SignIn, false, email, password, "");
        assert_eq!(sign_in("", "x").as_deref(), Some("Enter your email address"));
        assert_eq!(sign_in("bob", "x").as_deref(), Some("Enter an email address like name@example.com"));
        assert_eq!(sign_in("bob@example.com", "").as_deref(), Some("Enter your password"));
        assert_eq!(sign_in("bob@example.com", "short"), None);
        let short = problem(Mode::SignUp, false, "bob@example.com", "short", "");
        assert_eq!(short.as_deref(), Some("Use at least 8 characters for your password"));
        assert_eq!(problem(Mode::SignUp, false, "bob@example.com", "long enough", ""), None);
        assert!(problem(Mode::SignIn, true, "", "", " ").is_some());
        assert_eq!(problem(Mode::SignIn, true, "", "", "123456"), None);
    }
}
