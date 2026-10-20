//! A saved session whose server cannot be reached right now (it is restarting,
//! or the network is not up yet after an update): keep the sign-in and retry,
//! instead of asking for the password again.

use egui::{Align2, FontId, RichText, Sense, Vec2};
use tma_client::Client;

use crate::app::{App, Screen};
use crate::auth::AuthState;
use crate::icons::ph;
use crate::widgets;

pub struct Reconnect {
    pub client: Client,
    pub error: String,
    pub attempts: u32,
    /// When to try again (egui time); set on the first frame after a failure.
    pub next_at: Option<f64>,
    pub trying: bool,
}

/// Seconds to wait before the next try: 2, 4, 8, 16, then every 30.
pub fn delay(attempts: u32) -> f64 {
    f64::from(2u32.saturating_pow(attempts.clamp(1, 5))).min(30.0)
}

pub fn show(app: &mut App, ui: &mut egui::Ui) {
    let now = ui.input(|i| i.time);
    let Screen::Reconnect(state) = &mut app.screen else { return };
    let next_at = *state.next_at.get_or_insert(now + delay(state.attempts));
    let mut retry = !state.trying && now >= next_at;
    let mut sign_in = false;
    let t = widgets::tokens(ui);
    egui::CentralPanel::default().frame(egui::Frame::new().fill(t.canvas)).show(ui, |ui| {
        ui.vertical_centered(|ui| {
            ui.add_space((ui.available_height() / 2.0 - 140.0).max(24.0));
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(64.0), Sense::hover());
            ui.painter().circle_filled(rect.center(), 32.0, t.fill_tertiary);
            ui.painter().text(
                rect.center(),
                Align2::CENTER_CENTER,
                ph::WIFI_SLASH,
                FontId::proportional(30.0),
                t.label_secondary,
            );
            ui.add_space(10.0);
            ui.label(
                RichText::new(format!("Can't reach {}", state.client.base_url())).size(18.0).strong().color(t.label),
            );
            ui.label(RichText::new("You are still signed in. TMA Cloud keeps trying.").color(t.label_secondary));
            ui.add_space(4.0);
            ui.label(RichText::new(&state.error).size(12.0).color(t.label_tertiary));
            ui.add_space(12.0);
            if state.trying {
                ui.spinner();
            } else {
                let wait = (next_at - now).ceil().max(0.0);
                ui.label(widgets::muted(ui, format!("Trying again in {wait:.0}s")));
                ui.ctx().request_repaint_after(std::time::Duration::from_millis(500));
            }
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                let width = 260.0;
                ui.add_space((ui.available_width() - width).max(0.0) / 2.0);
                let label = format!("{}  Try now", ph::ARROWS_CLOCKWISE);
                if widgets::primary_enabled(ui, !state.trying, label).clicked() {
                    retry = true;
                }
                if widgets::secondary(ui, "Sign in again").clicked() {
                    sign_in = true;
                }
            });
        });
    });
    if sign_in {
        let server = state.client.base_url().to_string();
        app.screen = Screen::Auth(Box::new(AuthState::new(&server)));
    } else if retry {
        state.trying = true;
        // New connections each try: restarting the app got through where retries had kept failing.
        let client = state.client.reconnected();
        app.check_session(client);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_grow_then_level_off() {
        let waits: Vec<f64> = (0..8).map(delay).collect();
        assert_eq!(waits, [2.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]);
    }
}
