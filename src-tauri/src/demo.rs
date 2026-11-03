//! Demonstration capture + attended replay (DEMONSTRATION.md §2/§6, Phase A).
//!
//! Capture opens a separate Tauri WebviewWindow at the target URL with an
//! injected recorder (initialization script — runs on every page load in that
//! window, and only there). The recorder captures SEMANTIC steps with
//! redundant locator bundles; narration is typed in the main window's panel.
//!
//! ## The transport (why document.title, of all things)
//!
//! Remote pages get no Tauri IPC (by security design), and any network-ish
//! channel (custom scheme fetch, loopback HTTP) is at the mercy of the page's
//! own CSP `connect-src`. The one channel a page cannot block and Ganban
//! already owns on both ends:
//!
//!   page → Rust:  the recorder serializes one message at a time into
//!                 `document.title` (`⟪GANBAN⟫seq⟪…base64 json…⟫`); Rust
//!                 polls `window.title()` every 200ms.
//!   Rust → page:  `window.eval()` — acks (`__ganban_ack(seq)`) and replay
//!                 step commands.
//!
//! Cosmetic cost: the recording window's title flickers. Correctness cost:
//! none — the queue is acked one message at a time. The visible title churn
//! even doubles as a recording indicator in the OS window list.
//!
//! Replay executes the protocol's FROZEN steps (never the page's suggestions)
//! by locator-bundle resolution, and reports per-step results back over the
//! same channel. Attended by definition here — Phase B moves unattended
//! replay into the render sidecar.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const CAPTURE_LABEL: &str = "demo-capture";
const REPLAY_LABEL: &str = "demo-replay";
const PAGE_LABEL: &str = "page-capture";
const TITLE_MARK: &str = "⟪GANBAN⟫";

/// Monotonic capture generation — a new start invalidates the old poll task.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Replay results funnel (poll task → the driving `demo_replay` command).
static REPLAY_TX: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Value>>> = Mutex::new(None);

/// Shared locator library: `build(el)` records a redundant bundle at click
/// time; `resolve(bundle)` tries the strategies IN ORDER, deterministically,
/// at replay (css → text → aria → xpath → neighbor). DEMONSTRATION.md §3.
const LOCATOR_JS: &str = r#"
(function () {
  if (window.__ganban_loc) return;
  const vis = (el) => !!(el && el.offsetParent !== null);
  const txt = (el) => (el.innerText || el.value || '').trim().slice(0, 80);
  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      let s = n.localName;
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const sibs = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.localName === n.localName) : [];
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }
  function xPath(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      let i = 1, sib = n.previousElementSibling;
      while (sib) { if (sib.localName === n.localName) i++; sib = sib.previousElementSibling; }
      parts.unshift(n.localName + '[' + i + ']');
      n = n.parentElement;
    }
    return '/' + parts.join('/');
  }
  function neighborLabel(el) {
    let n = el;
    for (let hop = 0; n && hop < 4; hop++) {
      let sib = n.previousElementSibling;
      while (sib) {
        const t = (sib.innerText || '').trim();
        if (t && t.length <= 60) return t;
        sib = sib.previousElementSibling;
      }
      n = n.parentElement;
    }
    const lab = el.labels && el.labels[0];
    return lab ? (lab.innerText || '').trim().slice(0, 60) : null;
  }
  function build(el) {
    return {
      css: cssPath(el),
      text: txt(el) || null,
      aria: { role: el.getAttribute('role') || null, label: el.getAttribute('aria-label') || null },
      xpath: xPath(el),
      neighbor: neighborLabel(el),
    };
  }
  function byText(t) {
    if (!t) return null;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walk.nextNode())) {
      if (vis(n) && n.children.length === 0 && (n.innerText || '').trim() === t) return n;
    }
    return null;
  }
  function resolve(b) {
    try { const el = b.css && document.querySelector(b.css); if (el && vis(el)) return el; } catch (e) {}
    const t = byText(b.text); if (t) return t;
    if (b.aria && b.aria.label) {
      const el = document.querySelector('[aria-label="' + (window.CSS ? CSS.escape(b.aria.label) : b.aria.label) + '"]');
      if (el && vis(el)) return el;
    }
    try {
      const r = document.evaluate(b.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (r && vis(r)) return r;
    } catch (e) {}
    if (b.neighbor) {
      const anchor = byText(b.neighbor);
      if (anchor) {
        let n = anchor;
        for (let hop = 0; n && hop < 4; hop++) {
          const cand = n.nextElementSibling;
          if (cand && vis(cand)) return cand;
          n = n.parentElement;
        }
      }
    }
    return null;
  }
  window.__ganban_loc = { build, resolve };
})();
"#;

/// The title-channel sender + ack plumbing, shared by recorder and replayer.
const CHANNEL_JS: &str = r#"
(function () {
  if (window.__ganban_send) return;
  const MARK = '\u27EAGANBAN\u27EB';
  let q = [], seq = 0, inflight = null, savedTitle = document.title;
  function pump() {
    if (inflight || q.length === 0) return;
    inflight = q[0];
    document.title = MARK + inflight.seq + MARK + btoa(unescape(encodeURIComponent(JSON.stringify(inflight.msg))));
  }
  window.__ganban_send = function (msg) {
    q.push({ seq: ++seq, msg });
    pump();
  };
  window.__ganban_ack = function (n) {
    if (inflight && inflight.seq === n) { q.shift(); inflight = null; document.title = savedTitle; pump(); }
  };
  // Queue depth — lets senders show REAL delivery progress (a message is only
  // gone once Rust acked it, not when it was queued).
  window.__ganban_pending = function () { return q.length; };
})();
"#;

/// Capture-mode script: record clicks / inputs / alt-click extracts as steps.
const RECORDER_JS: &str = r#"
(function () {
  if (window.__ganban_recorder) return;
  window.__ganban_recorder = true;
  const send = (m) => window.__ganban_send(m);
  // One navigate step per page load; a wait_for is prefixed to the first
  // interaction so replays don't race the DOM.
  send({ kind: 'step', step: { op: 'navigate', url: location.href } });
  let waited = false;
  function waitFirst(bundle) {
    if (waited) return;
    waited = true;
    send({ kind: 'step', step: { op: 'wait_for', locator: bundle, timeout_ms: 8000 } });
  }
  document.addEventListener('click', function (e) {
    const el = e.target.closest('a,button,input,select,td,th,span,div,label,[role]') || e.target;
    const bundle = window.__ganban_loc.build(el);
    if (e.altKey) {
      // Alt-click = "extract this" — the demonstrated ground truth.
      e.preventDefault(); e.stopPropagation();
      const raw = (el.innerText || el.value || '').trim();
      const ty = /^[\s$€£]*-?[\d.,]+%?$/.test(raw) ? 'number' : 'string';
      const name = 'value_' + (++window.__ganban_extracts || (window.__ganban_extracts = 1), window.__ganban_extracts);
      waitFirst(bundle);
      send({ kind: 'step', step: { op: 'extract', locator: bundle, as: name, type: ty } });
      el.style.outline = '2px solid #A78BFA';
      return;
    }
    waitFirst(bundle);
    send({ kind: 'step', step: { op: 'click', locator: bundle } });
  }, true);
  document.addEventListener('change', function (e) {
    const el = e.target;
    if (!('value' in el)) return;
    const bundle = window.__ganban_loc.build(el);
    waitFirst(bundle);
    send({ kind: 'step', step: { op: 'input', locator: bundle, value: String(el.value).slice(0, 500) } });
  }, true);
  // Visible indicator + hard stop (SECURITY: recording is confined to THIS
  // window, indicated, stoppable instantly).
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#161A22;color:#E7E9EF;border:1px solid #A78BFA;border-radius:10px;padding:8px 12px;font:12px -apple-system,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 6px 20px rgba(0,0,0,.4)';
  bar.innerHTML = '<span style="color:#F06D6D">⏺</span> Ganban is recording this window <span id="__gb_n">·</span>';
  const stop = document.createElement('button');
  stop.textContent = 'Stop';
  stop.style.cssText = 'background:#A78BFA;color:#fff;border:0;border-radius:7px;padding:4px 10px;font:600 12px -apple-system,sans-serif;cursor:pointer';
  stop.onclick = () => send({ kind: 'stopped' });
  bar.appendChild(stop);
  (document.body || document.documentElement).appendChild(bar);
})();
"#;

/// Replay-mode script: expose `__ganban_replay_step(step, seq)` — resolve the
/// bundle, act, report. Idempotent per seq (Rust re-evals until a result
/// lands, because an eval during navigation can vanish silently).
const REPLAYER_JS: &str = r#"
(function () {
  if (window.__ganban_replayer) return;
  window.__ganban_replayer = true;
  const done = {};
  const send = (m) => window.__ganban_send(m);
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#161A22;color:#7CE7CC;border:1px solid #37D6AE;border-radius:10px;padding:8px 12px;font:12px -apple-system,sans-serif';
  bar.textContent = '▶ Ganban attended replay';
  (document.body || document.documentElement).appendChild(bar);
  window.__ganban_replay_step = function (step, seq) {
    if (done[seq]) return;
    const finish = (ok, extra) => {
      if (done[seq]) return;
      done[seq] = true;
      send(Object.assign({ kind: 'result', seq: seq, op: step.op, ok: ok }, extra || {}));
    };
    if (step.op === 'wait_for') {
      const deadline = Date.now() + (step.timeout_ms || 8000);
      (function poll() {
        if (done[seq]) return;
        if (window.__ganban_loc.resolve(step.locator)) return finish(true, {});
        if (Date.now() > deadline) return finish(false, { error: 'wait_for timed out' });
        setTimeout(poll, 250);
      })();
      return;
    }
    const el = window.__ganban_loc.resolve(step.locator);
    if (!el) return finish(false, { error: 'locator miss (all strategies failed)' });
    el.style.outline = '2px solid #37D6AE';
    if (step.op === 'extract') {
      const raw = (el.innerText || el.value || '').trim();
      let v = raw;
      if (step.type === 'number') { const m = raw.replace(/[^\d.,-]/g, '').replace(/,/g, ''); v = parseFloat(m); }
      return finish(true, { as: step.as, value: v });
    }
    if (step.op === 'input') {
      el.focus();
      el.value = step.value || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return finish(true, {});
    }
    if (step.op === 'click') {
      // Report FIRST (a click can navigate away and take the channel with it),
      // act after the title transfer has had a poll cycle to land.
      finish(true, {});
      setTimeout(() => el.click(), 450);
      return;
    }
    finish(false, { error: 'unknown op ' + step.op });
  };
})();
"#;

/// Page-save mode: a floating "Save this page" bar. Pressing Save serializes
/// the SETTLED, rendered DOM (scripts stripped, <base> injected so relative
/// resources still resolve when the artifact is viewed) plus the body's
/// innerText (the token-cheap form llm.transform actually wants), and ships
/// both through the title channel in ordered chunks. The interim attended
/// path: the owner IS the browser; the artifact is inert.
const PAGESAVE_JS: &str = r#"
(function () {
  if (window.__ganban_pagesave) return;
  window.__ganban_pagesave = true;
  const send = (m) => window.__ganban_send(m);
  // WebKit TRUNCATES long document.title values (~4K chars) — a fatter chunk
  // arrives clipped, base64 decode fails, Rust never acks, the queue never
  // drains (the "stuck at 0%" bug). Stay well under the cap and win the
  // throughput back with gzip + a fast poll.
  const CHUNK = 2800;
  function ship(doc, s) {
    for (let i = 0; i < s.length; i += CHUNK) send({ kind: 'page_chunk', doc: doc, data: s.slice(i, i + CHUNK) });
  }
  async function gzB64(s) {
    const stream = new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let out = '';
    for (let i = 0; i < buf.length; i += 32768) out += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
    return btoa(out);
  }
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#161A22;color:#E7E9EF;border:1px solid #A78BFA;border-radius:10px;padding:8px 12px;font:12px -apple-system,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 6px 20px rgba(0,0,0,.4)';
  bar.innerHTML = '<span>📸</span> Browse to the page you want, then →';
  const save = document.createElement('button');
  save.textContent = 'Save this page';
  save.style.cssText = 'background:#A78BFA;color:#fff;border:0;border-radius:7px;padding:4px 10px;font:600 12px -apple-system,sans-serif;cursor:pointer';
  save.onclick = async function () {
    save.disabled = true;
    save.textContent = 'Packing…';
    try {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script,noscript,iframe').forEach((n) => n.remove());
      const head = clone.querySelector('head');
      if (head && !head.querySelector('base')) {
        const base = document.createElement('base');
        base.href = location.href;
        head.prepend(base);
      }
      let html = '<!DOCTYPE html>\n' + clone.outerHTML;
      let text = document.body ? document.body.innerText : '';
      // gzip when the engine has it (Safari 16.4+): a multi-MB catalogue page
      // compresses ~8x, and the transport pays per character.
      let enc = 'plain';
      if (window.CompressionStream) {
        enc = 'gz';
        html = await gzB64(html);
        text = await gzB64(text);
      }
      send({ kind: 'page_begin', url: location.href, title: document.title, enc: enc, bytes: html.length + text.length });
      ship('text', text); // the token-cheap doc lands first
      ship('html', html);
      send({ kind: 'page_done' });
      // Delivery progress: the queue drains one acked message per poll cycle —
      // "sent" is only true when the channel is EMPTY, so say so honestly.
      // Clamped: a Cancel pressed mid-drain ADDS a message (the -5% bug).
      const totalMsgs = window.__ganban_pending();
      const tick = setInterval(function () {
        const left = window.__ganban_pending();
        if (left > 0) {
          const pct = Math.max(0, Math.min(100, Math.round(((totalMsgs - left) / totalMsgs) * 100)));
          save.textContent = 'Sending… ' + pct + '%';
        } else {
          save.textContent = 'Delivered ✓ — Ganban is saving…';
          clearInterval(tick);
        }
      }, 250);
    } catch (e) {
      save.textContent = 'Failed: ' + e;
      save.disabled = false;
    }
  };
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'background:transparent;color:#9AA3B2;border:1px solid #333A46;border-radius:7px;padding:4px 10px;font:12px -apple-system,sans-serif;cursor:pointer';
  cancel.onclick = () => send({ kind: 'stopped' });
  bar.appendChild(save);
  bar.appendChild(cancel);
  (document.body || document.documentElement).appendChild(bar);
})();
"#;

fn boot_script(mode: &str) -> String {
    match mode {
        // Page-save needs no locator library — just the channel and the bar.
        "pagesave" => format!("{CHANNEL_JS}\n{PAGESAVE_JS}"),
        "capture" => format!("{LOCATOR_JS}\n{CHANNEL_JS}\n{RECORDER_JS}"),
        _ => format!("{LOCATOR_JS}\n{CHANNEL_JS}\n{REPLAYER_JS}"),
    }
}

/// Poll the demo window's title for channel messages; emit them to the main
/// window (`event_name`) and ack into the page. Exits when the window
/// closes or a newer generation starts.
fn spawn_title_poll(app: AppHandle, label: &'static str, generation: u64, event_name: &'static str) {
    tauri::async_runtime::spawn(async move {
        let mut last_acked: u64 = 0;
        loop {
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            // 15ms: the one-message-per-ack channel pays this interval per
            // chunk, and chunks must stay under WebKit's ~4K title cap — so
            // the poll runs hot (~66 msg/s ≈ 180KB/s of b64, several MB/s of
            // page after gzip). Reading a window title 60x/s costs nothing.
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            let Some(win) = app.get_webview_window(label) else { return };
            // A transient title-read error must not kill the channel.
            let Ok(title) = win.title() else { continue };
            let Some(rest) = title.strip_prefix(TITLE_MARK) else { continue };
            let Some((seq_s, payload)) = rest.split_once(TITLE_MARK) else { continue };
            let Ok(seq) = seq_s.parse::<u64>() else { continue };
            if seq <= last_acked {
                continue;
            }
            use base64::Engine as _;
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) else { continue };
            let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else { continue };
            last_acked = seq;
            let _ = win.eval(&format!("window.__ganban_ack && window.__ganban_ack({seq})"));
            match msg.get("kind").and_then(Value::as_str) {
                Some("result") => {
                    if let Some(tx) = REPLAY_TX.lock().unwrap().as_ref() {
                        let _ = tx.send(msg.clone());
                    }
                    let _ = app.emit(event_name, &msg);
                }
                Some("stopped") => {
                    let _ = app.emit(event_name, &msg);
                    if let Some(w) = app.get_webview_window(label) {
                        let _ = w.close();
                    }
                    return;
                }
                _ => {
                    let _ = app.emit(event_name, &msg);
                }
            }
        }
    });
}

fn open_demo_window(app: &AppHandle, label: &'static str, url: &str, mode: &str, event_name: &'static str) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("only http(s) URLs can be demonstrated".into());
    }
    // One demo window at a time; a fresh start supersedes the old poll task.
    for l in [CAPTURE_LABEL, REPLAY_LABEL, PAGE_LABEL] {
        if let Some(w) = app.get_webview_window(l) {
            let _ = w.close();
        }
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(match mode {
            "capture" => "Ganban — recording",
            "pagesave" => "Ganban — save page",
            _ => "Ganban — attended replay",
        })
        .inner_size(1100.0, 800.0)
        .initialization_script(boot_script(mode))
        .build()
        .map_err(|e| format!("could not open the demo window: {e}"))?;
    spawn_title_poll(app.clone(), label, generation, event_name);
    Ok(())
}

/// Open the capture window at `url` with the recorder injected.
#[tauri::command]
pub async fn demo_start(app: AppHandle, url: String) -> Result<(), String> {
    open_demo_window(&app, CAPTURE_LABEL, &url, "capture", "demo://message")
}

/// Close any demo window (capture, replay or page-save).
#[tauri::command]
pub async fn demo_stop(app: AppHandle) -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    for l in [CAPTURE_LABEL, REPLAY_LABEL, PAGE_LABEL] {
        if let Some(w) = app.get_webview_window(l) {
            let _ = w.close();
        }
    }
    Ok(())
}

/// Open the attended "save this page" window at `url`. The rendered page's
/// HTML + text arrive on the main window as `page://message` events
/// (page_begin → page_chunk… → page_done); the frontend assembles and
/// uploads them into a project's Files.
#[tauri::command]
pub async fn page_capture_start(app: AppHandle, url: String) -> Result<(), String> {
    open_demo_window(&app, PAGE_LABEL, &url, "pagesave", "page://message")
}

/// Close the page-save window (upload finished or the user bailed).
#[tauri::command]
pub async fn page_capture_stop(app: AppHandle) -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(PAGE_LABEL) {
        let _ = w.close();
    }
    Ok(())
}

/// Attended replay: drive the FROZEN steps in a fresh replay window, one at a
/// time, returning per-step results. Each non-navigate eval is retried until
/// its result arrives (an eval during a page load can vanish silently — the
/// page-side guard makes re-evals idempotent per seq).
#[tauri::command]
pub async fn demo_replay(app: AppHandle, steps: Vec<Value>) -> Result<Vec<Value>, String> {
    if steps.is_empty() {
        return Err("no steps to replay".into());
    }
    let first_url = steps
        .first()
        .filter(|s| s.get("op").and_then(Value::as_str) == Some("navigate"))
        .and_then(|s| s.get("url").and_then(Value::as_str))
        .ok_or("a replay must start with a navigate step")?
        .to_string();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    *REPLAY_TX.lock().unwrap() = Some(tx);
    open_demo_window(&app, REPLAY_LABEL, &first_url, "replay", "demo://message")?;
    // Let the first page boot.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let mut results: Vec<Value> = Vec::with_capacity(steps.len());
    let mut aborted = false;
    for (i, step) in steps.iter().enumerate() {
        let op = step.get("op").and_then(Value::as_str).unwrap_or("");
        if aborted {
            results.push(json!({ "seq": i, "op": op, "ok": false, "error": "skipped (an earlier step failed)" }));
            let _ = app.emit("demo://message", results.last().unwrap());
            continue;
        }
        if op == "navigate" {
            if i > 0 {
                let url = step.get("url").and_then(Value::as_str).unwrap_or("");
                if let Some(w) = app.get_webview_window(REPLAY_LABEL) {
                    let _ = w.eval(&format!("location.href = {}", serde_json::to_string(url).unwrap()));
                }
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            }
            results.push(json!({ "seq": i, "op": "navigate", "ok": true }));
            let _ = app.emit("demo://message", results.last().unwrap());
            continue;
        }
        let timeout_ms = step.get("timeout_ms").and_then(Value::as_u64).unwrap_or(10_000).min(60_000);
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms + 5_000);
        let call = format!(
            "window.__ganban_replay_step && window.__ganban_replay_step({}, {i})",
            serde_json::to_string(step).unwrap()
        );
        let result = loop {
            let Some(w) = app.get_webview_window(REPLAY_LABEL) else {
                break json!({ "seq": i, "op": op, "ok": false, "error": "the replay window was closed" });
            };
            let _ = w.eval(&call);
            match tokio::time::timeout(std::time::Duration::from_millis(700), rx.recv()).await {
                Ok(Some(r)) if r.get("seq").and_then(Value::as_u64) == Some(i as u64) => break r,
                Ok(Some(_)) => continue, // stale result from a superseded attempt
                Ok(None) => break json!({ "seq": i, "op": op, "ok": false, "error": "replay channel closed" }),
                Err(_) => {
                    if std::time::Instant::now() > deadline {
                        break json!({ "seq": i, "op": op, "ok": false, "error": "no response from the page (timed out)" });
                    }
                    // Re-eval: the page may have been mid-navigation. Idempotent per seq.
                }
            }
        };
        if !result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            aborted = true;
        }
        let _ = app.emit("demo://message", &result);
        results.push(result);
        // Post-click settle: navigation may follow.
        if op == "click" {
            tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        }
    }
    *REPLAY_TX.lock().unwrap() = None;
    Ok(results)
}
