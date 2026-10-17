//! The form and inputs on the page, kept in step with the sign-in card.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;
use web_sys::{Document, Event, HtmlFormElement, HtmlInputElement, KeyboardEvent};

use super::{Field, Kind, Seen};

const FORM_ID: &str = "tma_login";
const CANVAS_ID: &str = "tma_canvas";

struct Input {
    el: HtmlInputElement,
    /// Enter was pressed in it since the last frame.
    enter: Rc<Cell<bool>>,
    /// The text both sides agreed on last frame, to tell who changed it since.
    agreed: String,
    style: String,
    _listeners: Vec<Closure<dyn FnMut(Event)>>,
}

struct Form {
    form: HtmlFormElement,
    sheet: web_sys::Element,
    sheet_text: String,
    inputs: HashMap<Kind, Input>,
    drawn: HashSet<Kind>,
    _submit: Closure<dyn FnMut(Event)>,
}

thread_local! {
    static FORM: RefCell<Option<Form>> = const { RefCell::new(None) };
}

fn document() -> Option<Document> {
    web_sys::window()?.document()
}

fn css(c: egui::Color32) -> String {
    format!("rgba({},{},{},{:.3})", c.r(), c.g(), c.b(), f32::from(c.a()) / 255.0)
}

fn new_form(doc: &Document) -> Option<Form> {
    let form: HtmlFormElement = doc.create_element("form").ok()?.dyn_into().ok()?;
    form.set_id(FORM_ID);
    // The app checks the fields itself; the browser's own bubbles would block the submit event.
    let _ = form.set_attribute("novalidate", "");
    let _ = form.set_attribute("autocomplete", "on");
    let _ = form.set_attribute("action", "#");
    let _ = form.set_attribute("method", "post");
    // Submitting tells password managers what was sent; the page itself never leaves.
    let submit = Closure::<dyn FnMut(Event)>::new(|e: Event| e.prevent_default());
    let _ = form.add_event_listener_with_callback("submit", submit.as_ref().unchecked_ref());
    let sheet = doc.create_element("style").ok()?;
    let body = doc.body()?;
    let _ = body.append_child(&sheet);
    let _ = body.append_child(&form);
    Some(Form {
        form,
        sheet,
        sheet_text: String::new(),
        inputs: HashMap::new(),
        drawn: HashSet::new(),
        _submit: submit,
    })
}

fn new_input(doc: &Document, form: &HtmlFormElement, kind: Kind, ctx: &egui::Context) -> Option<Input> {
    let el: HtmlInputElement = doc.create_element("input").ok()?.dyn_into().ok()?;
    el.set_name(kind.key());
    el.set_id(&format!("tma_{}", kind.key()));
    let _ = el.set_attribute("spellcheck", "false");
    let _ = el.set_attribute("autocapitalize", "off");
    if kind == Kind::Code {
        let _ = el.set_attribute("inputmode", "numeric");
    }
    let enter = Rc::new(Cell::new(false));
    let mut listeners = Vec::new();
    for event in ["input", "change", "focus", "blur"] {
        let ctx = ctx.clone();
        let repaint = Closure::<dyn FnMut(Event)>::new(move |_: Event| ctx.request_repaint());
        let _ = el.add_event_listener_with_callback(event, repaint.as_ref().unchecked_ref());
        listeners.push(repaint);
    }
    let (ctx, pressed) = (ctx.clone(), enter.clone());
    let keydown = Closure::<dyn FnMut(Event)>::new(move |e: Event| {
        if e.dyn_ref::<KeyboardEvent>().is_some_and(|k| k.key() == "Enter") {
            e.prevent_default();
            pressed.set(true);
            ctx.request_repaint();
        }
    });
    let _ = el.add_event_listener_with_callback("keydown", keydown.as_ref().unchecked_ref());
    listeners.push(keydown);
    let _ = form.append_child(&el);
    Some(Input { el, enter, agreed: String::new(), style: String::new(), _listeners: listeners })
}

pub fn begin() {
    FORM.with_borrow_mut(|form| {
        if let Some(form) = form {
            form.drawn.clear();
        }
    });
}

pub fn field(ctx: &egui::Context, field: Field<'_>, t: &crate::theme::Tokens) -> Seen {
    let Some(doc) = document() else { return Seen::default() };
    FORM.with_borrow_mut(|slot| {
        if slot.is_none() {
            *slot = new_form(&doc);
        }
        let Some(form) = slot else { return Seen::default() };
        // Browsers paint autofilled inputs with their own light background and dark text;
        // the text colour is set back, and the background change waits out the session.
        let sheet = format!(
            "#{FORM_ID} input::placeholder{{color:{placeholder};opacity:1}}\
             #{FORM_ID} input:-webkit-autofill,#{FORM_ID} input:-webkit-autofill:hover,\
             #{FORM_ID} input:-webkit-autofill:focus{{-webkit-text-fill-color:{text};caret-color:{caret};\
             transition:background-color 100000s 0s,color 100000s 0s;}}\
             #{FORM_ID} input:autofill{{filter:none;background:transparent;color:{text};}}",
            placeholder = css(t.label_tertiary),
            text = css(t.label),
            caret = css(t.accent),
        );
        if form.sheet_text != sheet {
            form.sheet.set_text_content(Some(&sheet));
            form.sheet_text = sheet;
        }
        if !form.inputs.contains_key(&field.kind)
            && let Some(input) = new_input(&doc, &form.form, field.kind, ctx)
        {
            form.inputs.insert(field.kind, input);
        }
        let Some(input) = form.inputs.get_mut(&field.kind) else { return Seen::default() };
        form.drawn.insert(field.kind);
        place(&doc, input, &field, t);
        sync(input, field.value);
        let focused =
            doc.active_element().is_some_and(|a| a.is_same_node(Some(AsRef::<web_sys::Node>::as_ref(&input.el))));
        Seen { enter: input.enter.replace(false), focused }
    })
}

/// Lay the input over its frame and give it this field's type, hint and colours.
fn place(doc: &Document, input: &mut Input, field: &Field<'_>, t: &crate::theme::Tokens) {
    let origin = doc.get_element_by_id(CANVAS_ID).map(|c| c.get_bounding_client_rect());
    let (left, top) = origin.map_or((0.0, 0.0), |r| (r.left(), r.top()));
    let r = field.rect;
    let style = format!(
        "position:fixed;left:{:.1}px;top:{:.1}px;width:{:.1}px;height:{:.1}px;margin:0;padding:0;\
         box-sizing:border-box;border:0;outline:0;background:transparent;color:{};caret-color:{};\
         font:14px Geist,system-ui,-apple-system,'Segoe UI',sans-serif;z-index:5;",
        left + f64::from(r.min.x),
        top + f64::from(r.min.y),
        r.width(),
        r.height(),
        css(t.label),
        css(t.accent),
    );
    if input.style != style {
        let _ = input.el.set_attribute("style", &style);
        input.style = style;
    }
    let kind = field.kind;
    let wanted = [
        ("type", kind.input_type(field.shown)),
        ("autocomplete", kind.autocomplete(field.signing_up)),
        ("placeholder", field.placeholder),
    ];
    for (name, value) in wanted {
        if input.el.get_attribute(name).as_deref() != Some(value) {
            let _ = input.el.set_attribute(name, value);
        }
    }
}

/// Typing and autofill change the input; the app changes the string (a reset
/// or a mode switch). Whichever moved since last frame wins.
fn sync(input: &mut Input, value: &mut String) {
    let dom = input.el.value();
    if dom != input.agreed {
        value.clone_from(&dom);
        input.agreed = dom;
    } else if *value != input.agreed {
        input.el.set_value(value);
        input.agreed.clone_from(value);
    }
}

pub fn end() {
    FORM.with_borrow_mut(|slot| {
        let Some(form) = slot else { return };
        let gone: Vec<Kind> = form.inputs.keys().filter(|k| !form.drawn.contains(k)).copied().collect();
        for kind in gone {
            if let Some(input) = form.inputs.remove(&kind) {
                input.el.remove();
            }
        }
    });
}

pub fn submitted() {
    FORM.with_borrow(|slot| {
        if let Some(form) = slot {
            let _ = form.form.request_submit();
        }
    });
}

pub fn remove() {
    FORM.with_borrow_mut(|slot| {
        if let Some(form) = slot.take() {
            form.form.remove();
            form.sheet.remove();
        }
    });
}
