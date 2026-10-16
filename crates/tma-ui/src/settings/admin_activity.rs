//! Administration cards that tune the server: session timeout, access-time
//! tracking and the proxies whose forwarded addresses are trusted.

use tma_core::api::ActivitySettings;

use super::forms;
use super::parts::{self, FormAction, Tone};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::widgets;

pub(super) fn session_card(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let status = main.settings.activity.map(|a| (Tone::Neutral, forms::plural(i64::from(a.session_idle_days), "day")));
    let open = main.settings.open.contains("session");
    let busy = main.settings.busy == Some("session-timeout");
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::CLOCK,
        "Session timeout",
        "Sign users out after a period of inactivity",
        status,
        open,
        |ui| {
            let (min, max) = ActivitySettings::IDLE_DAYS;
            widgets::field(ui, "Days without activity", &mut main.settings.forms.idle_days, false, "30");
            parts::hint(
                ui,
                &format!(
                    "{min} to {max} days. Any activity resets the timer, so active users stay signed in. A shorter timeout also applies to existing sessions."
                ),
            );
            action = parts::form_actions(ui, busy, "Save", "Saving…");
        },
    );
    if clicked
        && main.settings.toggle_card("session")
        && let Some(a) = main.settings.activity
    {
        main.settings.forms.idle_days = a.session_idle_days.to_string();
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("session");
        }
        Some(FormAction::Save) => {
            match forms::whole_number(&main.settings.forms.idle_days, ActivitySettings::IDLE_DAYS, "Session timeout") {
                Err(e) => main.settings.report(e),
                Ok(days) => super::save(
                    tasks,
                    main,
                    "session-timeout",
                    move |c| async move { c.save_session_timeout(days).await },
                    |main, toasts, v| {
                        main.settings.activity = Some(v);
                        main.settings.open.remove("session");
                        toasts.success("Session timeout saved");
                    },
                ),
            }
        }
        None => {}
    }
}

pub(super) fn access_card(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let status = main.settings.activity.map(|a| {
        let tone = if a.access_time_tracking { Tone::Neutral } else { Tone::Warning };
        (tone, forms::access_time_label(a.access_time_tracking, a.access_time_window_minutes))
    });
    let open = main.settings.open.contains("access");
    let busy = main.settings.busy == Some("access-time");
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::CLOCK_COUNTER_CLOCKWISE,
        "Last opened tracking",
        "Record when files and folders are opened",
        status,
        open,
        |ui| {
            let f = &mut main.settings.forms;
            ui.checkbox(&mut f.access_enabled, "Record when items are opened");
            parts::hint(ui, "When off, Recent files and Last opened dates are no longer updated.");
            let (wmin, wmax) = ActivitySettings::WINDOW_MINUTES;
            let (fmin, fmax) = ActivitySettings::FLUSH_SECONDS;
            ui.add_enabled_ui(f.access_enabled, |ui| {
            widgets::field(ui, "Update window (minutes)", &mut f.access_window, false, "60");
            parts::hint(ui, &format!("{wmin} to {wmax}. Repeat opens within this window are not recorded again, which reduces database writes. Use 0 to record every open."));
            widgets::field(ui, "Write interval (seconds)", &mut f.access_flush, false, "10");
            parts::hint(ui, &format!("{fmin} to {fmax}. How often recorded opens are written to the database."));
        });
            action = parts::form_actions(ui, busy, "Save", "Saving…");
        },
    );
    if clicked
        && main.settings.toggle_card("access")
        && let Some(a) = main.settings.activity
    {
        let f = &mut main.settings.forms;
        f.access_enabled = a.access_time_tracking;
        f.access_window = a.access_time_window_minutes.to_string();
        f.access_flush = a.access_time_flush_seconds.to_string();
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("access");
        }
        Some(FormAction::Save) => {
            let f = &main.settings.forms;
            let enabled = f.access_enabled;
            let parsed = forms::whole_number(&f.access_window, ActivitySettings::WINDOW_MINUTES, "Update window")
                .and_then(|w| {
                    forms::whole_number(&f.access_flush, ActivitySettings::FLUSH_SECONDS, "Write interval")
                        .map(|s| (w, s))
                });
            match parsed {
                Err(e) => main.settings.report(e),
                Ok((window, flush)) => super::save(
                    tasks,
                    main,
                    "access-time",
                    move |c| async move { c.save_access_time(enabled, window, flush).await },
                    |main, toasts, v| {
                        main.settings.activity = Some(v);
                        main.settings.open.remove("access");
                        toasts.success("Access time settings saved");
                    },
                ),
            }
        }
        None => {}
    }
}

pub(super) fn proxies_card(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let status = main.settings.proxies.as_ref().map(|p| {
        if p.known_proxies.is_empty() {
            (Tone::Info, "Not set up".to_string())
        } else {
            (Tone::Success, forms::plural(p.known_proxies.len() as i64, "proxy").replace("proxys", "proxies"))
        }
    });
    let open = main.settings.open.contains("proxies");
    let busy = main.settings.busy == Some("proxies");
    let restart = main.settings.restart_required;
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::GLOBE_HEMISPHERE_WEST,
        "Known proxies",
        "Reverse proxies allowed to report the client IP address",
        status,
        open,
        |ui| {
            widgets::bordered_field(
                ui,
                egui::TextEdit::multiline(&mut main.settings.forms.proxies)
                    .desired_rows(3)
                    .desired_width(f32::INFINITY)
                    .hint_text("10.1.2.100, 172.18.0.0/16, proxy.example.com"),
            );
            parts::hint(
                ui,
                "Enter IP addresses, CIDR ranges or host names, separated by commas or new lines. Only these proxies may set X-Forwarded-For; with none listed, the header is ignored. Changes take effect after a server restart.",
            );
            action = parts::form_actions(ui, busy, "Save", "Saving…");
        },
    );
    if restart {
        parts::note(ui, Tone::Warning, "Restart the server to apply the new proxy list.");
    }
    if clicked
        && main.settings.toggle_card("proxies")
        && let Some(p) = &main.settings.proxies
    {
        main.settings.forms.proxies = p.known_proxies.join(", ");
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("proxies");
        }
        Some(FormAction::Save) => {
            let list = forms::parse_proxies(&main.settings.forms.proxies);
            super::save(
                tasks,
                main,
                "proxies",
                move |c| async move { c.save_known_proxies(&list).await },
                |main, toasts, v| {
                    main.settings.restart_required = v.restart_required.unwrap_or(true);
                    main.settings.proxies = Some(v);
                    main.settings.open.remove("proxies");
                    toasts.success("Known proxies saved. Restart the server to apply the change.");
                },
            );
        }
        None => {}
    }
}
