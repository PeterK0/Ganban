//! The share door's HTML: the link's page, the password form and the "isn't available"
//! page. Server-rendered, one inline stylesheet in Gilt's Mocha colours, the system font
//! stack, no scripts and no external assets (the door's CSP allows none).

use super::{LinkRow, LiveFile};

/// Escape text for HTML (content and attribute values).
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// "1.2 GB", in 1024s like the app's own file sizes, so the page and the task's
/// Files tab agree on a folder's size.
pub fn fmt_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

const STYLE: &str = r#"
:root{--base:#1e1e2e;--mantle:#181825;--s0:#313244;--s1:#45475a;--text:#e0def4;--sub:#bac2de;--mut:#9399b2;
--gold:#f9e2af;--giltA:rgba(249,226,175,.30);--giltB:rgba(249,226,175,.11);--err:#f38ba8}
*{box-sizing:border-box}
html{background:var(--mantle);color:var(--text);
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
body{margin:0;padding:24px 16px}
main{max-width:860px;margin:0 auto;background:var(--base);border:1px solid var(--giltA);border-radius:10px;
padding:24px;box-shadow:inset 0 0 0 4px var(--base),inset 0 0 0 5px var(--giltB)}
h1{margin:0 0 4px;font-size:1.5rem;line-height:1.3;color:var(--gold);overflow-wrap:anywhere}
.meta{margin:0 0 20px;color:var(--sub)}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:10px 18px;border-radius:8px;border:1px solid var(--gold);
background:var(--gold);color:var(--base);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn[aria-disabled=true]{background:transparent;color:var(--sub);border-color:var(--s1);cursor:default}
a{color:var(--gold)}
a:focus-visible,.btn:focus-visible,input:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
table{width:100%;border-collapse:collapse;margin-top:20px}
caption{text-align:left;color:var(--mut);font-size:.875rem;padding-bottom:6px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--s0);vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:.8125rem;text-transform:uppercase;letter-spacing:.04em}
td.size,th.size{text-align:right;white-space:nowrap;color:var(--sub)}
td a{overflow-wrap:anywhere}
.dir{color:var(--mut);font-size:.875rem;overflow-wrap:anywhere}
.note{color:var(--sub);font-size:.9375rem}
.err{color:var(--err);font-weight:600}
label{display:block;margin:12px 0 6px;color:var(--sub)}
input[type=password]{width:100%;max-width:360px;min-height:44px;padding:8px 12px;border-radius:8px;
border:1px solid var(--s1);background:var(--mantle);color:var(--text);font:inherit}
input[type=password]:focus{border-color:var(--gold)}
form .btn{margin-top:14px}
footer{max-width:860px;margin:16px auto 0;color:var(--mut);font-size:.8125rem;text-align:center}
@media (max-width:560px){body{padding:12px 8px}main{padding:16px}th,td{padding:8px 4px}}
"#;

fn shell(title: &str, body: &str, refresh: bool) -> String {
    let refresh = if refresh { r#"<meta http-equiv="refresh" content="5">"# } else { "" };
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex,nofollow\">{refresh}\
         <title>{}</title><style>{STYLE}</style></head><body><main>{body}</main>\
         <footer>Shared with Ganban</footer></body></html>",
        esc(title)
    )
}

/// The page for an unknown, expired or revoked link (and the door's 404s for `/s/…`).
pub fn unavailable() -> String {
    shell(
        "This link isn't available",
        "<h1>This link isn't available</h1><p class=\"note\">It may have expired or been withdrawn. \
         Ask the person who sent it for a new one.</p>",
        false,
    )
}

/// The page for too many tries.
pub fn too_many() -> String {
    shell(
        "Too many tries",
        "<h1>Too many tries</h1><p class=\"note\">Please wait a few minutes and try again.</p>",
        false,
    )
}

/// The password form.
pub fn password_form(token: &str, label: &str, wrong: bool) -> String {
    let wrong = if wrong { r#"<p class="err" role="alert" id="pw-err">That password isn't right.</p>"# } else { "" };
    let described = if wrong.is_empty() { "" } else { r#" aria-describedby="pw-err" aria-invalid="true""# };
    shell(
        label,
        &format!(
            "<h1>{}</h1><p class=\"meta\">This link is protected with a password.</p>{wrong}\
             <form method=\"post\" action=\"/s/{token}/unlock\">\
             <label for=\"pw\">Password</label>\
             <input id=\"pw\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required autofocus{described}>\
             <div><button class=\"btn\" type=\"submit\">Open</button></div></form>",
            esc(label),
        ),
        false,
    )
}

/// The link's page: label, totals, expiry, Download all and the file list.
pub fn link_page(token: &str, link: &LinkRow, files: &[LiveFile], gone: usize, ready: bool) -> String {
    let total: u64 = files.iter().map(|f| f.row.size.max(0) as u64).sum();
    let count = files.len();
    let expiry = match link.expires_at {
        Some(e) => format!("available until {}", e.format("%-d %b %Y, %H:%M UTC")),
        None => "no expiry".to_string(),
    };
    let summary = format!(
        "{count} file{} · {} · {expiry}",
        if count == 1 { "" } else { "s" },
        fmt_bytes(total)
    );
    let zip = if count == 0 {
        String::new()
    } else if ready {
        format!(r#"<a class="btn" href="/s/{token}/zip" download>Download all (.zip, {})</a>"#, fmt_bytes(total))
    } else {
        r#"<span class="btn" role="status" aria-disabled="true">Preparing the zip…</span>
<p class="note">This takes a few seconds per gigabyte. The page reloads by itself; single files can be downloaded now.</p>"#
            .to_string()
    };
    let gone = match gone {
        0 => String::new(),
        1 => r#"<p class="note">1 file is no longer available.</p>"#.to_string(),
        n => format!(r#"<p class="note">{n} files are no longer available.</p>"#),
    };
    let mut rows = String::new();
    for f in files {
        let dir = if f.row.folder.is_empty() { String::new() } else { format!("{}/", esc(&f.row.folder)) };
        rows.push_str(&format!(
            "<tr><td class=\"dir\">{dir}</td><td><a href=\"/s/{token}/f/{}\" download>{}</a></td>\
             <td class=\"size\">{}</td></tr>",
            f.row.n,
            esc(&f.row.name),
            fmt_bytes(f.row.size.max(0) as u64),
        ));
    }
    let table = if files.is_empty() {
        String::new()
    } else {
        format!(
            "<table><caption>Files</caption><thead><tr><th scope=\"col\">Folder</th>\
             <th scope=\"col\">Name</th><th scope=\"col\" class=\"size\">Size</th></tr></thead><tbody>{rows}</tbody></table>"
        )
    };
    shell(
        &link.label,
        &format!("<h1>{}</h1><p class=\"meta\">{summary}</p>{zip}{gone}{table}", esc(&link.label)),
        !ready && count > 0,
    )
}
