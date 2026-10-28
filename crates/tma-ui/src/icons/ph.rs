//! The Phosphor icons the app uses (Phosphor 2.1, MIT, phosphoricons.com), as text
//! drawn from the bundled icon fonts, so an icon mixes into any label.
//!
//! To add one, copy its codepoint from Phosphor's list, add it here, then run
//! `python scripts/subset-icons.py` to rebuild the fonts; a test checks every icon has a glyph.

pub const APP_WINDOW: &str = "\u{E5DA}";
pub const ARROWS_CLOCKWISE: &str = "\u{E094}";
pub const ARROWS_DOWN_UP: &str = "\u{E098}";
pub const ARROWS_OUT_CARDINAL: &str = "\u{E0A4}";
pub const ARROW_CIRCLE_UP: &str = "\u{E030}";
pub const ARROW_COUNTER_CLOCKWISE: &str = "\u{E038}";
pub const ARROW_ELBOW_DOWN_RIGHT: &str = "\u{E046}";
pub const ARROW_LEFT: &str = "\u{E058}";
pub const ARROW_RIGHT: &str = "\u{E06C}";
pub const ARROW_SQUARE_OUT: &str = "\u{E5DE}";
pub const BROOM: &str = "\u{EC54}";
pub const CALENDAR_BLANK: &str = "\u{E10A}";
pub const CARET_DOWN: &str = "\u{E136}";
pub const CARET_LEFT: &str = "\u{E138}";
pub const CARET_RIGHT: &str = "\u{E13A}";
pub const CARET_UP: &str = "\u{E13C}";
pub const CHECK: &str = "\u{E182}";
pub const CHECK_CIRCLE: &str = "\u{E184}";
pub const CHECK_SQUARE: &str = "\u{E186}";
pub const CIRCLE: &str = "\u{E18A}";
pub const CLIPBOARD_TEXT: &str = "\u{E198}";
pub const CLOCK: &str = "\u{E19A}";
pub const CLOCK_COUNTER_CLOCKWISE: &str = "\u{E1A0}";
pub const CLOUD_ARROW_UP: &str = "\u{E1AE}";
pub const CODE: &str = "\u{E1BC}";
pub const COPY: &str = "\u{E1CA}";
pub const DATABASE: &str = "\u{E1DE}";
pub const DESKTOP: &str = "\u{E560}";
pub const DEVICES: &str = "\u{EBA4}";
pub const DOWNLOAD_SIMPLE: &str = "\u{E20C}";
pub const EYE: &str = "\u{E220}";
pub const EYE_SLASH: &str = "\u{E224}";
pub const FILE: &str = "\u{E230}";
pub const FILE_TEXT: &str = "\u{E23A}";
pub const FOLDER: &str = "\u{E24A}";
pub const FOLDER_OPEN: &str = "\u{E256}";
pub const FOLDER_PLUS: &str = "\u{E258}";
pub const GEAR_SIX: &str = "\u{E272}";
pub const GLOBE_HEMISPHERE_WEST: &str = "\u{E28C}";
pub const GLOBE_SIMPLE: &str = "\u{E28E}";
pub const HARD_DRIVE: &str = "\u{E29E}";
pub const HARD_DRIVES: &str = "\u{E2A0}";
pub const HOUSE: &str = "\u{E2C2}";
pub const IMAGE: &str = "\u{E2CA}";
pub const INFO: &str = "\u{E2CE}";
pub const KEY: &str = "\u{E2D6}";
pub const LINK: &str = "\u{E2E2}";
pub const LINK_BREAK: &str = "\u{E2E4}";
pub const LINK_SIMPLE: &str = "\u{E2E6}";
pub const LIST: &str = "\u{E2F0}";
pub const LIST_BULLETS: &str = "\u{E2F2}";
pub const LOCK: &str = "\u{E2FA}";
pub const MAGNIFYING_GLASS: &str = "\u{E30C}";
pub const MAGNIFYING_GLASS_MINUS: &str = "\u{E30E}";
pub const MAGNIFYING_GLASS_PLUS: &str = "\u{E310}";
pub const MOON: &str = "\u{E330}";
pub const MUSIC_NOTES: &str = "\u{E340}";
pub const PENCIL_SIMPLE: &str = "\u{E3B4}";
pub const PEN_NIB: &str = "\u{E3AC}";
pub const PLAY: &str = "\u{E3D0}";
pub const PLUS: &str = "\u{E3D4}";
pub const PRESENTATION: &str = "\u{E654}";
pub const RULER: &str = "\u{E6B8}";
pub const SCISSORS: &str = "\u{EAE0}";
pub const SHARE_NETWORK: &str = "\u{E408}";
pub const SHIELD: &str = "\u{E40A}";
pub const SHIELD_CHECK: &str = "\u{E40C}";
pub const SHIELD_PLUS: &str = "\u{E706}";
pub const SHIELD_SLASH: &str = "\u{E410}";
pub const SIGN_OUT: &str = "\u{E42A}";
pub const SORT_ASCENDING: &str = "\u{E444}";
pub const SORT_DESCENDING: &str = "\u{E446}";
pub const SQUARES_FOUR: &str = "\u{E464}";
pub const STAR: &str = "\u{E46A}";
pub const SUN: &str = "\u{E472}";
pub const TABLE: &str = "\u{E476}";
pub const TEXT_AA: &str = "\u{E6EE}";
pub const TEXT_ALIGN_JUSTIFY: &str = "\u{E482}";
pub const TEXT_ALIGN_LEFT: &str = "\u{E484}";
pub const TRASH: &str = "\u{E4A6}";
pub const UPLOAD_SIMPLE: &str = "\u{E4C0}";
pub const USER: &str = "\u{E4C2}";
pub const USERS: &str = "\u{E4D6}";
pub const USERS_THREE: &str = "\u{E68E}";
pub const USER_PLUS: &str = "\u{E4D0}";
pub const WARNING: &str = "\u{E4E0}";
pub const WARNING_CIRCLE: &str = "\u{E4E2}";
pub const WIFI_SLASH: &str = "\u{E4F2}";
pub const X: &str = "\u{E4F6}";
pub const X_CIRCLE: &str = "\u{E4F8}";

/// Filled icons. They share Phosphor's codepoints with the outlined ones, so the fill
/// font has them moved to U+F0000 + (codepoint - U+E000): both fonts load side by side.
pub mod fill {
    pub const SHARE_NETWORK: &str = "\u{F0408}";
    pub const STAR: &str = "\u{F046A}";
}
