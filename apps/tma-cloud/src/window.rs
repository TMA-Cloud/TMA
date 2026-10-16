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
    /// Build the window at its normal size, maximized on top if it was.
    pub fn apply(&self, builder: egui::ViewportBuilder) -> egui::ViewportBuilder {
        let mut builder = builder.with_inner_size(self.size).with_maximized(self.maximized);
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

fn path() -> Option<std::path::PathBuf> {
    Some(dirs::config_dir()?.join("TMA Cloud").join(FILE))
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
    fn minimizing_changes_nothing() {
        let mut p = Placement::default();
        p.observe(&info([10.0, 10.0], [1000.0, 650.0], true));
        let before = p;
        p.observe(&egui::ViewportInfo { minimized: Some(true), ..Default::default() });
        assert_eq!(p, before);
    }
}
