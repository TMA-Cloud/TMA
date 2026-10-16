//! Storage: how much space the account uses, and (first user) the bucket the
//! instance stores files in, tested against the live service before saving.

use egui::RichText;
use tma_core::api::StorageSettingsInput;

use super::{fetch, save, section};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

pub fn load(main: &mut Main, tasks: &Tasks) {
    crate::app::load_usage(tasks, &main.client, main.generation);
    if main.instance.is_first_user {
        fetch(
            tasks,
            main,
            |c| async move { c.storage_config().await },
            |s, v| {
                s.forms.storage = StorageSettingsInput {
                    provider: v.provider.clone().unwrap_or_else(|| "s3".into()),
                    endpoint: v.endpoint.clone(),
                    region: v.region.clone(),
                    bucket: v.bucket.clone(),
                    force_path_style: v.force_path_style,
                    access_key_id: None,
                    secret_access_key: None,
                    expected_version: Some(v.version),
                };
                s.storage = Some(v);
            },
        );
    }
}

fn text(ui: &mut egui::Ui, label: &str, value: &mut Option<String>, hint: &str, password: bool) {
    let mut s = value.clone().unwrap_or_default();
    if widgets::field(ui, label, &mut s, password, hint).changed() {
        *value = Some(s).filter(|v| !v.is_empty());
    }
    ui.add_space(4.0);
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let t = widgets::tokens(ui);
    widgets::heading(ui, ph::HARD_DRIVES, "Storage", "Space used by your files.");
    ui.add_space(12.0);
    section(ui, "Usage", "", |ui| {
        if let Some(usage) = main.instance.usage {
            let total = usage.total.filter(|v| *v > 0);
            let label = match total {
                Some(total) => format!(
                    "{} of {} used",
                    tma_core::format::storage_size(usage.used),
                    tma_core::format::storage_size(total)
                ),
                None => format!("{} used · no limit", tma_core::format::storage_size(usage.used)),
            };
            ui.label(RichText::new(label).size(15.0).semibold());
            if let Some(total) = total {
                ui.add_space(6.0);
                widgets::progress_bar(ui, usage.used as f32 / total as f32, ui.available_width());
            }
        } else {
            ui.spinner();
        }
    });
    if !main.instance.is_first_user {
        return;
    }
    let configured = main.settings.storage.as_ref().is_some_and(|s| s.configured);
    let subtitle = if configured {
        "Files are stored in this S3-compatible bucket."
    } else {
        "Connect an S3-compatible bucket to start storing files."
    };
    let busy = main.settings.busy;
    section(ui, "Object storage", subtitle, |ui| {
        if let Some(summary) = &main.settings.storage
            && summary.configured
        {
            ui.horizontal(|ui| {
                widgets::badge(ui, "Connected", t.positive_text);
                if let Some(key) = &summary.access_key_id_masked {
                    ui.label(widgets::muted(ui, format!("Access key {key}")));
                }
            });
            ui.add_space(8.0);
        }
        let f = &mut main.settings.forms;
        ui.label(RichText::new("Provider").size(12.0).color(t.label_secondary));
        egui::ComboBox::from_id_salt("provider")
            .selected_text(match f.storage.provider.as_str() {
                "aws" => "Amazon S3",
                "r2" => "Cloudflare R2",
                _ => "S3-compatible (MinIO, RustFS, Ceph…)",
            })
            .width(320.0)
            .show_ui(ui, |ui| {
                ui.selectable_value(&mut f.storage.provider, "s3".to_string(), "S3-compatible (MinIO, RustFS, Ceph…)");
                ui.selectable_value(&mut f.storage.provider, "aws".to_string(), "Amazon S3");
                ui.selectable_value(&mut f.storage.provider, "r2".to_string(), "Cloudflare R2");
            });
        ui.add_space(6.0);
        let endpoint_hint = if f.storage.provider == "r2" {
            "https://<account>.r2.cloudflarestorage.com"
        } else {
            "https://s3.example.com"
        };
        text(ui, "Endpoint", &mut f.storage.endpoint, endpoint_hint, false);
        text(ui, "Region", &mut f.storage.region, if f.storage.provider == "r2" { "auto" } else { "us-east-1" }, false);
        text(ui, "Bucket", &mut f.storage.bucket, "tma-cloud", false);
        let key_hint = if configured { "Leave blank to keep the saved key" } else { "" };
        text(ui, "Access key ID", &mut f.storage.access_key_id, key_hint, false);
        text(ui, "Secret access key", &mut f.storage.secret_access_key, key_hint, true);
        if f.storage.provider == "s3" {
            let mut path_style = f.storage.force_path_style.unwrap_or(true);
            widgets::setting_row(ui, "Path-style addressing", "Most self-hosted servers need this.", |ui| {
                if widgets::toggle(ui, &mut path_style).changed() {
                    f.storage.force_path_style = Some(path_style);
                }
            });
        }
        if !f.storage_checks.is_empty() {
            for check in &f.storage_checks {
                ui.label(RichText::new(format!("{}  {check}", ph::CHECK)).color(t.positive_text));
            }
            ui.add_space(4.0);
        }
        ui.add_space(6.0);
        let input = f.storage.clone();
        ui.horizontal(|ui| {
            if widgets::secondary(ui, if busy == Some("storage-test") { "Testing…" } else { "Test connection" })
                .clicked()
                && busy.is_none()
            {
                let input = input.clone();
                save(
                    tasks,
                    main,
                    "storage-test",
                    move |c| async move { c.test_storage_config(&input).await },
                    |main, toasts, result| {
                        main.settings.forms.storage_checks = result.checks;
                        toasts.success("The bucket works");
                    },
                );
            }
            if widgets::primary_enabled(
                ui,
                busy.is_none(),
                if busy == Some("storage-save") { "Saving…" } else { "Save" },
            )
            .clicked()
            {
                save(
                    tasks,
                    main,
                    "storage-save",
                    move |c| async move { c.save_storage_config(&input).await },
                    |main, toasts, summary| {
                        main.settings.forms.storage.expected_version = Some(summary.version);
                        main.settings.forms.storage.access_key_id = None;
                        main.settings.forms.storage.secret_access_key = None;
                        main.settings.storage = Some(summary);
                        main.instance.storage_configured = true;
                        toasts.success("Storage saved");
                    },
                );
            }
        });
    });
}
