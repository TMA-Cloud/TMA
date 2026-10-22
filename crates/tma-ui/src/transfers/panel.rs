//! The transfer panel: one line per upload, download or server job, in the
//! bottom-right corner (above the tab bar on a phone), with the toasts above it.

use std::sync::atomic::Ordering;

use egui::{Align2, CornerRadius, Frame, Margin, RichText, Sense, Stroke, Vec2};

use super::{Direction, HIDE_AFTER, PANEL_HEIGHT, State, Transfer, kind, outcome};
use crate::app::Main;
use crate::icons::ph;
use crate::theme::Weight;
use crate::widgets;

pub fn show(main: &mut Main, ctx: &egui::Context) {
    let phone = widgets::mobile(ctx);
    let width = if phone { (ctx.content_rect().width() - 40.0).min(420.0) } else { 320.0 };
    let t = crate::widgets::tokens_ctx(ctx);
    ctx.data_mut(|d| d.insert_temp(egui::Id::unique(PANEL_HEIGHT), 0.0f32));
    if main.transfers.items.is_empty() {
        return;
    }
    let failed =
        main.transfers.items.iter().filter(|i| outcome(&i.state) == crate::transfer_text::Outcome::Failed).count();
    let busy = main.transfers.is_busy();
    let now = ctx.input(|i| i.time);
    if busy {
        main.transfers.finished_at = None;
        ctx.request_repaint_after(std::time::Duration::from_millis(150));
    } else if failed == 0 {
        let since = *main.transfers.finished_at.get_or_insert(now);
        if now - since > HIDE_AFTER {
            main.transfers.items.clear();
            main.transfers.finished_at = None;
            return;
        }
        ctx.request_repaint_after(std::time::Duration::from_millis(500));
    }
    let title = {
        let rows: Vec<_> =
            main.transfers.items.iter().map(|i| (kind(i.direction), outcome(&i.state), i.name.as_str())).collect();
        crate::transfer_text::headline(&rows)
    };
    let mut clear = false;
    let mut cancel_all = false;
    let area = egui::Area::new(egui::Id::unique("transfers"))
        // Bottom-right with the toasts stacked above it; on a phone it spans the width above the tab bar.
        .anchor(
            if phone { Align2::CENTER_BOTTOM } else { Align2::RIGHT_BOTTOM },
            if phone { [0.0, -70.0] } else { [-18.0, -18.0] },
        )
        .order(egui::Order::Foreground)
        .show(ctx, |ui| {
            Frame::new()
                .fill(t.surface_raised)
                .stroke(Stroke::new(1.0, t.separator))
                .corner_radius(CornerRadius::same(14))
                .inner_margin(Margin::same(12))
                .shadow(egui::epaint::Shadow {
                    offset: [0, 8],
                    blur: 24,
                    spread: 0,
                    color: egui::Color32::from_black_alpha(45),
                })
                .show(ui, |ui| {
                    ui.set_width(width);
                    ui.horizontal(|ui| {
                        let icon = if busy {
                            RichText::new(ph::ARROWS_DOWN_UP).color(t.accent)
                        } else if failed > 0 {
                            RichText::new(ph::WARNING_CIRCLE).color(t.destructive_text)
                        } else {
                            RichText::new(ph::CHECK_CIRCLE).color(t.positive_text)
                        };
                        ui.label(icon.size(16.0));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if !busy && widgets::icon_button(ui, ph::X, "Dismiss").clicked() {
                                clear = true;
                            }
                            if main.transfers.can_cancel()
                                && widgets::icon_button(ui, ph::X_CIRCLE, "Cancel all").clicked()
                            {
                                cancel_all = true;
                            }
                            let icon = if main.transfers.expanded { ph::CARET_DOWN } else { ph::CARET_UP };
                            let tip = if main.transfers.expanded { "Hide details" } else { "Show details" };
                            if widgets::icon_button(ui, icon, tip).clicked() {
                                main.transfers.expanded = !main.transfers.expanded;
                            }
                            // The buttons take their room first; the heading truncates in what is left.
                            ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                                ui.add(egui::Label::new(RichText::new(&title).semibold()).truncate());
                            });
                        });
                    });
                    let fraction = {
                        let (d, tot) = main.transfers.items.iter().fold((0u64, 0u64), |(d, tot), i| {
                            (
                                d + i.progress.done.load(Ordering::Relaxed),
                                tot + i.progress.total.load(Ordering::Relaxed),
                            )
                        });
                        if tot == 0 { 0.0 } else { d as f32 / tot as f32 }
                    };
                    if busy && fraction == 0.0 {
                        widgets::busy_bar(ui, width);
                    } else if busy {
                        widgets::progress_bar(ui, fraction, width);
                    }
                    if main.transfers.expanded {
                        ui.add_space(8.0);
                        egui::ScrollArea::vertical().max_height(240.0).show(ui, |ui| {
                            for item in main.transfers.items.iter().rev() {
                                row(ui, item, &t);
                            }
                        });
                    }
                });
        });
    // Reading it keeps a finished panel up while the pointer is over it.
    // Toasts share the corner and stack above the panel.
    ctx.data_mut(|d| d.insert_temp(egui::Id::unique(PANEL_HEIGHT), area.response.rect.height()));
    if area.response.contains_pointer() && main.transfers.finished_at.is_some() {
        main.transfers.finished_at = Some(now);
    }
    for item in &mut main.transfers.items {
        if item.state == State::Queued && item.progress.is_cancelled() {
            item.state = State::Failed("Cancelled".into());
        }
    }
    if clear {
        main.transfers.items.clear();
    }
    if cancel_all {
        main.transfers.cancel_all();
    }
}

/// One item: its icon and name, with what is happening on the right. Only a
/// running item's progress or a failure's reason takes a second line.
fn row(ui: &mut egui::Ui, item: &Transfer, t: &crate::theme::Tokens) {
    const ICON: f32 = 22.0;
    let width = ui.available_width();
    let second_line = matches!(item.state, State::Running | State::Failed(_));
    let height = if second_line { 44.0 } else { 32.0 };
    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, height), Sense::hover());
    if response.hovered() {
        ui.painter().rect_filled(rect, CornerRadius::same(8), t.fill_quaternary);
    }
    let top = rect.top() + 16.0;
    let icon_rect = egui::Rect::from_center_size(egui::pos2(rect.left() + 4.0 + ICON / 2.0, top), Vec2::splat(ICON));
    match item.direction {
        Direction::Job(icon) => {
            ui.painter().text(
                icon_rect.center(),
                Align2::CENTER_CENTER,
                icon,
                egui::FontId::proportional(16.0),
                t.label_secondary,
            );
        }
        _ => crate::icons::file(ui.painter(), icon_rect, t, &item.name, None),
    }
    // The right side: cancel while working, a mark when finished.
    let right = rect.right() - 6.0;
    let mut name_right = right - 26.0;
    match &item.state {
        State::Running | State::Queued => {
            let cancel = egui::Rect::from_center_size(egui::pos2(right - 11.0, top), Vec2::splat(22.0));
            let r = ui.interact(cancel, response.id.with("cancel"), Sense::click()).on_hover_text("Cancel");
            let color = if r.hovered() { t.destructive_text } else { t.label_tertiary };
            ui.painter().text(
                cancel.center(),
                Align2::CENTER_CENTER,
                ph::X_CIRCLE,
                egui::FontId::proportional(16.0),
                color,
            );
            if r.clicked() {
                item.progress.cancel();
            }
            if item.state == State::Queued {
                let waiting =
                    ui.painter().layout_no_wrap("Waiting".into(), egui::FontId::proportional(12.0), t.label_tertiary);
                name_right = cancel.left() - waiting.size().x - 8.0;
                ui.painter().galley(
                    egui::pos2(name_right + 4.0, top - waiting.size().y / 2.0),
                    waiting,
                    t.label_tertiary,
                );
            }
        }
        State::Done => {
            let _ = response.clone().on_hover_text(crate::transfer_text::row_status(kind(item.direction)));
            ui.painter().text(
                egui::pos2(right - 11.0, top),
                Align2::CENTER_CENTER,
                ph::CHECK_CIRCLE,
                egui::FontId::proportional(16.0),
                t.positive_text,
            );
        }
        State::Failed(_) => {
            ui.painter().text(
                egui::pos2(right - 11.0, top),
                Align2::CENTER_CENTER,
                ph::WARNING_CIRCLE,
                egui::FontId::proportional(16.0),
                t.destructive_text,
            );
        }
    }
    let text_left = icon_rect.right() + 10.0;
    let name = match (item.direction, &item.state) {
        (Direction::Job(_), State::Done) => crate::transfer_text::finished(&item.name),
        _ => item.name.clone(),
    };
    let mut job = egui::text::LayoutJob::simple_singleline(name, egui::FontId::proportional(13.0), t.label);
    job.wrap = egui::text::TextWrapping::truncate_at_width((name_right - text_left).max(20.0));
    let galley = ui.painter().layout_job(job);
    ui.painter().galley(egui::pos2(text_left, top - galley.size().y / 2.0), galley, t.label);
    let line = egui::Rect::from_min_max(egui::pos2(text_left, top + 12.0), egui::pos2(name_right, rect.bottom() - 4.0));
    match &item.state {
        // No byte counts: a bar that moves rather than one that fills.
        State::Running => {
            let bar =
                egui::Rect::from_min_size(egui::pos2(line.left(), line.center().y - 2.0), Vec2::new(line.width(), 4.0));
            let mut child = ui.new_child(egui::UiBuilder::new().max_rect(bar));
            if item.progress.total.load(Ordering::Relaxed) == 0 {
                widgets::busy_bar(&mut child, bar.width());
            } else {
                widgets::progress_bar(&mut child, item.progress.fraction(), bar.width());
            }
        }
        State::Failed(msg) => {
            let mut job = egui::text::LayoutJob::simple_singleline(
                msg.clone(),
                egui::FontId::proportional(12.0),
                t.destructive_text,
            );
            job.wrap = egui::text::TextWrapping::truncate_at_width(line.width().max(20.0));
            let galley = ui.painter().layout_job(job);
            // The whole reason when it is cut short.
            let _ = response.clone().on_hover_text(msg);
            ui.painter().galley(
                egui::pos2(line.left(), line.center().y - galley.size().y / 2.0),
                galley,
                t.destructive_text,
            );
        }
        _ => {}
    }
}
