//! Colour tokens (the web app's light and dark palettes) and how they map onto
//! egui's style. Widgets read colours from `Tokens`, never literals.

use egui::{Color32, CornerRadius, FontFamily, FontId, Stroke, TextStyle, Visuals};

const fn rgb(hex: u32) -> Color32 {
    Color32::from_rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

fn rgba(r: u8, g: u8, b: u8, a: f32) -> Color32 {
    Color32::from_rgba_unmultiplied(r, g, b, (a * 255.0).round() as u8)
}

/// The tint that draws an image as it is.
pub const NO_TINT: Color32 = Color32::WHITE;

/// A token colour at another opacity (0-255), for tinted fills behind it.
pub fn with_alpha(color: Color32, alpha: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), alpha)
}

/// Between two token colours, `t` from 0 (all `a`) to 1 (all `b`), for animated changes.
pub fn mix(a: Color32, b: Color32, t: f32) -> Color32 {
    // Color32 keeps its channels premultiplied, so blend them as they are: reading
    // them back as unmultiplied would apply a translucent colour's alpha twice.
    let lerp = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t.clamp(0.0, 1.0)).round() as u8;
    Color32::from_rgba_premultiplied(lerp(a.r(), b.r()), lerp(a.g(), b.g()), lerp(a.b(), b.b()), lerp(a.a(), b.a()))
}

/// Which palette is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub enum ThemeChoice {
    #[default]
    System,
    Light,
    Dark,
}

/// How large the app draws, as a browser zooms a page: text, icons and spacing
/// grow together, so nothing overlaps or is cut off (WCAG 1.4.4, resize text).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub enum TextSize {
    Small,
    #[default]
    Default,
    Large,
    Larger,
}

impl TextSize {
    pub const ALL: [TextSize; 4] = [TextSize::Small, TextSize::Default, TextSize::Large, TextSize::Larger];

    /// The zoom applied to the whole interface.
    pub fn zoom(self) -> f32 {
        match self {
            TextSize::Small => 0.9,
            TextSize::Default => 1.0,
            TextSize::Large => 1.15,
            TextSize::Larger => 1.3,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            TextSize::Small => "Small",
            TextSize::Default => "Default",
            TextSize::Large => "Large",
            TextSize::Larger => "Larger",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Tokens {
    pub dark: bool,
    pub canvas: Color32,
    pub surface: Color32,
    pub surface_raised: Color32,
    pub surface_sunken: Color32,
    pub fill_quaternary: Color32,
    pub fill_tertiary: Color32,
    pub fill_secondary: Color32,
    pub label: Color32,
    pub label_secondary: Color32,
    pub label_tertiary: Color32,
    pub label_quaternary: Color32,
    pub separator: Color32,
    pub separator_strong: Color32,
    pub accent: Color32,
    pub accent_hover: Color32,
    pub accent_fill: Color32,
    pub accent_fill_strong: Color32,
    pub positive: Color32,
    pub warning: Color32,
    pub destructive: Color32,
    pub positive_text: Color32,
    pub warning_text: Color32,
    pub destructive_text: Color32,
    pub folder_back: Color32,
    pub folder_front: Color32,
    pub folder_zip: Color32,
    pub scrim: Color32,
    /// Text and icons on an accent or destructive fill, file badges and avatars.
    pub on_accent: Color32,
    /// Controls drawn over photos in the viewer, whatever the theme.
    pub on_media: Color32,
    /// Behind a QR code, which scanners read only dark on light.
    pub qr_background: Color32,
    /// A switch's off track: opaque, since the translucent fills vanish on dark surfaces.
    pub toggle_off: Color32,
}

impl Tokens {
    pub fn light() -> Self {
        Self {
            dark: false,
            canvas: rgb(0xedece8),
            surface: rgb(0xf7f6f3),
            surface_raised: rgb(0xfaf9f6),
            surface_sunken: rgb(0xe6e5e0),
            fill_quaternary: rgba(120, 118, 110, 0.09),
            fill_tertiary: rgba(120, 118, 110, 0.14),
            fill_secondary: rgba(120, 118, 110, 0.19),
            label: rgb(0x2b2a26),
            label_secondary: rgba(43, 42, 38, 0.78),
            label_tertiary: rgba(43, 42, 38, 0.7),
            label_quaternary: rgba(43, 42, 38, 0.42),
            separator: rgba(43, 42, 38, 0.17),
            separator_strong: rgba(43, 42, 38, 0.3),
            accent: rgb(0x0866cc),
            accent_hover: rgb(0x0059b8),
            accent_fill: rgba(8, 102, 204, 0.1),
            accent_fill_strong: rgba(8, 102, 204, 0.16),
            positive: rgb(0x34c759),
            warning: rgb(0xff9f0a),
            destructive: rgb(0xff3b30),
            positive_text: rgb(0x1c6b30),
            warning_text: rgb(0xa2540a),
            destructive_text: rgb(0xd70015),
            folder_back: rgb(0xe07c00),
            folder_front: rgb(0xff9f0a),
            folder_zip: rgb(0x6b3800),
            scrim: rgba(0, 0, 0, 0.28),
            on_accent: Color32::WHITE,
            on_media: Color32::WHITE,
            qr_background: Color32::WHITE,
            toggle_off: rgb(0xd6d5cf),
        }
    }

    pub fn dark() -> Self {
        Self {
            dark: true,
            canvas: rgb(0x1b1b19),
            surface: rgb(0x232320),
            surface_raised: rgb(0x2c2c28),
            surface_sunken: rgb(0x141413),
            fill_quaternary: rgba(140, 138, 128, 0.14),
            fill_tertiary: rgba(140, 138, 128, 0.2),
            fill_secondary: rgba(140, 138, 128, 0.27),
            label: rgb(0xf5f4f1),
            label_secondary: rgba(240, 239, 233, 0.62),
            label_tertiary: rgba(240, 239, 233, 0.54),
            label_quaternary: rgba(240, 239, 233, 0.24),
            separator: rgba(132, 130, 120, 0.34),
            separator_strong: rgba(142, 140, 130, 0.52),
            accent: rgb(0x0a84ff),
            accent_hover: rgb(0x3d9bff),
            accent_fill: rgba(10, 132, 255, 0.16),
            accent_fill_strong: rgba(10, 132, 255, 0.26),
            positive: rgb(0x30d158),
            warning: rgb(0xffd60a),
            destructive: rgb(0xff453a),
            positive_text: rgb(0x30d158),
            warning_text: rgb(0xffd60a),
            destructive_text: rgb(0xff6961),
            folder_back: rgb(0xe08c1a),
            folder_front: rgb(0xffb340),
            folder_zip: rgb(0x6b3800),
            scrim: rgba(0, 0, 0, 0.62),
            on_accent: Color32::WHITE,
            on_media: Color32::WHITE,
            qr_background: Color32::WHITE,
            toggle_off: rgb(0x484742),
        }
    }

    pub fn for_choice(choice: ThemeChoice, system_dark: bool) -> Self {
        match choice {
            ThemeChoice::Light => Self::light(),
            ThemeChoice::Dark => Self::dark(),
            ThemeChoice::System if system_dark => Self::dark(),
            ThemeChoice::System => Self::light(),
        }
    }

    /// The colour a file kind is drawn in.
    pub fn file_color(&self, kind: tma_core::FileKind) -> Color32 {
        use tma_core::FileKind as K;
        rgb(match kind {
            K::Document => 0x3372e0,
            K::Pdf => 0xe0383e,
            K::Spreadsheet => 0x1f8f4e,
            K::Presentation => 0xe25a1c,
            K::Image => 0x9c53d7,
            K::Design => 0xa67408,
            K::Video => 0xd63a78,
            K::Audio => 0x0e8a7e,
            K::Archive => 0x907153,
            K::Code => 0x6c68db,
            K::Database => 0x2b7e9e,
            K::Text => 0x78766f,
            K::Executable => 0x5f789a,
            K::Font | K::Generic => 0x8a8880,
        })
    }
}

pub const RADIUS_SM: u8 = 6;
pub const RADIUS_MD: u8 = 10;
pub const RADIUS_LG: u8 = 14;

/// How glyph coverage becomes alpha for light text on dark backgrounds.
const DARK_TEXT_GAMMA: egui::epaint::FontColorTransferFunction = egui::epaint::FontColorTransferFunction::Gamma(0.8);

/// Apply the tokens to egui's style: spacing, text sizes and widget colours.
pub fn apply(ctx: &egui::Context, t: &Tokens) {
    let mut visuals = if t.dark { Visuals::dark() } else { Visuals::light() };
    if t.dark {
        // egui's dark curve (2c - c², about gamma 0.5) pushes edge pixels to full
        // brightness, so light text looks blocky; 0.8 keeps edges soft yet not thin.
        visuals.text_options.color_transfer_function = DARK_TEXT_GAMMA;
    }
    visuals.panel_fill = t.canvas;
    visuals.window_fill = t.surface_raised;
    visuals.extreme_bg_color = t.surface_sunken;
    visuals.faint_bg_color = t.fill_quaternary;
    visuals.override_text_color = Some(t.label);
    visuals.hyperlink_color = t.accent;
    visuals.selection.bg_fill = t.accent_fill_strong;
    visuals.selection.stroke = Stroke::new(1.0, t.accent);
    visuals.window_stroke = Stroke::new(1.0, t.separator);
    visuals.window_corner_radius = CornerRadius::same(18);
    visuals.menu_corner_radius = CornerRadius::same(16);
    // Buttons and links show the pointing hand, as on the web.
    visuals.interact_cursor = Some(egui::CursorIcon::PointingHand);
    visuals.window_shadow = egui::epaint::Shadow {
        offset: [0, 10],
        blur: 32,
        spread: 0,
        color: Color32::from_black_alpha(if t.dark { 110 } else { 40 }),
    };
    visuals.popup_shadow = egui::epaint::Shadow {
        offset: [0, 6],
        blur: 18,
        spread: 0,
        color: Color32::from_black_alpha(if t.dark { 90 } else { 30 }),
    };
    let radius = CornerRadius::same(RADIUS_SM);
    let w = &mut visuals.widgets;
    w.noninteractive.bg_stroke = Stroke::new(1.0, t.separator);
    w.noninteractive.fg_stroke = Stroke::new(1.0, t.label);
    w.noninteractive.corner_radius = radius;
    w.inactive.bg_fill = t.fill_quaternary;
    w.inactive.weak_bg_fill = t.fill_quaternary;
    w.inactive.bg_stroke = Stroke::NONE;
    w.inactive.fg_stroke = Stroke::new(1.0, t.label);
    w.inactive.corner_radius = radius;
    w.hovered.bg_fill = t.fill_tertiary;
    w.hovered.weak_bg_fill = t.fill_tertiary;
    w.hovered.bg_stroke = Stroke::NONE;
    w.hovered.fg_stroke = Stroke::new(1.0, t.label);
    w.hovered.corner_radius = radius;
    w.hovered.expansion = 0.0;
    w.active.bg_fill = t.fill_secondary;
    w.active.weak_bg_fill = t.fill_secondary;
    w.active.bg_stroke = Stroke::NONE;
    w.active.fg_stroke = Stroke::new(1.0, t.label);
    w.active.corner_radius = radius;
    w.active.expansion = 0.0;
    w.open = w.active;

    ctx.all_styles_mut(|style| {
        style.visuals = visuals.clone();
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(10.0, 5.0);
        style.spacing.interact_size.y = 26.0;
        style.spacing.menu_margin = egui::Margin::same(6);
        style.spacing.window_margin = egui::Margin::same(18);
        // A thin, soft handle in a gutter of its own: it never covers rows, and no track shows.
        style.spacing.scroll = egui::style::ScrollStyle {
            floating: true,
            bar_width: 8.0,
            floating_width: 6.0,
            floating_allocated_width: 10.0,
            bar_inner_margin: 2.0,
            bar_outer_margin: 0.0,
            handle_min_length: 28.0,
            foreground_color: true,
            dormant_background_opacity: 0.0,
            active_background_opacity: 0.0,
            interact_background_opacity: 0.0,
            dormant_handle_opacity: 0.22,
            active_handle_opacity: 0.32,
            interact_handle_opacity: 0.5,
            ..egui::style::ScrollStyle::floating()
        };
        style.interaction.selectable_labels = false;
        // Menus, dialogs and panels ease in over about the old web app's timing, not egui's 1/12 s.
        style.animation_time = 0.16;
        style.text_styles = [
            (TextStyle::Small, FontId::new(13.0, FontFamily::Proportional)),
            (TextStyle::Body, FontId::new(14.0, FontFamily::Proportional)),
            (TextStyle::Button, FontId::new(14.0, FontFamily::Proportional)),
            (TextStyle::Heading, FontId::new(20.0, FontFamily::Proportional)),
            (TextStyle::Monospace, FontId::new(12.0, FontFamily::Monospace)),
        ]
        .into();
    });
}

/// Inter (OFL), a screen sans with a tall x-height, so long lists of file names stay
/// readable. Its serifed I and tailed l (cv08, cv05) are baked in, since egui cannot
/// turn on font features and file codes need I, l and 1 apart. Subset to Latin, Greek
/// and Cyrillic; other scripts fall back to the system or egui font.
const UI_FONT: [(&str, &[u8]); 4] = [
    ("ui-regular", include_bytes!("../assets/fonts/Inter-Regular.ttf")),
    ("ui-medium", include_bytes!("../assets/fonts/Inter-Medium.ttf")),
    ("ui-semibold", include_bytes!("../assets/fonts/Inter-SemiBold.ttf")),
    ("ui-bold", include_bytes!("../assets/fonts/Inter-Bold.ttf")),
];

/// Only the Phosphor icons the app uses (`icons::ph`); `scripts/subset-icons.py` builds them.
const ICON_FONTS: [(&str, &[u8]); 2] = [
    ("icons", include_bytes!("../assets/fonts/PhosphorIcons.ttf")),
    ("icons-fill", include_bytes!("../assets/fonts/PhosphorIcons-Fill.ttf")),
];

pub fn medium() -> FontFamily {
    FontFamily::Name("medium".into())
}

pub fn semibold() -> FontFamily {
    FontFamily::Name("semibold".into())
}

pub fn bold() -> FontFamily {
    FontFamily::Name("bold".into())
}

/// Font weights for rich text; egui's `strong()` only changes the colour.
pub trait Weight {
    fn medium(self) -> Self;
    fn semibold(self) -> Self;
    fn bold(self) -> Self;
}

impl Weight for egui::RichText {
    fn medium(self) -> Self {
        self.family(medium())
    }
    fn semibold(self) -> Self {
        self.family(semibold())
    }
    fn bold(self) -> Self {
        self.family(bold())
    }
}

/// The UI font in four weights, the icon font in every family so icons mix into any
/// label, and the system UI font (desktop) then egui's faces as fallbacks.
pub fn install_fonts(ctx: &egui::Context, system_font: Option<Vec<u8>>) {
    let mut fonts = egui::FontDefinitions::default();
    for (name, bytes) in UI_FONT.into_iter().chain(ICON_FONTS) {
        fonts.font_data.insert(name.into(), egui::FontData::from_static(bytes).into());
    }
    let mut fallbacks: Vec<String> = fonts.families.get(&FontFamily::Proportional).cloned().unwrap_or_default();
    if let Some(bytes) = system_font {
        fonts.font_data.insert("system-ui".into(), egui::FontData::from_owned(bytes).into());
        fallbacks.insert(0, "system-ui".into());
    }
    // Icons sit in Phosphor's private-use codepoints, which no text font fills, so first place is safe.
    fallbacks.splice(0..0, ICON_FONTS.map(|(name, _)| name.to_string()));
    let with = |primary: &str| std::iter::once(primary.to_string()).chain(fallbacks.iter().cloned()).collect();
    fonts.families.insert(FontFamily::Proportional, with("ui-regular"));
    fonts.families.insert(medium(), with("ui-medium"));
    fonts.families.insert(semibold(), with("ui-semibold"));
    fonts.families.insert(bold(), with("ui-bold"));
    ctx.set_fonts(fonts);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_sizes_grow_in_order_around_the_default() {
        let zooms: Vec<f32> = TextSize::ALL.iter().map(|s| s.zoom()).collect();
        assert!(zooms.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(TextSize::default().zoom(), 1.0);
        // Settings saved before the option existed keep the default size.
        let prefs: crate::app::Prefs = serde_json::from_str(r#"{"theme":"Dark","grid_view":true}"#)
            .unwrap_or_else(|e| unreachable!("older settings load: {e}"));
        assert_eq!(prefs.text_size, TextSize::Default);
    }

    #[test]
    fn every_icon_has_a_glyph_in_the_bundled_fonts() {
        let ctx = egui::Context::default();
        install_fonts(&ctx, None);
        // One frame loads the fonts; its texture upload is not needed here.
        ctx.run_ui(egui::RawInput::default(), |_| {}).textures_delta.clear();
        // Every "\u{...}" in the list, outlined and filled: one missing means the fonts need rebuilding.
        let list = include_str!("icons/ph.rs");
        let icons: Vec<char> = list
            .split("\"\\u{")
            .skip(1)
            .filter_map(|rest| u32::from_str_radix(rest.split('}').next()?, 16).ok())
            .filter_map(char::from_u32)
            .collect();
        assert_eq!(icons.len(), 92);
        let missing: Vec<String> = ctx.fonts_mut(|fonts| {
            icons
                .iter()
                .filter(|&&c| !fonts.has_glyph(&egui::FontId::proportional(14.0), c))
                .map(|c| format!("U+{:X}", *c as u32))
                .collect()
        });
        assert!(missing.is_empty(), "run scripts/subset-icons.py; no glyph for {missing:?}");
    }

    #[test]
    fn mixing_keeps_translucent_colours() {
        let translucent = Color32::from_rgba_unmultiplied(240, 239, 233, 158);
        assert_eq!(mix(translucent, Color32::WHITE, 0.0), translucent);
        assert_eq!(mix(Color32::BLACK, translucent, 1.0), translucent);
        assert_eq!(mix(Color32::TRANSPARENT, Color32::WHITE, 0.5).a(), 128);
    }
}
