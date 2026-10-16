//! Systems without a pointer backend keep the system's pointers.

use super::Image;

pub type Cursor = ();

pub struct Native;

impl Native {
    pub fn new(_frame: &eframe::Frame) -> Option<Self> {
        None
    }

    pub fn make(&mut self, _image: &Image) -> Option<Cursor> {
        None
    }

    pub fn show(&mut self, _cursor: Option<&Cursor>, _ctx: &egui::Context) {}
}
