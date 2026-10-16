//! Colour tokens (the web app's light and dark palettes) and how they map onto
//! egui's style. Widgets read colours from `Tokens`, never literals.

use egui::{Color32, CornerRadius, FontFamily, FontId, Stroke, TextStyle, Visuals};

const fn rgb(hex: u32) -> Color32 {
    Color32::from_rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

fn rgba(r: u8, g: u8, b: u8, a: f32) -> Color32 {
    Color32::from_rgba_unmultiplied(r, g, b, (a * 255.0).round() as u8)
}

/// Which palette is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub enum ThemeChoice {
    #[default]
    System,
    Light,
    Dark,
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

/// Apply the tokens to egui's style: spacing, text sizes and widget colours.
pub fn apply(ctx: &egui::Context, t: &Tokens) {
    let mut visuals = if t.dark { Visuals::dark() } else { Visuals::light() };
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
        style.interaction.selectable_labels = false;
        style.text_styles = [
            (TextStyle::Small, FontId::new(11.0, FontFamily::Proportional)),
            (TextStyle::Body, FontId::new(13.0, FontFamily::Proportional)),
            (TextStyle::Button, FontId::new(13.0, FontFamily::Proportional)),
            (TextStyle::Heading, FontId::new(20.0, FontFamily::Proportional)),
            (TextStyle::Monospace, FontId::new(12.0, FontFamily::Monospace)),
        ]
        .into();
    });
}

/// Inter, the web app's face, in the weights the design uses (OFL, trimmed to
/// Latin, Greek and Cyrillic; other scripts fall back to the system or egui font).
const INTER: [(&str, &[u8]); 4] = [
    ("inter-regular", include_bytes!("../assets/fonts/Inter-Regular.ttf")),
    ("inter-medium", include_bytes!("../assets/fonts/Inter-Medium.ttf")),
    ("inter-semibold", include_bytes!("../assets/fonts/Inter-SemiBold.ttf")),
    ("inter-bold", include_bytes!("../assets/fonts/Inter-Bold.ttf")),
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

/// Inter in four weights, the icon font in every family so icons mix into any
/// label, and the system UI font (desktop) then egui's faces as fallbacks.
pub fn install_fonts(ctx: &egui::Context, system_font: Option<Vec<u8>>) {
    let mut fonts = egui::FontDefinitions::default();
    for (name, bytes) in INTER {
        fonts.font_data.insert(name.into(), egui::FontData::from_static(bytes).into());
    }
    egui_phosphor::add_to_fonts(&mut fonts, egui_phosphor::Variant::Regular);
    let mut fallbacks: Vec<String> = fonts.families.get(&FontFamily::Proportional).cloned().unwrap_or_default();
    if let Some(bytes) = system_font {
        fonts.font_data.insert("system-ui".into(), egui::FontData::from_owned(bytes).into());
        fallbacks.insert(0, "system-ui".into());
    }
    let with = |primary: &str| std::iter::once(primary.to_string()).chain(fallbacks.iter().cloned()).collect();
    fonts.families.insert(FontFamily::Proportional, with("inter-regular"));
    fonts.families.insert(medium(), with("inter-medium"));
    fonts.families.insert(semibold(), with("inter-semibold"));
    fonts.families.insert(bold(), with("inter-bold"));
    ctx.set_fonts(fonts);
}
