//! Image thumbnails for grid view. Only tiles on screen ask for one; a few load
//! at a time and the cache keeps the most recently used ones.

use std::collections::{HashMap, VecDeque};

use tma_core::api::FileItem;

use crate::app::App;

/// Thumbnails kept as textures; older ones are dropped first.
const KEEP: usize = 300;
const PARALLEL: usize = 4;
const EDGE: u32 = 256;
/// Larger originals would cost too much to fetch for a thumbnail.
const MAX_SOURCE_BYTES: i64 = 25 * 1024 * 1024;

enum Entry {
    Loading,
    Ready(egui::TextureHandle),
    Failed,
}

#[derive(Default)]
pub struct Thumbs {
    entries: HashMap<String, Entry>,
    recent: VecDeque<String>,
    /// Asked for during this frame and not started yet.
    wanted: Vec<(String, String)>,
}

/// One version of a file: an edited image gets a new thumbnail.
fn key(item: &FileItem) -> String {
    format!("{}:{}", item.id, item.modified.timestamp_millis())
}

pub fn wants_thumbnail(item: &FileItem) -> bool {
    !item.is_folder()
        && item.size.is_some_and(|s| s <= MAX_SOURCE_BYTES)
        && item.mime_type.as_deref().is_some_and(|m| m.starts_with("image/") && m != "image/svg+xml")
}

impl Thumbs {
    /// The thumbnail if it is ready; otherwise it is requested for the next frame.
    pub fn get(&mut self, item: &FileItem) -> Option<egui::TextureHandle> {
        let key = key(item);
        match self.entries.get(&key) {
            Some(Entry::Ready(texture)) => {
                let texture = texture.clone();
                self.touch(&key);
                Some(texture)
            }
            Some(_) => None,
            None => {
                if !self.wanted.iter().any(|(k, _)| *k == key) {
                    self.wanted.push((key, item.id.clone()));
                }
                None
            }
        }
    }

    fn touch(&mut self, key: &str) {
        if self.recent.back().map(String::as_str) != Some(key) {
            self.recent.retain(|k| k != key);
            self.recent.push_back(key.to_string());
        }
        while self.recent.len() > KEEP {
            if let Some(old) = self.recent.pop_front() {
                self.entries.remove(&old);
            }
        }
    }

    fn loading(&self) -> usize {
        self.entries.values().filter(|e| matches!(e, Entry::Loading)).count()
    }
}

/// Start loads for tiles drawn this frame, a few at a time.
pub fn pump(app: &mut App) {
    let crate::app::Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    let ctx = app.tasks.ctx().clone();
    let thumbs = &mut main.browser.thumbs;
    let wanted = std::mem::take(&mut thumbs.wanted);
    for (key, id) in wanted {
        if thumbs.loading() >= PARALLEL {
            break;
        }
        thumbs.entries.insert(key.clone(), Entry::Loading);
        let (client, ctx) = (client.clone(), ctx.clone());
        app.tasks.run(
            async move {
                let bytes = client.file_bytes(&id).await.map_err(|e| e.message)?;
                decode(&bytes)
            },
            move |app, result: Result<egui::ColorImage, String>| {
                let Some(main) = app.main_mut(generation) else { return };
                let thumbs = &mut main.browser.thumbs;
                let entry = match result {
                    Ok(image) => {
                        Entry::Ready(ctx.load_texture(format!("thumb-{key}"), image, egui::TextureOptions::LINEAR))
                    }
                    Err(err) => {
                        log::debug!("No thumbnail for {key}: {err}");
                        Entry::Failed
                    }
                };
                thumbs.entries.insert(key.clone(), entry);
                thumbs.touch(&key);
            },
        );
    }
}

fn decode(bytes: &[u8]) -> Result<egui::ColorImage, String> {
    let image = image::load_from_memory(bytes).map_err(|e| e.to_string())?.thumbnail(EDGE, EDGE).to_rgba8();
    Ok(egui::ColorImage::from_rgba_unmultiplied([image.width() as usize, image.height() as usize], image.as_raw()))
}

/// The largest rectangle with the texture's shape that fits in `area`, centred.
pub fn fit(area: egui::Rect, size: egui::Vec2) -> egui::Rect {
    if size.x <= 0.0 || size.y <= 0.0 {
        return area;
    }
    let scale = (area.width() / size.x).min(area.height() / size.y);
    egui::Rect::from_center_size(area.center(), size * scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_the_shape() {
        let area = egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(100.0, 80.0));
        let wide = fit(area, egui::vec2(200.0, 100.0));
        assert_eq!(wide.size(), egui::vec2(100.0, 50.0));
        assert_eq!(wide.center(), area.center());
        let tall = fit(area, egui::vec2(50.0, 100.0));
        assert_eq!(tall.size(), egui::vec2(40.0, 80.0));
    }
}
