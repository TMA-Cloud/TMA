//! Where the window was: its normal size and position, and whether it was
//! maximized, kept apart. eframe's own memory saves the maximized size as the
//! normal one, so Restore after a restart came back nearly full screen.

use serde::{Deserialize, Serialize};

const FILE: &str = "window.json";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    /// The normal (not maximized) inner size and outer position, in points.
    pub size: [f32; 2],
    pub position: Option<[f32; 2]>,
    pub maximized: bool,
}

impl Default for Placement {
    fn default() -> Self {
        Self { size: [1280.0, 820.0], position: None, maximized: false }
    }
}

impl Placement {
    /// Build the window at its normal size, maximized on top if it was. On Windows
    /// it is maximized later, while cloaked: maximizing at creation shows the window
    /// before the app can hide it (see `Reveal`).
    pub fn apply(&self, builder: egui::ViewportBuilder) -> egui::ViewportBuilder {
        let mut builder = builder.with_inner_size(self.size).with_maximized(self.maximized && !cfg!(windows));
        if let Some(position) = self.position {
            builder = builder.with_position(position);
        }
        builder
    }

    /// Follow the window: while it is a normal window its size and position are the
    /// ones to restore; while maximized or minimized only the flag changes.
    pub fn observe(&mut self, info: &egui::ViewportInfo) {
        if info.minimized == Some(true) {
            return;
        }
        let maximized = info.maximized == Some(true) || info.fullscreen == Some(true);
        self.maximized = maximized;
        if maximized {
            return;
        }
        if let Some(inner) = info.inner_rect.filter(|r| r.width() >= 200.0 && r.height() >= 150.0) {
            self.size = [inner.width(), inner.height()];
        }
        if let Some(outer) = info.outer_rect {
            self.position = Some([outer.min.x, outer.min.y]);
        }
    }

    /// A saved placement, or none if it is missing, unreadable or off every screen.
    pub fn load() -> Option<Self> {
        let text = std::fs::read_to_string(path()?).ok()?;
        let mut placement: Self = serde_json::from_str(&text).ok()?;
        placement.size = [placement.size[0].clamp(880.0, 8192.0), placement.size[1].clamp(560.0, 8192.0)];
        // A monitor that was unplugged leaves the position far outside any screen.
        if placement.position.is_some_and(|[x, y]| !(-4000.0..16000.0).contains(&x) || !(-200.0..12000.0).contains(&y))
        {
            placement.position = None;
        }
        Some(placement)
    }

    pub fn save(&self) {
        let Some(path) = path() else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(self) {
            let _ = std::fs::write(path, text);
        }
    }
}

/// Room kept for the taskbar or dock, which the monitor size includes.
const TASKBAR: f32 = 48.0;
/// The share of the screen the window may take when it has to shrink.
const SCREEN_SHARE: f32 = 0.92;

/// A window size and position that fit the screen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    pub inner: egui::Vec2,
    pub position: egui::Pos2,
}

/// Where the opening window should go on a monitor of `monitor` points: with no
/// saved place (`first`) it is centred, and a window bigger than the screen
/// (a small or scaled laptop screen) shrinks to fit. None when it already fits.
pub fn fit(monitor: egui::Vec2, inner: egui::Rect, outer: egui::Rect, first: bool) -> Option<Fit> {
    if monitor.x <= 0.0 || monitor.y <= 0.0 {
        return None;
    }
    let frame = (outer.size() - inner.size()).max(egui::Vec2::ZERO);
    let screen = egui::vec2(monitor.x, monitor.y - TASKBAR);
    let too_big = outer.width() > screen.x || outer.height() > screen.y;
    if !first && !too_big {
        return None;
    }
    let size = if too_big { inner.size().min(screen * SCREEN_SHARE - frame) } else { inner.size() };
    let position = ((screen - size - frame) / 2.0).max(egui::Vec2::ZERO).to_pos2();
    Some(Fit { inner: size, position })
}

fn path() -> Option<std::path::PathBuf> {
    Some(dirs::config_dir()?.join("TMA Cloud").join(FILE))
}

/// What to do with the window this frame while it opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Keep it off the screen (it is still shown, maximized and drawn).
    Cloak,
    Wait,
    /// It has drawn at its final size: put it on the screen.
    Uncloak,
    Done,
}

/// Opening a window that should be maximized shows it at its normal size first
/// (unpainted, so white) and then maximizes it, and the first frames after a
/// resize are empty, and the app shows only a spinner while it checks the saved
/// sign-in. The window stays cloaked until the app has something to show, it is
/// maximized when it should be, and its size has held for a few frames.
#[derive(Debug, Default)]
pub struct Reveal {
    started: Option<f64>,
    stable: u32,
    last: Option<egui::Vec2>,
    done: bool,
}

/// Frames at the final size before showing: the first one after a resize is blank.
const STABLE_FRAMES: u32 = 3;
/// Never hide a window longer than this: a slow server still gets its spinner shown.
const GIVE_UP_AFTER: f64 = 1.5;

impl Reveal {
    pub fn step(&mut self, now: f64, want_maximized: bool, ready: bool, info: &egui::ViewportInfo) -> Step {
        if self.done {
            return Step::Done;
        }
        let Some(started) = self.started else {
            self.started = Some(now);
            return Step::Cloak;
        };
        let size = info.inner_rect.map(|r| r.size());
        let in_place = ready && (!want_maximized || info.maximized == Some(true));
        self.stable = if in_place && size.is_some() && size == self.last { self.stable + 1 } else { 0 };
        // Only frames drawn while ready count: the first one with the real interface starts over.
        self.last = if in_place { size } else { None };
        if self.stable >= STABLE_FRAMES || now - started > GIVE_UP_AFTER {
            self.done = true;
            return Step::Uncloak;
        }
        Step::Wait
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(min: [f32; 2], size: [f32; 2], maximized: bool) -> egui::ViewportInfo {
        let rect = egui::Rect::from_min_size(min.into(), size.into());
        egui::ViewportInfo {
            maximized: Some(maximized),
            minimized: Some(false),
            inner_rect: Some(rect),
            outer_rect: Some(rect),
            ..Default::default()
        }
    }

    #[test]
    fn maximizing_keeps_the_size_to_restore() {
        let mut p = Placement::default();
        p.observe(&info([100.0, 80.0], [1100.0, 700.0], false));
        p.observe(&info([0.0, 0.0], [1920.0, 1040.0], true));
        assert!(p.maximized);
        assert_eq!(p.size, [1100.0, 700.0]);
        assert_eq!(p.position, Some([100.0, 80.0]));
        p.observe(&info([100.0, 80.0], [1100.0, 700.0], false));
        assert!(!p.maximized);
    }

    #[test]
    fn a_maximized_window_appears_once_it_is_maximized_and_drawn() {
        let mut r = Reveal::default();
        let normal = info([100.0, 80.0], [1100.0, 700.0], false);
        let max = info([0.0, 0.0], [1920.0, 1040.0], true);
        assert_eq!(r.step(0.0, true, true, &normal), Step::Cloak);
        // Still at the normal size: however long it holds, it is not ready.
        for i in 1..6 {
            assert_eq!(r.step(i as f64 * 0.016, true, true, &normal), Step::Wait);
        }
        // Maximized but still loading: not yet.
        for i in 6..10 {
            assert_eq!(r.step(i as f64 * 0.016, true, false, &max), Step::Wait);
        }
        // Maximized: the first frame at the new size starts the count.
        let mut t = 0.2;
        let mut steps = Vec::new();
        for _ in 0..5 {
            t += 0.016;
            steps.push(r.step(t, true, true, &max));
        }
        assert_eq!(steps, [Step::Wait, Step::Wait, Step::Wait, Step::Uncloak, Step::Done]);
    }

    #[test]
    fn a_window_that_never_settles_still_appears() {
        let mut r = Reveal::default();
        let normal = info([0.0, 0.0], [800.0, 600.0], false);
        assert_eq!(r.step(0.0, true, false, &normal), Step::Cloak);
        assert_eq!(r.step(1.0, true, false, &normal), Step::Wait);
        assert_eq!(r.step(1.6, true, false, &normal), Step::Uncloak);
    }

    #[test]
    fn a_first_window_fits_the_screen_and_is_centred() {
        let rect = |x: f32, y: f32, w: f32, h: f32| egui::Rect::from_min_size(egui::pos2(x, y), egui::vec2(w, h));
        // 1280 x 820 with a 32-point title bar, opened where Windows cascades it.
        let (inner, outer) = (rect(34.0, 58.0, 1280.0, 820.0), rect(26.0, 26.0, 1296.0, 860.0));
        // A full HD screen holds it: same size, centred above the taskbar.
        let big = fit(egui::vec2(1920.0, 1080.0), inner, outer, true);
        assert_eq!(big, Some(Fit { inner: egui::vec2(1280.0, 820.0), position: egui::pos2(312.0, 86.0) }));
        // A 1366 x 768 laptop at 125% is 1093 x 614 points: it shrinks inside the screen.
        let small = fit(egui::vec2(1092.8, 614.4), inner, outer, true);
        assert!(small.is_some_and(|f| {
            f.position.x >= 0.0
                && f.position.y >= 0.0
                && f.position.x + f.inner.x + 16.0 <= 1092.8
                && f.position.y + f.inner.y + 40.0 <= 614.4 - TASKBAR
        }));
        // A saved place that fits is left alone; one too big for this screen is not.
        assert_eq!(fit(egui::vec2(1920.0, 1080.0), inner, outer, false), None);
        assert!(fit(egui::vec2(1092.8, 614.4), inner, outer, false).is_some());
        assert_eq!(fit(egui::Vec2::ZERO, inner, outer, true), None);
    }

    #[test]
    fn minimizing_changes_nothing() {
        let mut p = Placement::default();
        p.observe(&info([10.0, 10.0], [1000.0, 650.0], true));
        let before = p;
        p.observe(&egui::ViewportInfo { minimized: Some(true), ..Default::default() });
        assert_eq!(p, before);
    }
}
