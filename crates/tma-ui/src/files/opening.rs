//! Files being opened: the icon pops when one is opened, then a ring spins
//! round it until the file is open, so a slow open (Windows downloading a
//! Cloud Drive file, the editor loading) never looks like nothing happened.
//! Kept in the egui context so any view, and the desktop host, can reach it.

use std::collections::HashMap;
use std::f32::consts::{PI, TAU};

use egui::{Color32, Context, Id, Painter, Rect, Stroke};

use crate::theme::{self, Tokens};

/// How long the icon's pop lasts.
const POP: f64 = 0.28;
/// The ring stays at least this long, so a fast open still reads as one.
const MIN_BUSY: f64 = 0.6;
/// How long the ring takes to fade once the file is open.
const FADE: f64 = 0.25;
/// An open that never reports back stops spinning after this long.
const GIVE_UP: f64 = 20.0;

/// When each file started opening, and when it finished, if it has.
type Starts = HashMap<String, (f64, Option<f64>)>;

fn key() -> Id {
    Id::unique("tma-files-opening")
}

fn now(ctx: &Context) -> f64 {
    ctx.input(|i| i.time)
}

/// Note that a file has started opening.
pub fn start(ctx: &Context, id: &str) {
    let at = now(ctx);
    ctx.data_mut(|d| d.get_temp_mut_or_default::<Starts>(key()).insert(id.to_string(), (at, None)));
    ctx.request_repaint();
}

/// Note that a file is open, or failed to open: its ring fades out.
pub fn finish(ctx: &Context, id: &str) {
    let at = now(ctx);
    ctx.data_mut(|d| {
        if let Some(entry) = d.get_temp_mut_or_default::<Starts>(key()).get_mut(id) {
            entry.1.get_or_insert(at);
        }
    });
    ctx.request_repaint();
}

/// How a file being opened looks this frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    /// The icon's scale, swelling briefly from 1.
    pub scale: f32,
    /// How visible the ring and tint are, 0 to 1.
    pub busy: f32,
    /// Seconds since opening began, which turns the ring.
    pub age: f32,
}

/// The look at `now` of a file that started opening at `start` and finished
/// at `end`; None once it has faded out.
pub fn look_at(now: f64, start: f64, end: Option<f64>) -> Option<Look> {
    let age = now - start;
    let pop = (age / POP).clamp(0.0, 1.0) as f32;
    let scale = if pop < 1.0 { 1.0 + 0.14 * (pop * PI).sin() } else { 1.0 };
    let end = end.unwrap_or(start + GIVE_UP).max(start + MIN_BUSY);
    let fading = ((now - end) / FADE).clamp(0.0, 1.0) as f32;
    let fade_in = (age / 0.12).clamp(0.0, 1.0) as f32;
    if fading >= 1.0 && pop >= 1.0 {
        return None;
    }
    Some(Look { scale, busy: fade_in * (1.0 - fading), age: age as f32 })
}

/// How this file looks while opening, or None when it is not; keeps frames
/// coming while anything moves, and forgets files that have faded out.
pub fn look(ctx: &Context, id: &str) -> Option<Look> {
    let at = now(ctx);
    let (start, end) = ctx.data(|d| d.get_temp::<Starts>(key()).and_then(|s| s.get(id).copied()))?;
    match look_at(at, start, end) {
        Some(look) => {
            ctx.request_repaint();
            Some(look)
        }
        None => {
            ctx.data_mut(|d| d.get_temp_mut_or_default::<Starts>(key()).remove(id));
            None
        }
    }
}

/// The icon's rect, swollen by the pop.
pub fn icon_rect(rect: Rect, look: Option<Look>) -> Rect {
    match look {
        Some(l) => Rect::from_center_size(rect.center(), rect.size() * l.scale),
        None => rect,
    }
}

/// A soft accent tint over the item and a turning arc round its icon.
pub fn paint(painter: &Painter, item: Rect, radius: u8, icon: Rect, look: Option<Look>, t: &Tokens) {
    let Some(look) = look.filter(|l| l.busy > 0.0) else { return };
    painter.rect_filled(item, radius, theme::mix(Color32::TRANSPARENT, t.accent_fill, look.busy));
    let r = icon.width().max(icon.height()) / 2.0 + 5.0;
    let center = icon.center();
    painter.circle_stroke(center, r, Stroke::new(2.0, theme::mix(Color32::TRANSPARENT, t.fill_tertiary, look.busy)));
    // A quarter-to-third arc that breathes as it turns, like a system spinner.
    let turn = look.age * TAU * 1.1;
    let span = TAU * (0.22 + 0.1 * (look.age * 3.0).sin());
    let points: Vec<egui::Pos2> = (0..=24)
        .map(|i| {
            let a = turn + span * i as f32 / 24.0;
            center + egui::vec2(a.cos(), a.sin()) * r
        })
        .collect();
    let color = theme::mix(Color32::TRANSPARENT, t.accent, look.busy);
    painter.add(egui::Shape::line(points, Stroke::new(2.0, color)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pops_spins_and_fades() {
        let start = 10.0;
        let peak = look_at(start + POP / 2.0, start, None).unwrap_or_else(|| unreachable!("still opening"));
        assert!(peak.scale > 1.1);
        let busy = look_at(start + 3.0, start, None).unwrap_or_else(|| unreachable!("still opening"));
        assert_eq!((busy.scale, busy.busy), (1.0, 1.0));
        // A fast open keeps its ring for the minimum, then fades out.
        assert_eq!(
            look_at(start + 0.5, start, Some(start + 0.1)).unwrap_or_else(|| unreachable!("still opening")).busy,
            1.0
        );
        assert!(
            look_at(start + MIN_BUSY + FADE / 2.0, start, Some(start + 0.1))
                .unwrap_or_else(|| unreachable!("still opening"))
                .busy
                < 1.0
        );
        assert_eq!(look_at(start + MIN_BUSY + FADE, start, Some(start + 0.1)), None);
        // One that never reports back gives up.
        assert_eq!(look_at(start + GIVE_UP + FADE, start, None), None);
    }
}
