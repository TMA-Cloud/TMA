//! The standalone document page that hosts the ONLYOFFICE editor. The editor
//! itself is the document server's JavaScript, so this page carries the one
//! inline script that starts it, under the request's CSP nonce.

use serde_json::Value;

use crate::util::{escape_html as esc, json_for_script};

const STYLE: &str = "*{margin:0;padding:0;box-sizing:border-box}html,body{height:100vh;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#f7f6f3;display:flex;flex-direction:column}
body.dark{background:#1b1b19}
.header{background:#f9f9f7;border-bottom:1px solid #e7e6e1;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;min-height:48px;flex-shrink:0}
body.dark .header{background:#2c2c28;border-bottom-color:#4a4944}
.header h1{font-size:15px;font-weight:600;color:#2b2a26;flex:1;margin-right:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
body.dark .header h1{color:#f5f4f1}
.header button{padding:7px 14px;background:transparent;color:#0866cc;border:1px solid rgba(43,42,38,.17);border-radius:8px;cursor:pointer;font-size:13px;font-weight:550}
body.dark .header button{color:#0a84ff;border-color:rgba(132,130,120,.34)}
.editor{flex:1;position:relative;overflow:hidden}
#onlyoffice-editor-container{width:100%;height:100%}
.loading{display:flex;align-items:center;justify-content:center;height:100%;color:#66645d;font-size:14px}
body.dark .loading{color:#b0aea6}";

/// The editor page for one document.
pub fn editor_page(title: &str, js_url: &str, config: &Value, theme: Option<&str>, nonce: &str) -> String {
    let dark = matches!(theme, Some("dark"));
    let theme_js = match theme {
        Some(t @ ("dark" | "light")) => format!("\"{t}\""),
        _ => "null".into(),
    };
    format!(
        r#"<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} - ONLYOFFICE</title><style>{STYLE}</style></head>
<body class="{body_class}"><div class="header"><h1>{title}</h1><button id="close-tab" type="button">Close</button></div>
<div class="editor"><div id="onlyoffice-editor-container" class="loading">Loading editor…</div></div>
<script src="{js}"></script>
<script nonce="{nonce}">
document.getElementById('close-tab').addEventListener('click',()=>window.close());
var appTheme={theme_js};
if(!appTheme&&window.matchMedia('(prefers-color-scheme: dark)').matches)document.body.classList.add('dark');
new DocsAPI.DocEditor('onlyoffice-editor-container',{config});
</script></body></html>"#,
        title = esc(title),
        body_class = if dark { "dark" } else { "" },
        js = esc(js_url),
        nonce = esc(nonce),
        config = json_for_script(config),
    )
}

/// Shown in a new tab when a document cannot be opened.
pub fn cannot_open_page(name: &str, reason: &str) -> String {
    format!(
        "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Cannot open file</title>\
         <style>body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;padding:40px;text-align:center;\
         background:#f7f6f3;color:#2b2a26}}h1{{color:#d70015;font-size:20px}}p{{color:rgba(43,42,38,.7)}}\
         @media (prefers-color-scheme:dark){{body{{background:#1b1b19;color:#f5f4f1}}h1{{color:#ff6961}}p{{color:rgba(240,239,233,.62)}}}}</style>\
         </head><body><h1>Cannot open file</h1><p>{}</p><p>{}</p></body></html>",
        esc(name),
        esc(reason)
    )
}
