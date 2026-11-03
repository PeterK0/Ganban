# AI: tools, connectors & loadouts

This is how you shape what the assistant can *do* — and how to give a
personality new abilities **as configuration, not code**.

## The three layers

- **Personality** — a model + a system prompt + a voice. Each project can have
  one; you can @mention others. (Settings → AI → Personalities.)
- **Tool** — one thing the assistant can do: read your tasks, search the corpus,
  search the web, read a page. Reads run immediately (scoped to the current
  project); **writes only ever create proposals you approve.**
- **Loadout** — a named bundle of tools (plus an optional instruction and an
  optional faster "tool-runner" model) that you assign to a personality. Think of
  it as a character sheet: a personality with no loadout can use every tool; with
  loadouts, it's focused on just those.

> Tools are the *vocabulary*; a loadout is the *kit* you hand one personality.

## Seeing what's available

**Settings → AI → Tools** lists every tool the assistant can use, grouped by
read / write, with where each comes from. Owners also see the knowledge engine
(ragrat) and the tools it exposes. The header shows which host you're connected
to and its version — handy when something seems out of date.

## Giving the assistant the web (owner-only)

Web abilities are **custom tools** you define in **Settings → AI → Tools → New
tool**. They're owner-only, the results are treated as untrusted, and outbound
requests are guarded against reaching private/internal addresses.

Three useful shapes:

- **`web_search`** — a search API (e.g. Brave). Binding **http**, your API key
  stored as a *connector secret*. Good for *finding* things.
- **`web_fetch`** — fetch a page by URL and return its text. Binding **fetch**.
  Cheap; great for static pages and simple sites. (No JavaScript rendering.)
- **`read_page`** — render a JavaScript-heavy page into clean text via a service
  like **Firecrawl**. Binding **http**, `POST`, your Firecrawl key as a secret.
  Use when `web_fetch` comes back empty.

### Connector secrets

API keys live under **Tools → Connector secrets**: you add them by name, and a
tool references the name. The value is stored on the host only, is **never shown
again**, and never leaves with sync — the assistant uses it but never sees it.

### A loadout to tie it together

Create a **"Web research"** loadout (Settings → AI → Loadouts) with
`web_search`, `web_fetch`, and `read_page`, an instruction like *"To read a page,
try web_fetch first; if it's JS-heavy or returns little, use read_page; use
web_search to find URLs and always cite them,"* and assign it to a personality.
Now that personality researches the web and cites sources.

## A note on trust

Everything the assistant fetches from outside — search results, web pages, email
— is treated as **untrusted**: it can inform an answer but can never, by itself,
cause a change. Every change is a proposal you approve. That boundary is the
whole point, and it doesn't move.
