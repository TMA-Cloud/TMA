//! egui's desktop backend turns Ctrl+C, Ctrl+X and Ctrl+V into clipboard events
//! for text fields, and drops Ctrl+V entirely when the clipboard holds only
//! files (Explorer's Copy). The file list listens for the keys, so they are put back.

use egui::{Event, Key, Modifiers, RawInput};

/// Whether V was down on the last frame, so holding it pastes once.
#[derive(Default)]
pub struct ClipboardKeys {
    v_down: bool,
}

impl ClipboardKeys {
    /// Called before each frame; `text_focused` leaves text fields their own clipboard events.
    pub fn restore(&mut self, raw: &mut RawInput, modifiers: Modifiers, text_focused: bool) {
        let v_down = raw.focused && v_is_down();
        let pressed_now = v_down && !self.v_down;
        self.v_down = v_down;
        if text_focused {
            return;
        }
        let keys = key_presses(&raw.events, modifiers, pressed_now);
        raw.events.extend(keys);
    }
}

/// Key presses matching the clipboard events, plus Ctrl+V when V went down with
/// Ctrl held but the backend sent no paste (the clipboard holds no text).
pub fn key_presses(events: &[Event], modifiers: Modifiers, v_pressed_now: bool) -> Vec<Event> {
    let press = |key| Event::Key { key, physical_key: Some(key), pressed: true, repeat: false, modifiers };
    let mut out: Vec<Event> = events
        .iter()
        .filter_map(|e| match e {
            Event::Copy => Some(press(Key::C)),
            Event::Cut => Some(press(Key::X)),
            Event::Paste(_) => Some(press(Key::V)),
            _ => None,
        })
        .collect();
    let pasted = events.iter().any(|e| matches!(e, Event::Paste(_)));
    if v_pressed_now && modifiers.command && !pasted {
        out.push(press(Key::V));
    }
    out
}

#[cfg(windows)]
fn v_is_down() -> bool {
    use device_query::{DeviceQuery, DeviceState, Keycode};
    DeviceState::new().get_keys().contains(&Keycode::V)
}

#[cfg(not(windows))]
fn v_is_down() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(events: &[Event]) -> Vec<Key> {
        events.iter().filter_map(|e| if let Event::Key { key, .. } = e { Some(*key) } else { None }).collect()
    }

    #[test]
    fn clipboard_events_become_keys() {
        let cmd = Modifiers::COMMAND;
        assert_eq!(keys(&key_presses(&[Event::Copy, Event::Cut], cmd, false)), [Key::C, Key::X]);
        // A text paste already says V was pressed; the key state must not add a second one.
        assert_eq!(keys(&key_presses(&[Event::Paste("x".into())], cmd, true)), [Key::V]);
        // Files only: the backend sent nothing, so the key state supplies Ctrl+V.
        assert_eq!(keys(&key_presses(&[], cmd, true)), [Key::V]);
        // V without Ctrl is typing, not pasting.
        assert!(keys(&key_presses(&[], Modifiers::NONE, true)).is_empty());
    }
}
