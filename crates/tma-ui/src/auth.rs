//! Sign in and create account. The desktop app also asks which server to use;
//! the web app always talks to the page's own server.

use egui::{Align, Layout, RichText, Vec2};
use tma_client::{ApiResult, Client};

use crate::app::App;
use crate::host::HostKind;
use crate::icons::{self, ph};
use crate::theme::Weight;
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
    confirm: String,
    mfa_code: String,
    needs_mfa: bool,
    busy: bool,
    error: Option<String>,
    signup_enabled: Option<bool>,
    google: bool,
    /// The server the signup and Google flags were read from.
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
            confirm: String::new(),
            mfa_code: String::new(),
            needs_mfa: false,
            busy: false,
            error: None,
            signup_enabled: None,
            google: false,
            probed: None,
        }
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

/// Read whether this server allows signup and Google sign-in.
fn probe(app: &mut App) {
    let Some(server) = auth_state(app).map(|s| s.server.clone()) else { return };
    if auth_state(app).and_then(|s| s.probed.clone()).as_deref() == Some(server.as_str()) {
        return;
    }
    let Ok(client) = client_for(app, &server) else { return };
    if let Some(state) = auth_state(app) {
        state.probed = Some(server.clone());
    }
    app.tasks.run(
        async move {
            let signup = client.public_signup_status().await.map(|s| s.signup_enabled).ok();
            let google = client.google_enabled().await.unwrap_or(false);
            (signup, google)
        },
        move |app, (signup, google)| {
            if let Some(state) = auth_state(app).filter(|s| s.probed.as_deref() == Some(server.as_str())) {
                state.signup_enabled = signup;
                state.google = google;
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

fn submit(app: &mut App) {
    let Some(state) = auth_state(app) else { return };
    state.error = None;
    if state.mode == Mode::SignUp && state.password != state.confirm {
        state.error = Some("Passwords do not match".into());
        return;
    }
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
                if let Some(state) = auth_state(app) {
                    state.busy = false;
                    if err.needs_mfa() {
                        state.needs_mfa = true;
                        state.error = Some("Enter the code from your authenticator app".into());
                    } else {
                        state.error = Some(err.message);
                    }
                }
            }
        },
    );
}

/// A full-width filled input with a placeholder, as on the web sign-in card.
fn pill_input(ui: &mut egui::Ui, value: &mut String, password: bool, placeholder: &str) -> egui::Response {
    let t = widgets::tokens(ui);
    ui.add(
        egui::TextEdit::singleline(value)
            .password(password)
            .hint_text(RichText::new(placeholder).color(t.label_tertiary))
            .desired_width(f32::INFINITY)
            .font(egui::FontId::proportional(14.0))
            .frame(
                egui::Frame::new()
                    .fill(t.fill_quaternary)
                    .corner_radius(egui::CornerRadius::same(12))
                    .inner_margin(egui::Margin::symmetric(12, 10)),
            ),
    )
}

/// A full-width button: the accent one, or a quiet one for the alternative.
fn wide_button(ui: &mut egui::Ui, label: &str, primary: bool, enabled: bool) -> egui::Response {
    let t = widgets::tokens(ui);
    let (fill, color) = if primary { (t.accent, egui::Color32::WHITE) } else { (t.fill_quaternary, t.label) };
    let text = RichText::new(label).size(14.0).family(crate::theme::semibold()).color(color);
    ui.add_enabled(
        enabled,
        egui::Button::new(text)
            .fill(fill)
            .corner_radius(egui::CornerRadius::same(12))
            .min_size(Vec2::new(ui.available_width(), 38.0)),
    )
}

pub fn show(app: &mut App, root: &mut egui::Ui) {
    let t = app.t;
    let desktop = app.host.kind() == HostKind::Desktop;
    if !desktop || auth_state(app).is_some_and(|s| !s.server.trim().is_empty() && s.probed.is_none()) {
        probe(app);
    }
    let mut do_submit = false;
    let mut do_probe = false;
    let mut google = false;
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
        ui.with_layout(Layout::top_down(Align::Center), |ui| {
            let top = ((ui.available_height() - 460.0) / 2.0).max(24.0);
            ui.add_space(top);
            egui::Frame::new()
                .fill(t.surface)
                .stroke(egui::Stroke::new(1.0, t.separator))
                .corner_radius(egui::CornerRadius::same(28))
                .inner_margin(egui::Margin::same(26))
                .shadow(egui::epaint::Shadow {
                    offset: [0, 16],
                    blur: 48,
                    spread: 0,
                    color: egui::Color32::from_black_alpha(if t.dark { 110 } else { 30 }),
                })
                .show(ui, |ui| {
                    ui.set_width(258.0);
                    ui.spacing_mut().item_spacing.y = 10.0;
                    ui.vertical_centered(|ui| {
                        let (rect, _) = ui.allocate_exact_size(Vec2::splat(36.0), egui::Sense::hover());
                        icons::logo(ui.painter(), rect, &t);
                        ui.add_space(-2.0);
                        let title =
                            if state.mode == Mode::SignIn { "Sign in to TMA Cloud" } else { "Create your account" };
                        ui.label(RichText::new(title).size(22.0).bold().color(t.label));
                        ui.add_space(-8.0);
                        ui.label(RichText::new("Your files, wherever you are").size(13.0).color(t.label_secondary));
                    });
                    ui.add_space(4.0);
                    if desktop
                        && pill_input(ui, &mut state.server, false, "Server, e.g. https://cloud.example.com")
                            .lost_focus()
                    {
                        do_probe = true;
                    }
                    if state.mode == Mode::SignUp {
                        pill_input(ui, &mut state.name, false, "Name");
                    }
                    pill_input(ui, &mut state.email, false, "Email");
                    let pw = pill_input(ui, &mut state.password, true, "Password");
                    let mut enter = pw.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    if state.mode == Mode::SignUp {
                        let r = pill_input(ui, &mut state.confirm, true, "Confirm password");
                        enter |= r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    }
                    if state.needs_mfa {
                        let r = pill_input(ui, &mut state.mfa_code, false, "Authentication or backup code");
                        enter |= r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    }
                    if let Some(err) = &state.error {
                        widgets::error_text(ui, err);
                    }
                    let label = match (state.mode, state.busy) {
                        (_, true) => "Please wait…",
                        (Mode::SignIn, false) => "Sign in",
                        (Mode::SignUp, false) => "Create account",
                    };
                    let ok = !state.busy && !state.email.trim().is_empty() && !state.password.is_empty();
                    // Stays bright while empty, as on the web; the click only counts once both fields are filled.
                    if (wide_button(ui, label, true, !state.busy).clicked() || enter) && ok {
                        do_submit = true;
                    }
                    if !desktop && wide_button(ui, "Continue with Google", false, state.google).clicked() {
                        google = true;
                    }
                });
            ui.add_space(14.0);
            match (state.mode, state.signup_enabled) {
                (Mode::SignIn, Some(true)) => {
                    if widgets::ghost(ui, RichText::new("New here? Create an account").color(t.accent)).clicked() {
                        state.mode = Mode::SignUp;
                        state.error = None;
                    }
                }
                (Mode::SignUp, _)
                    if widgets::ghost(ui, RichText::new("Already have an account? Sign in").color(t.accent))
                        .clicked() =>
                {
                    state.mode = Mode::SignIn;
                    state.error = None;
                }
                _ => {}
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
    if google {
        let url = client_for(app, "").map(|c| c.google_login_url()).unwrap_or_default();
        crate::platform::navigate(&url);
    }
}
