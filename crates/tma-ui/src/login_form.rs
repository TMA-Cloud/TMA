//! Real form fields over the web sign-in card. The app draws on a canvas, which
//! browsers and password managers cannot see, so on the web each field is a
//! native input laid over its drawn frame, with the autocomplete hint password
//! managers key on, inside a form that is submitted with the sign-in. The
//! desktop app has no browser around it and keeps egui's own fields.
#![cfg_attr(
    not(target_arch = "wasm32"),
    expect(
        dead_code,
        reason = "only the web build lays inputs over the canvas; the desktop one compiles the shapes alone"
    )
)]

#[cfg(target_arch = "wasm32")]
mod web;

/// What a sign-in field holds, which decides its type and autocomplete hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Name,
    Email,
    Password,
    Code,
}

impl Kind {
    /// The `autocomplete` token: a new account's password is a new one to save.
    pub fn autocomplete(self, signing_up: bool) -> &'static str {
        match self {
            Kind::Name => "name",
            Kind::Email => "username",
            Kind::Password if signing_up => "new-password",
            Kind::Password => "current-password",
            Kind::Code => "one-time-code",
        }
    }

    /// The input's `type`; a password field shows its text while the eye is on.
    pub fn input_type(self, shown: bool) -> &'static str {
        match self {
            Kind::Email => "email",
            Kind::Password if !shown => "password",
            _ => "text",
        }
    }

    /// The input's `name` and `id`, stable so a saved login matches it again.
    pub fn key(self) -> &'static str {
        match self {
            Kind::Name => "name",
            Kind::Email => "email",
            Kind::Password => "password",
            Kind::Code => "code",
        }
    }
}

/// One field to lay over the canvas this frame.
pub struct Field<'a> {
    pub kind: Kind,
    /// Where the text goes, in egui points (CSS pixels from the canvas corner).
    pub rect: egui::Rect,
    pub value: &'a mut String,
    pub placeholder: &'a str,
    pub shown: bool,
    pub signing_up: bool,
}

/// What happened in a field since the last frame.
#[derive(Debug, Default, Clone, Copy)]
pub struct Seen {
    pub enter: bool,
    pub focused: bool,
}

/// Whether sign-in fields are browser inputs here.
pub const NATIVE_INPUTS: bool = cfg!(target_arch = "wasm32");

/// Start a frame of the sign-in card; fields not shown again by `end` are removed.
pub fn begin() {
    #[cfg(target_arch = "wasm32")]
    web::begin();
}

/// Lay the input for `field` over the canvas and sync its text both ways.
#[cfg_attr(not(target_arch = "wasm32"), expect(unused_variables, reason = "the desktop app has no inputs to lay"))]
pub fn field(ctx: &egui::Context, field: Field<'_>, t: &crate::theme::Tokens) -> Seen {
    #[cfg(target_arch = "wasm32")]
    return web::field(ctx, field, t);
    #[cfg(not(target_arch = "wasm32"))]
    Seen::default()
}

pub fn end() {
    #[cfg(target_arch = "wasm32")]
    web::end();
}

/// Submit the form, so the browser knows these credentials were sent; once the
/// sign-in succeeds the form goes away, which is when browsers offer to save.
pub fn submitted() {
    #[cfg(target_arch = "wasm32")]
    web::submitted();
}

/// Take the inputs off the page (the sign-in card is gone).
pub fn remove() {
    #[cfg(target_arch = "wasm32")]
    web::remove();
}

#[cfg(test)]
mod tests {
    use super::Kind;

    #[test]
    fn hints_follow_the_mode() {
        assert_eq!(Kind::Password.autocomplete(false), "current-password");
        assert_eq!(Kind::Password.autocomplete(true), "new-password");
        assert_eq!(Kind::Email.autocomplete(true), "username");
        assert_eq!(Kind::Password.input_type(false), "password");
        assert_eq!(Kind::Password.input_type(true), "text");
        assert_eq!(Kind::Email.input_type(false), "email");
    }
}
