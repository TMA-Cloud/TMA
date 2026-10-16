//! Sub-users: extra logins on the owner's account, each with chosen permissions.

use egui::RichText;

use super::dialogs::{Dialog, SubUserForm};
use super::section;
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

pub fn show(main: &mut Main, ui: &mut egui::Ui, _tasks: &Tasks) {
    let t = widgets::tokens(ui);
    widgets::heading(
        ui,
        ph::USERS,
        "Sub-users",
        "People who use your files and storage with the permissions you choose.",
    );
    ui.add_space(12.0);
    if main.user.is_sub_user {
        ui.label(widgets::muted(ui, "Only the account owner manages sub-users."));
        return;
    }
    let mut open = None;
    section(ui, "Sub-users", "", |ui| {
        if widgets::primary(ui, format!("{}  Add sub-user", ph::USER_PLUS)).clicked() {
            open = Some(Dialog::SubUser(SubUserForm::new(None)));
        }
        ui.add_space(10.0);
        let Some(list) = &main.settings.sub_users else {
            ui.spinner();
            return;
        };
        if list.sub_users.is_empty() {
            ui.label(widgets::muted(ui, "No sub-users yet."));
        }
        for sub in &list.sub_users {
            widgets::separator(ui);
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.label(RichText::new(sub.name.clone().unwrap_or_else(|| sub.email.clone())).semibold());
                    ui.label(RichText::new(&sub.email).size(12.0).color(t.label_secondary));
                    ui.horizontal_wrapped(|ui| {
                        if sub.permissions.is_empty() {
                            ui.label(RichText::new("View only").size(11.0).color(t.label_tertiary));
                        }
                        for key in &sub.permissions {
                            let label = tma_core::Permission::from_key(key).map(|p| p.label()).unwrap_or(key.as_str());
                            widgets::badge(ui, label, t.accent);
                        }
                    });
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if widgets::icon_button(ui, ph::TRASH, "Remove").clicked() {
                        open = Some(Dialog::RemoveSubUser(sub.clone()));
                    }
                    if widgets::icon_button(ui, ph::PENCIL_SIMPLE, "Edit permissions").clicked() {
                        open = Some(Dialog::SubUser(SubUserForm::new(Some(sub.clone()))));
                    }
                });
            });
        }
    });
    if open.is_some() {
        main.settings.dialog = open;
    }
}
