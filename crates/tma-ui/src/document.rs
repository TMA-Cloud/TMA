//! Documents open inside the web app, as before: OnlyOffice's own editor in a
//! page overlay above the canvas. The server forbids framing its pages, so the
//! editor is mounted from its config with the document server's API script.

/// Colours for the overlay's bar, from the app's palette.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub struct Look {
    pub background: String,
    pub surface: String,
    pub text: String,
    pub separator: String,
}

/// Mount the editor for one document; `tab_url` is its full-page viewer, for "Open in tab".
#[cfg(target_arch = "wasm32")]
pub async fn open(name: &str, reply: serde_json::Value, look: &Look, tab_url: &str) -> Result<(), String> {
    use wasm_bindgen::JsCast;
    use wasm_bindgen::closure::Closure;

    const OVERLAY: &str = "tma-document";
    const EDITOR: &str = "tma-document-editor";
    let js_url = reply["onlyofficeJsUrl"].as_str().unwrap_or_default().to_string();
    if !(js_url.starts_with("https://") || js_url.starts_with("http://") || js_url.starts_with('/')) {
        return Err("The document server's address is not valid".into());
    }
    let mut config = reply["config"].clone();
    if let Some(token) = reply["token"].as_str() {
        config["token"] = serde_json::Value::String(token.to_string());
    }
    let window = web_sys::window().ok_or("No browser window")?;
    let document = window.document().ok_or("No document")?;
    if let Some(old) = document.get_element_by_id(OVERLAY) {
        old.remove();
    }
    let body = document.body().ok_or("No page body")?;
    let element = |tag: &str, style: &str| -> Result<web_sys::Element, String> {
        let e = document.create_element(tag).map_err(|_| "Cannot build the editor")?;
        let _ = e.set_attribute("style", style);
        Ok(e)
    };
    let overlay = element(
        "div",
        &format!(
            "position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:{}",
            look.background
        ),
    )?;
    overlay.set_id(OVERLAY);
    let bar = element(
        "div",
        &format!(
            "display:flex;align-items:center;gap:8px;padding:8px 14px;background:{};border-bottom:1px solid {};font:600 14px Figtree,system-ui,sans-serif;color:{}",
            look.surface, look.separator, look.text
        ),
    )?;
    let title = element("span", "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap")?;
    title.set_text_content(Some(name));
    let button_style = format!(
        "border:1px solid {};background:transparent;color:{};border-radius:16px;padding:6px 14px;font:inherit;cursor:pointer",
        look.separator, look.text
    );
    let open_tab = element("button", &button_style)?;
    open_tab.set_text_content(Some("Open in tab"));
    let close = element("button", &button_style)?;
    close.set_text_content(Some("Close"));
    let editor = element("div", "flex:1;min-height:0")?;
    editor.set_id(EDITOR);
    for child in [&title, &open_tab, &close] {
        let _ = bar.append_child(child);
    }
    let _ = overlay.append_child(&bar);
    let _ = overlay.append_child(&editor);
    let _ = body.append_child(&overlay);

    let remove = overlay.clone();
    let on_close = Closure::<dyn FnMut()>::new(move || remove.remove());
    let _ = close.add_event_listener_with_callback("click", on_close.as_ref().unchecked_ref());
    on_close.forget();
    let (remove, url) = (overlay.clone(), tab_url.to_string());
    let on_tab = Closure::<dyn FnMut()>::new(move || {
        if let Some(w) = web_sys::window() {
            let _ = w.open_with_url_and_target_and_features(&url, "_blank", "noopener,noreferrer");
        }
        // Editing in two places at once would be confusing; the tab takes over.
        remove.remove();
    });
    let _ = open_tab.add_event_listener_with_callback("click", on_tab.as_ref().unchecked_ref());
    on_tab.forget();

    let docs_api = || js_sys::Reflect::get(&window, &"DocsAPI".into()).ok().filter(|v| !v.is_undefined());
    if docs_api().is_none() {
        let script = document.create_element("script").map_err(|_| "Cannot load the editor")?;
        let _ = script.set_attribute("src", &js_url);
        let loaded = js_sys::Promise::new(&mut |resolve, reject| {
            let target: &web_sys::EventTarget = script.as_ref();
            let _ = target.add_event_listener_with_callback("load", &resolve);
            let _ = target.add_event_listener_with_callback("error", &reject);
        });
        let _ = body.append_child(&script);
        wasm_bindgen_futures::JsFuture::from(loaded).await.map_err(|_| {
            overlay.remove();
            "Cannot reach the document server".to_string()
        })?;
    }
    let api = docs_api().ok_or("The document server did not load its editor")?;
    let constructor = js_sys::Reflect::get(&api, &"DocEditor".into())
        .ok()
        .and_then(|c| c.dyn_into::<js_sys::Function>().ok())
        .ok_or("The document server's editor is missing")?;
    let config = js_sys::JSON::parse(&config.to_string()).map_err(|_| "The editor settings are not valid")?;
    js_sys::Reflect::construct(&constructor, &js_sys::Array::of2(&EDITOR.into(), &config))
        .map_err(|_| "The editor could not start")?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn open(_name: &str, _reply: serde_json::Value, _look: &Look, _tab_url: &str) -> Result<(), String> {
    Err("Documents open inside the web app only".into())
}
