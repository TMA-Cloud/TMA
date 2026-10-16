//! The platform's UI font, so the app reads like a native one. egui's built-in
//! face is the fallback when none of these exist.

const CANDIDATES: &[&str] = &[
    // Windows
    "C:\\Windows\\Fonts\\segoeui.ttf",
    // macOS
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    // Linux
    "/usr/share/fonts/truetype/inter/Inter-Regular.ttf",
    "/usr/share/fonts/opentype/inter/Inter-Regular.otf",
    "/usr/share/fonts/inter/Inter-Regular.otf",
    "/usr/share/fonts/truetype/cantarell/Cantarell-Regular.otf",
    "/usr/share/fonts/cantarell/Cantarell-VF.otf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

pub fn system_ui_font() -> Option<Vec<u8>> {
    CANDIDATES.iter().find_map(|path| std::fs::read(path).ok())
}
