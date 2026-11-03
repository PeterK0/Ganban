# Tutorial: your first tab

This builds a **Hello** tab in two parts:

1. **Tier 1:** a panel with a greeting and a **Wave** button that counts your waves. The count is saved on the
   host, so it follows you to your other devices.
2. **Tier 2:** two tools for the AI assistant. One reads the project's name; the other proposes a new greeting,
   which changes nothing until you approve it.

Every step below was run on a real checkout. [TAB_SPEC.md](TAB_SPEC.md) is the reference behind it: read it when you
want the why.

**Before you start:** a checkout that builds the server ([BUILDING.md](BUILDING.md)): Node, Rust and `npm ci`. You'll
test in your browser on a throwaway host, so the desktop app's own build setup isn't needed.

## Part 1: a panel (Tier 1)

### Step 1: the feature flag

In `crates/server/Cargo.toml`, under `[features]`, add the flag and put it in `default` so it's built in:

```toml
default = ["tab-nato", "tab-pdf", "tab-email", "tab-atlas", "tab-kanban", "tab-models", "tab-quiz", "tab-hello"]
# …
tab-hello = []
```

### Step 2: the descriptor

In `crates/server/src/tabs.rs`, at the end of `available_tabs()`, just before `tabs` is returned:

```rust
    #[cfg(feature = "tab-hello")]
    tabs.push(TabDescriptor {
        id: "hello",
        name: "Hello",
        icon: "👋",
        tier: 1,
        description: "Say hello and count your waves (a tutorial tab; panel-only).",
        has_tools: false,
    });
```

The `id` is the tab's key everywhere: in the registry, in the routes and in the database. The emoji `icon` is only
for older clients; you pick the real icon in step 4.

### Step 3: the panel

Create `src/tabs/HelloTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import ScrollArea from "../components/ScrollArea";
import { DecoHeading } from "../components/gilt";
import { getTabUserState, setTabUserState } from "../lib/daemon";
import { useDataPulse } from "../lib/livePulse";
import type { TabPanelProps } from "./registry";

type HelloState = { greeting?: string; waves?: number };

export default function HelloTab({ projectId }: TabPanelProps) {
  const [state, setState] = useState<HelloState>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getTabUserState(projectId, "hello")
      .then((s) => setState(s as HelloState))
      .catch((e) => setError(String(e)));
  }, [projectId]);
  useEffect(load, [load]);
  // An approved assistant write lands as an "entities" pulse: reload then (Part 2).
  useDataPulse(load, ["entities"]);

  const wave = async () => {
    const next = { ...state, waves: (state.waves ?? 0) + 1 };
    setState(next);
    try {
      await setTabUserState(projectId, "hello", next);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <ScrollArea className="flex-1 bg-mantle" contentClassName="p-6 space-y-4">
      <div className="g-deco text-[11px] text-[color:var(--g-mut)]">A tutorial tab</div>
      <h1 className="g-ptitle">Hello</h1>
      <div className="g-card g-corners p-6 space-y-4 g-read">
        <DecoHeading>{state.greeting ?? "Hello, world"}</DecoHeading>
        <p className="text-text">You have waved {state.waves ?? 0} times.</p>
        <button className="g-btn g-btn-pri" onClick={wave}>
          Wave
        </button>
        {error && <p className="text-error text-sm">{error}</p>}
      </div>
    </ScrollArea>
  );
}
```

What it uses:

- `TabPanelProps` is the whole contract: the panel gets `projectId`.
- `getTabUserState` and `setTabUserState` keep the caller's own JSON on the host, per project and per tab.
- The page sits in a `ScrollArea`, with Gilt's classes for the look ([GILT.md](GILT.md)).

### Step 4: register the panel

In `src/tabs/registry.tsx`, add the panel to `TAB_PANELS` and an icon to `TAB_ICONS`:

```tsx
export const TAB_PANELS: Record<string, LazyExoticComponent<ComponentType<TabPanelProps>>> = {
  // …the other tabs
  hello: lazy(() => import("./HelloTab")),
};

export const TAB_ICONS: Record<string, TabIconName> = {
  // …the other tabs
  hello: "comments",
};
```

The icon is a name from `ICONS` in `src/components/icons/TabIcon.tsx`. To draw your own, add an entry there in the
same style.

### Step 5: build and try it

```bash
npx tsc --noEmit -p .
scripts/qa-host.sh 8823 --build
```

`qa-host.sh` rebuilds the server and the web UI, then serves them on a throwaway database with sample projects
([TESTING.md § QA host](TESTING.md#qa-host)). Use any free port. Leave it running, and open
`http://127.0.0.1:8823/`.

1. Open a project: click it in the sidebar, then **Open project →**.
2. Press **＋** at the right end of the project's tab bar. "Tabs for this project" lists every tab the host was built
   with.
3. Tick **Hello**. The tab appears in the bar. Open it and press **Wave** a few times.

Check it from the host's side (project 4 is "Autumn Reading" in the sample data):

```bash
curl -s http://127.0.0.1:8823/projects/4/tabs/hello/state
# {"waves":2}
```

Switch to Catppuccin Latte in Settings → Design and look again: Gilt's classes take the light theme with no extra work.

That's a complete Tier-1 tab. Stop the host with Ctrl-C.

## Part 2: tools for the assistant (Tier 2)

Now the assistant gets two tools:

- `hello_get_project`, a **read**: it returns the project's name and runs as soon as the model calls it;
- `hello_set_greeting`, a **write**: it proposes a new greeting for the panel, and nothing changes until the user
  approves.

### Step 6: the tool module

In `crates/server/src/tabs.rs`, add a module next to the PDF one:

```rust
#[cfg(feature = "tab-hello")]
pub mod hello {
    use super::*;

    pub fn tool_defs() -> Vec<Value> {
        vec![
            json!({ "type": "function", "function": {
                "name": "hello_get_project",
                "description": "Get this project's name, to greet it.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }}),
            json!({ "type": "function", "function": {
                "name": "hello_set_greeting",
                "description": "Propose a new greeting for the user's Hello tab. The user must approve it.",
                "parameters": {
                    "type": "object",
                    "properties": { "greeting": { "type": "string", "description": "The greeting, at most 80 characters." } },
                    "required": ["greeting"]
                }
            }}),
        ]
    }

    pub async fn get_project(db: &Db, project_id: i64) -> Result<String, String> {
        let name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id = ?")
            .bind(project_id)
            .fetch_one(db)
            .await
            .map_err(|e| e.to_string())?;
        Ok(json!({ "name": name }).to_string())
    }

    pub fn prepare_set_greeting(user_id: i64, project_id: i64, args: &Value) -> Result<PreparedWrite, String> {
        let greeting = args.get("greeting").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if greeting.is_empty() || greeting.chars().count() > 80 {
            return Err("greeting must be 1 to 80 characters".into());
        }
        Ok(PreparedWrite {
            command: "hello_set_greeting",
            args: json!({ "project_id": project_id, "user_id": user_id, "greeting": greeting }),
            summary: format!("Set your Hello greeting to \"{greeting}\""),
            details: json!({ "after": { "greeting": greeting } }),
        })
    }

    pub async fn apply(db: &Db, args: &Value) -> Result<Value, AppError> {
        let bad = || AppError::InvalidInput("bad hello_set_greeting args".into());
        let project_id = args.get("project_id").and_then(Value::as_i64).ok_or_else(bad)?;
        let user_id = args.get("user_id").and_then(Value::as_i64).ok_or_else(bad)?;
        let greeting = args.get("greeting").and_then(Value::as_str).ok_or_else(bad)?;
        // Merge into the user's state so the wave count survives.
        let raw = ops::tab_user_state(db, project_id, "hello", user_id).await?;
        let mut state: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
        if !state.is_object() {
            state = json!({});
        }
        state["greeting"] = json!(greeting);
        ops::set_tab_user_state(db, project_id, "hello", user_id, &state.to_string()).await?;
        Ok(json!({ "greeting": greeting }))
    }
}
```

Three things to notice:

- `prepare_set_greeting` only checks and describes. `summary` is the line the user approves; `details` feeds the
  before-and-after view in Activity.
- The project id in `args` comes from the server, never from the model.
- The write changes the proposer's own tab state, something they could do from the panel anyway. Proposals are
  approved by the member who asked, so a tool must never write what that member couldn't (TAB_SPEC § Tier 2).

### Step 7: the five dispatch points

Still in `tabs.rs`, add a branch for Hello to each of the five functions the chat loop calls. Put each one after the
Email branch, just before the function's `let _ = …;` line.

```rust
// 1. tool_defs_for: offer the tools only where the tab is on
    #[cfg(feature = "tab-hello")]
    if enabled.iter().any(|t| t == "hello") {
        defs.extend(hello::tool_defs());
    }

// 2a. is_tab_read_tool
    #[cfg(feature = "tab-hello")]
    if name == "hello_get_project" {
        return true;
    }

// 2b. is_tab_write_tool
    #[cfg(feature = "tab-hello")]
    if name == "hello_set_greeting" {
        return true;
    }

// 3. execute_read: check the tab is on, then read
    #[cfg(feature = "tab-hello")]
    if name == "hello_get_project" {
        require_enabled(db, project_id, "hello").await?;
        return hello::get_project(db, project_id).await;
    }

// 4. prepare_write: check the tab is on, then build the proposal
    #[cfg(feature = "tab-hello")]
    if name == "hello_set_greeting" {
        require_enabled(db, project_id, "hello").await?;
        return hello::prepare_set_greeting(user_id, project_id, args);
    }

// 5. apply: runs only after the user approved
    #[cfg(feature = "tab-hello")]
    if command == "hello_set_greeting" {
        return hello::apply(db, args).await;
    }
```

Then edit the descriptor from step 2 to mark the tab as Tier 2:

```rust
        tier: 2,
        description: "Say hello and count your waves (a tutorial tab). Adds gated agent tools.",
        has_tools: true,
```

The panel needs no change: it already reloads on the `entities` pulse an approved write sends.

### Step 8: a test

At the end of `tabs.rs`, add a test that walks the gate:

```rust
#[cfg(all(test, feature = "tab-hello"))]
mod hello_tests {
    use super::*;

    #[tokio::test]
    async fn hello_tools_follow_enablement_and_the_gate() {
        let path = std::env::temp_dir().join(format!("ganban_tabs_hello_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = ganban_core::init_db(&path).await.unwrap();
        let p = crate::dispatch(&db, "create_project", &json!({ "input": { "name": "Garden" } })).await.unwrap()["id"]
            .as_i64()
            .unwrap();

        // Off for the project: no tools offered, and a call is refused anyway.
        assert!(tool_defs_for(&[]).iter().all(|d| d["function"]["name"] != "hello_get_project"));
        assert!(execute_read(&db, p, "hello_get_project", &json!({})).await.is_err());
        assert!(prepare_write(&db, 1, p, "hello_set_greeting", &json!({ "greeting": "Hi" })).await.is_err());

        ops::set_project_tab(&db, p, "hello", true).await.unwrap();
        assert_eq!(tool_defs_for(&["hello".into()]).len(), 2);
        assert!(execute_read(&db, p, "hello_get_project", &json!({})).await.unwrap().contains("Garden"));

        // The write is a proposal first; nothing changes until apply.
        let pw = prepare_write(&db, 1, p, "hello_set_greeting", &json!({ "greeting": "Hello, Garden" })).await.unwrap();
        assert_eq!(ops::tab_user_state(&db, p, "hello", 1).await.unwrap(), "{}");
        apply(&db, Path::new("/nonexistent"), pw.command, &pw.args).await.unwrap();
        let state: Value = serde_json::from_str(&ops::tab_user_state(&db, p, "hello", 1).await.unwrap()).unwrap();
        assert_eq!(state["greeting"], "Hello, Garden");
        assert!(prepare_write(&db, 1, p, "hello_set_greeting", &json!({ "greeting": "" })).await.is_err());
    }
}
```

Run it, then the whole server suite to be sure nothing else noticed:

```bash
cargo test -p ganban-server hello_tools
cargo test -p ganban-server
```

### Step 9: try it

```bash
scripts/qa-host.sh 8823 --build
```

The database is a fresh copy, so turn the tab on again, with **＋** or from a terminal (a caller on the same machine
is the host's owner, so no sign-in is needed):

```bash
curl -s -X PUT http://127.0.0.1:8823/projects/4/tabs -H 'content-type: application/json' \
  -d '{"tab_id":"hello","enabled":true}'
curl -s http://127.0.0.1:8823/tools/catalog
```

The catalog now lists `hello_get_project` (class `read`) and `hello_set_greeting` (class `write`, gated), both with
the source `tab:hello`. The ＋ popover shows an "agent tools" badge next to Hello.

To see the whole loop, you need a model that can call tools: set one up in Ollama and pick it in Settings → Models
([SELF_HOSTING.md § Part 3](../host/SELF_HOSTING.md#part-3-set-up-the-ai-settings)). Then, in the project's
Chats tab, turn on tools under the message box and ask: *"Set my Hello greeting to something about this project."*
The model reads the name with `hello_get_project` and proposes `hello_set_greeting`. A proposal card appears;
press **Approve**, and the Hello tab shows the new greeting. The proposal also appears in Activity, and the approval
lands in the action ledger.

## Where to go next

- Keep the tab out of a build by dropping `tab-hello` from `default`. The server, the panel registry and the client
  stay consistent: a tab the host doesn't report never shows.
- Shared data for the whole project: `getProjectTabConfig` and `setProjectTabConfig` (admins write). A leaderboard:
  `listTabScores` and `postTabScore`. Both are in [TAB_SPEC.md § The panel contract](TAB_SPEC.md#the-panel-contract).
- Before you open a pull request, go through [TAB_SPEC.md § Rules for the panel](TAB_SPEC.md#rules-for-the-panel)
  and its review checklist, and [CONTRIBUTING.md](../../CONTRIBUTING.md).
