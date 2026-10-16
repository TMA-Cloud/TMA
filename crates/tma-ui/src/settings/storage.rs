//! Storage: the bucket every file lives in (first user), the account's usage,
//! and the largest file anyone may upload.

use egui::RichText;

use super::bucket_form::{self, BucketForm, CheckResult};
use super::forms::{self, Unit};
use super::parts::{self, FormAction, Tone};
use super::{attempt, fetch, save, section};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::widgets;

pub fn load(main: &mut Main, tasks: &Tasks) {
    crate::app::load_usage(tasks, &main.client, main.generation);
    if !main.instance.is_first_user {
        return;
    }
    fetch(
        tasks,
        main,
        |c| async move { c.storage_config().await },
        |s, v| {
            s.forms.bucket = BucketForm::from_summary(&v);
            // With nothing connected there is nothing else to show: open the form.
            if !v.configured {
                s.open.insert("bucket");
            }
            s.storage = Some(v);
        },
    );
    fetch(tasks, main, |c| async move { c.max_upload().await }, |s, v| s.max_upload = Some(v));
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    widgets::heading(ui, ph::HARD_DRIVES, "Storage", "Storage use, the storage bucket and upload limits.");
    ui.add_space(4.0);
    let admin = main.instance.is_first_user;
    if admin {
        section(ui, "Bucket", "The S3-compatible bucket where all files are stored.", |ui| {
            bucket_card(main, ui, tasks)
        });
    } else if !main.instance.storage_configured {
        ui.add_space(6.0);
        parts::note(
            ui,
            Tone::Warning,
            "Storage is not set up yet, so files cannot be uploaded or opened. Contact your administrator.",
        );
    }
    let usage = main.instance.usage;
    section(ui, "Usage", "Storage used by your account.", |ui| parts::meter(ui, usage));
    if admin {
        section(ui, "Limits", "These apply to every user on this server.", |ui| upload_card(main, ui, tasks));
    } else {
        ui.add_space(8.0);
        parts::note(ui, Tone::Neutral, "Storage limits and the maximum upload size are managed by your administrator.");
    }
}

fn upload_card(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let status = main.settings.max_upload.map(|m| (Tone::Neutral, forms::upload_limit_label(m.max_bytes)));
    let open = main.settings.open.contains("upload");
    let busy = main.settings.busy == Some("max-upload");
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::UPLOAD_SIMPLE,
        "Max upload size",
        "Maximum size of a single uploaded file",
        status,
        open,
        |ui| {
            let f = &mut main.settings.forms;
            ui.label(RichText::new("Max upload size").size(12.0).color(widgets::tokens(ui).label_secondary));
            ui.horizontal(|ui| {
                widgets::text_edit(ui, &mut f.max_upload, "10", 120.0);
                let before = f.max_upload_unit;
                egui::ComboBox::from_id_salt("upload-unit")
                    .selected_text(f.max_upload_unit.label())
                    .width(60.0)
                    .show_ui(ui, |ui| {
                        for unit in [Unit::Mb, Unit::Gb] {
                            ui.selectable_value(&mut f.max_upload_unit, unit, unit.label());
                        }
                    });
                if before != f.max_upload_unit {
                    f.max_upload = forms::convert_size(&f.max_upload, before, f.max_upload_unit);
                }
            });
            parts::hint(ui, "Allowed range: 1 MB to 100 GB per file");
            action = parts::form_actions(ui, busy, "Save", "Saving…");
        },
    );
    if clicked
        && main.settings.toggle_card("upload")
        && let Some(m) = main.settings.max_upload
    {
        let (value, unit) = forms::split_size(Some(m.max_bytes), Unit::Gb);
        main.settings.forms.max_upload = value;
        main.settings.forms.max_upload_unit = unit;
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("upload");
        }
        Some(FormAction::Save) => {
            let f = &main.settings.forms;
            let (min, max) = forms::UPLOAD_LIMIT;
            match forms::size_bytes(&f.max_upload, f.max_upload_unit).filter(|b| (min..=max).contains(b)) {
                None => main.settings.report("Enter a value between 1 MB and 100 GB".into()),
                Some(bytes) => save(
                    tasks,
                    main,
                    "max-upload",
                    move |c| async move { c.save_max_upload(bytes).await },
                    |main, toasts, v| {
                        main.instance.max_upload = v.max_bytes;
                        main.settings.max_upload = Some(v);
                        main.settings.open.remove("upload");
                        toasts.success("Max upload size saved");
                    },
                ),
            }
        }
        None => {}
    }
}

fn text(ui: &mut egui::Ui, label: &str, value: &mut String, hint: &str) {
    widgets::field(ui, label, value, false, hint);
}

fn combo(ui: &mut egui::Ui, id: &str, label: &str, value: &mut String, options: &[(&str, &str)]) {
    let t = widgets::tokens(ui);
    ui.label(RichText::new(label).size(12.0).color(t.label_secondary));
    let shown = options.iter().find(|o| o.0 == value).map_or("", |o| o.1);
    egui::ComboBox::from_id_salt(id).selected_text(shown).width(ui.available_width().min(360.0)).show_ui(ui, |ui| {
        for (key, name) in options {
            ui.selectable_value(value, key.to_string(), *name);
        }
    });
    ui.add_space(4.0);
}

fn result_box(ui: &mut egui::Ui, result: &CheckResult) {
    let passed = if result.checks.is_empty() {
        String::new()
    } else {
        let names: Vec<&str> = result.checks.iter().map(|c| bucket_form::check_label(c)).collect();
        format!("\nPassed: {}", names.join(" · "))
    };
    let failed =
        result.step.as_deref().map(|s| format!("{} failed: ", bucket_form::check_label(s))).unwrap_or_default();
    let tone = if result.ok { Tone::Success } else { Tone::Danger };
    parts::note(ui, tone, &format!("{failed}{}{passed}", result.message));
}

fn bucket_card(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let summary = main.settings.storage.clone();
    let configured = summary.as_ref().is_some_and(|s| s.configured);
    let status = summary.as_ref().map(|s| match (&s.provider, &s.bucket) {
        (Some(p), Some(b)) if s.configured => (Tone::Success, format!("{} · {b}", bucket_form::provider_label(p))),
        _ => (Tone::Warning, "Not set up".to_string()),
    });
    let open = main.settings.open.contains("bucket");
    let busy = main.settings.busy;
    let working = matches!(busy, Some("storage-test" | "storage-save"));
    let mut test = false;
    let mut save_now = false;
    let mut cancel = false;
    let description = "Files are encrypted before they are stored";
    let clicked = parts::config_card(ui, ph::DATABASE, "Storage bucket", description, status, open, |ui| {
        let f = &mut main.settings.forms;
        let before = f.bucket.clone();
        if !configured {
            parts::note(
                ui,
                Tone::Warning,
                "No storage bucket is connected, so files cannot be uploaded or opened. Create a private bucket and an access key restricted to it, then enter the details below.",
            );
            ui.add_space(4.0);
        }
        let b = &mut f.bucket;
        combo(ui, "provider", "Provider", &mut b.provider, &bucket_form::PROVIDERS);
        if b.provider == "r2" {
            text(ui, "Account ID", &mut b.account_id, "0123456789abcdef0123456789abcdef");
            parts::hint(ui, "Shown on the R2 overview page in the Cloudflare dashboard");
            combo(ui, "jurisdiction", "Jurisdiction", &mut b.jurisdiction, &bucket_form::JURISDICTIONS);
        } else {
            let aws = b.provider == "aws";
            let placeholder = if aws { "https://s3.eu-west-1.amazonaws.com" } else { "https://s3.example.com" };
            text(ui, if aws { "Endpoint (optional)" } else { "Endpoint URL" }, &mut b.endpoint, placeholder);
            parts::hint(
                ui,
                if aws {
                    "Leave blank to use the standard endpoint for the region"
                } else {
                    "https:// for public hosts; http:// is accepted only on a private network"
                },
            );
            text(
                ui,
                if aws { "Region" } else { "Region (optional)" },
                &mut b.region,
                if aws { "eu-west-1" } else { "us-east-1" },
            );
            ui.add_space(4.0);
        }
        text(ui, "Bucket name", &mut b.bucket, "tma-cloud-files");
        ui.add_space(4.0);
        if b.provider == "s3" {
            ui.checkbox(&mut b.force_path_style, "Path-style addressing");
            parts::hint(ui, "Needed by RustFS and MinIO unless they serve buckets on their own subdomains");
        }
        let masked = summary.as_ref().and_then(|s| s.access_key_id_masked.clone());
        let keep_key = masked.map(|m| format!("Keep {m}")).unwrap_or_default();
        text(ui, "Access key ID", &mut b.access_key_id, if configured { &keep_key } else { "" });
        ui.add_space(4.0);
        parts::secret_field(
            ui,
            "Secret access key",
            &mut b.secret_access_key,
            if configured { "Keep the saved secret" } else { "" },
        );
        if configured {
            ui.add_space(4.0);
            parts::note(
                ui,
                Tone::Neutral,
                "Leave both keys blank to keep the saved ones. A different endpoint or bucket is only accepted if it already holds the files stored so far.",
            );
        }
        if *b != before {
            f.bucket_result = None;
        }
        if let Some(result) = &f.bucket_result {
            ui.add_space(4.0);
            result_box(ui, result);
        }
        widgets::dialog_footer(ui, |ui| {
            let saving = if busy == Some("storage-save") { "Verifying and saving…" } else { "Save" };
            save_now = widgets::primary_enabled(ui, !working, saving).clicked();
            let testing = if busy == Some("storage-test") { "Testing…" } else { "Test connection" };
            test = ui.add_enabled(!working, egui::Button::new(testing)).clicked();
            if configured {
                cancel = ui.add_enabled(!working, egui::Button::new("Cancel")).clicked();
            }
        });
    });
    if !open && let Some(s) = summary.as_ref().filter(|s| s.configured) {
        let endpoint = s.endpoint.clone().unwrap_or_default();
        let key = s.access_key_id_masked.clone().unwrap_or_default();
        ui.label(
            RichText::new(format!("{endpoint} · access key {key}"))
                .size(11.5)
                .monospace()
                .color(widgets::tokens(ui).label_tertiary),
        );
    }
    if clicked
        && main.settings.toggle_card("bucket")
        && let Some(s) = &summary
    {
        main.settings.forms.bucket = BucketForm::from_summary(s);
        main.settings.forms.bucket_result = None;
    }
    if cancel {
        main.settings.open.remove("bucket");
        main.settings.forms.bucket_result = None;
    }
    if !(test || save_now) {
        return;
    }
    let form = main.settings.forms.bucket.clone();
    if let Some(problem) = form.problem(configured) {
        main.settings.forms.bucket_result = Some(CheckResult { message: problem.into(), ..Default::default() });
        return;
    }
    if test {
        let input = form.to_input(None);
        attempt(
            tasks,
            main,
            "storage-test",
            move |c| async move { c.test_storage_config(&input).await },
            |main, _, result| {
                main.settings.forms.bucket_result = Some(match result {
                    Ok(r) => CheckResult {
                        ok: true,
                        message: "Connection successful. Save to start using this bucket.".into(),
                        step: None,
                        checks: r.checks,
                    },
                    Err(err) => CheckResult::failed(&err),
                });
            },
        );
    } else {
        let input = form.to_input(summary.as_ref().map(|s| s.version));
        attempt(
            tasks,
            main,
            "storage-save",
            move |c| async move { c.save_storage_config(&input).await },
            |main, toasts, result| match result {
                Ok(summary) => {
                    main.settings.forms.bucket = BucketForm::from_summary(&summary);
                    main.settings.forms.bucket_result = None;
                    main.settings.storage = Some(summary);
                    main.settings.open.remove("bucket");
                    main.instance.storage_configured = true;
                    toasts.success("Storage connected");
                }
                Err(err) => main.settings.forms.bucket_result = Some(CheckResult::failed(&err)),
            },
        );
    }
}
