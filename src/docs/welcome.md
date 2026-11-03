# Welcome to Ganban

Ganban is a local-first workspace — **projects, tasks, events, files, and an AI
assistant** — that runs on *your* machine (or a machine you host) and syncs to
your devices and teammates over your private network. Nothing lives on someone
else's cloud unless you put it there.

## The shape of things

- **Projects** hold your work: tasks, an area breakdown, events, comments, and
  files. Pin the ones you live in.
- **Events** are your calendar — month / week / day / agenda views, with imported
  calendars and reminders.
- **Atlas** is shared reference knowledge that any project can draw on.
- **The Assistant** is your AI: chat grounded in a project's own tasks, files, and
  notes — and, when you allow it, the web.
- **Contacts, Reports, Bin** are what they sound like.

## The assistant, in one breath

Each project can have its own **personality** (a model + a voice). Turn on
**Tools** (the 🔧 toggle) and the assistant can *look things up* — your tasks,
your files, the corpus, and any web tools you've set up — and *propose* changes
(create a task, draft an email) that **you approve** before anything happens.
Nothing the assistant does is silent: reads are shown, writes wait for you.

→ See **AI: tools, connectors & loadouts** for how to give a personality new
abilities (like reading a web page) without writing any code.

## Hosting & sharing (the short version)

One machine is the **host** — it runs the database and the AI engines. Other
devices and teammates connect to it over **Tailscale** (your private network).
You can also run the same thing headless on an always-on box (e.g. a Mac mini /
Studio) so the assistant is there even when your laptop is closed.

## Where to find settings

Everything configurable lives in **Settings** (the gear): your profile, the AI
(engines, models, personalities, loadouts, tools), sharing & devices, and this
documentation. Start with **Settings → AI** if you want to shape the assistant.
