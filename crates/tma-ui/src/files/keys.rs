//! Keyboard and mouse-button navigation in the listing, as in a file manager:
//! arrows and paging move the selection (Shift extends it), typing a name's
//! first letters selects it, Backspace and the mouse's back button go back.

use egui::{Key, Modifiers, PointerButton, Ui};

use super::actions::Action;
use super::{Browser, Place};
use crate::app::Main;

/// Letters typed within this many seconds build one name prefix.
const TYPE_AHEAD_SECS: f64 = 1.0;
const PAGE: usize = 10;

fn current(b: &Browser) -> Option<usize> {
    let id = b.anchor.as_ref().or_else(|| b.selected.iter().next())?;
    b.items.iter().position(|i| &i.id == id)
}

/// Move the selection to `index`; with `extend`, select the range from the anchor.
fn move_to(b: &mut Browser, index: usize, extend: bool) {
    let Some(item) = b.items.get(index) else { return };
    let id = item.id.clone();
    if extend && let Some(anchor) = b.anchor.clone().and_then(|a| b.items.iter().position(|i| i.id == a)) {
        b.selected = b.items[anchor.min(index)..=anchor.max(index)].iter().map(|i| i.id.clone()).collect();
    } else {
        b.select_only(&id);
    }
    // The anchor stays put while extending, so Shift+arrows grow and shrink the range.
    if !extend {
        b.anchor = Some(id);
    }
    b.scroll_to = Some(index);
}

fn type_ahead(b: &mut Browser, text: &str, now: f64) {
    if now - b.typed.1 > TYPE_AHEAD_SECS {
        b.typed.0.clear();
    }
    b.typed.0.push_str(&text.to_lowercase());
    b.typed.1 = now;
    let prefix = b.typed.0.clone();
    // A repeated single letter cycles through the names starting with it.
    let start =
        if prefix.chars().count() == 1 { current(b).map(|i| i + 1).unwrap_or(0) } else { current(b).unwrap_or(0) };
    let count = b.items.len();
    let hit =
        (0..count).map(|k| (start + k) % count.max(1)).find(|&i| b.items[i].name.to_lowercase().starts_with(&prefix));
    if let Some(index) = hit {
        move_to(b, index, false);
    }
}

pub fn handle(main: &mut Main, ui: &mut Ui, actions: &mut Vec<Action>) {
    // Mouse back and forward buttons work anywhere over the listing.
    let (back_button, forward_button) = ui
        .input(|i| (i.pointer.button_pressed(PointerButton::Extra1), i.pointer.button_pressed(PointerButton::Extra2)));
    if back_button {
        actions.push(Action::Back);
    }
    if forward_button {
        actions.push(Action::Forward);
    }
    // Shortcuts belong to the listing, not to a text field that has focus.
    if ui.ctx().text_edit_focused() || main.modal.is_some() || main.browser.conflicts.is_some() {
        return;
    }
    let selection = main.browser.selected_items();
    let trash = main.browser.place == Place::Trash;
    let folder = main.browser.place == Place::Folder;
    let count = main.browser.items.len();
    let now = ui.input(|i| i.time);
    let arrows = ui.input(|i| i.key_pressed(Key::ArrowUp) || i.key_pressed(Key::ArrowDown));
    if arrows {
        // egui would also move focus with the arrow, landing in the search field on the next press.
        ui.memory_mut(|m| {
            m.move_focus(egui::FocusDirection::None);
            if let Some(id) = m.focused() {
                m.surrender_focus(id);
            }
        });
    }
    let mut typed = String::new();
    ui.input_mut(|i| {
        let b = &mut main.browser;
        let shift = i.modifiers.shift;
        if count > 0 {
            let at = current(b);
            let next =
                |delta: isize| at.map(|a| (a as isize + delta).clamp(0, count as isize - 1) as usize).unwrap_or(0);
            if i.key_pressed(Key::ArrowDown) {
                move_to(b, next(1), shift);
            }
            if i.key_pressed(Key::ArrowUp) {
                move_to(b, next(-1), shift);
            }
            if i.key_pressed(Key::PageDown) {
                move_to(b, next(PAGE as isize), shift);
            }
            if i.key_pressed(Key::PageUp) {
                move_to(b, next(-(PAGE as isize)), shift);
            }
            if i.key_pressed(Key::Home) {
                move_to(b, 0, shift);
            }
            if i.key_pressed(Key::End) {
                move_to(b, count - 1, shift);
            }
        }
        if i.consume_key(Modifiers::COMMAND, Key::A) {
            b.selected = b.items.iter().map(|x| x.id.clone()).collect();
        }
        if i.consume_key(Modifiers::NONE, Key::F5) {
            actions.push(Action::Refresh);
        }
        if i.consume_key(Modifiers::NONE, Key::Escape) {
            b.selected.clear();
        }
        if !selection.is_empty()
            && (i.consume_key(Modifiers::NONE, Key::Delete) || i.consume_key(Modifiers::COMMAND, Key::Backspace))
        {
            let ids = selection.iter().map(|x| x.id.clone()).collect();
            actions.push(if trash { Action::DeleteForever(ids) } else { Action::Trash(selection.clone()) });
        }
        if selection.len() == 1 && !trash && i.consume_key(Modifiers::NONE, Key::F2) {
            actions.push(Action::Rename(selection[0].clone()));
        }
        if selection.len() == 1 && i.consume_key(Modifiers::NONE, Key::Enter) {
            actions.push(Action::Open(selection[0].clone()));
        }
        if selection.len() == 1 && i.consume_key(Modifiers::COMMAND | Modifiers::SHIFT, Key::I) {
            actions.push(Action::Info(selection[0].clone()));
        }
        if !selection.is_empty() && !trash && i.consume_key(Modifiers::COMMAND, Key::C) {
            actions.push(Action::Clip(selection.iter().map(|x| x.id.clone()).collect(), false));
        }
        if !selection.is_empty() && folder && i.consume_key(Modifiers::COMMAND, Key::X) {
            actions.push(Action::Clip(selection.iter().map(|x| x.id.clone()).collect(), true));
        }
        if folder && (b.clip.is_some() || b.system_clip) && i.consume_key(Modifiers::COMMAND, Key::V) {
            actions.push(Action::Paste);
        }
        if i.consume_key(Modifiers::NONE, Key::Backspace) {
            actions.push(Action::Back);
        }
        if folder && !b.path.is_empty() && i.consume_key(Modifiers::ALT, Key::ArrowUp) {
            actions.push(Action::Crumb(b.path.len().checked_sub(2)));
        }
        // Plain letters and digits select by name; shortcuts with Ctrl or Alt do not.
        if !i.modifiers.command && !i.modifiers.alt {
            for event in &i.events {
                if let egui::Event::Text(text) = event
                    && text.chars().all(|c| !c.is_control())
                {
                    typed.push_str(text);
                }
            }
        }
    });
    if !typed.is_empty() && count > 0 {
        type_ahead(&mut main.browser, &typed, now);
    }
}
