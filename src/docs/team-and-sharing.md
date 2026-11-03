# Your team — people, profiles & assistants

Ganban is built around the idea that **you're not working alone**: you have
teammates (real people) and assistants (the personalities you equip) — and you
bring both onto a project deliberately.

## You, on this host — your profile

Your **profile** is who you are here: a name, an avatar, and (optionally) a PIN to
keep it yours on a shared machine. Create or edit it in **Settings → Account →
Profile**.

- A host can hold **several profiles** — handy for a shared family/office machine,
  or for keeping work and personal identities apart.
- Add **another of your own devices** and your profile carries over, so you're the
  same person on your laptop and your phone.

## Inviting people — made easy

One machine is the **host**. Bringing a teammate in is a single link, not a setup
chore:

1. The owner configures the host's networking once (Tailscale — your private
   network) in **Settings → Sync**.
2. An **invite** then does two things at once: it grants access to the project
   *and* shares the host machine over Tailscale, in one **link/QR code**. A phone
   camera can scan it to join.
3. The invitee taps **Join a project** (or opens the link), accepts the shared
   machine, and they're in — appearing as a **member** of the project.

Everything stays on your private network — Ganban is never exposed to the public
internet. (Under the hood this is a one-time device share; the credential is
owner-only and never travels in the invite.)

## One machine stays on; everyone else connects to it

The smoothest team setup is to leave **one machine always on as the host** (a Mac
Studio, a spare laptop) and have everyone — including you, on your other devices
— **connect to it** instead of each keeping a separate copy. Everyone then sees
the same shared projects, live.

- **In the desktop app:** Settings → Sync → **Run as a client of a host**, paste
  the invite link, **Connect**. You now use the full app — projects, tasks,
  files, and the assistant — against the host's data.
- **No install?** Just **open the invite link in a browser**. The host serves the
  same touch interface — perfect for a phone or a borrowed computer.

Your own private projects live on your machine regardless, so you can keep working
even when the host is asleep; connecting to a host simply adds its shared projects
alongside your own.

## Your assistants are part of the team

This is the part that makes Ganban feel like a crew, not a tool. Each project can
have **assistant personalities** — and you don't just *use* them, you **equip**
them:

- **Give them gear** — a personality answers on a model you choose (even offloaded
  to a beefier machine's GPU).
- **Teach them skills** — assign a **loadout** of tools (search the web, read a
  page, draft an email) — see *AI: tools, connectors & loadouts*.
- **Give them context** — a project's files and notes become the knowledge they're
  grounded in.

Then you hand each one the work it's suited to. The **secretary** keeps the whole
team's day straight (the rundown on Home); a research personality watches the web;
a project's own personality knows that project cold. You're the one who assembled
them — that's the point.

> Where this is heading (roadmap): a small **roster of your assistants with live
> status** in the top bar, an opt-in **onboarding** that grows how many you can
> run as you get comfortable (and as your hardware allows), and "indexing" a
> project's knowledge reframed as **training** your assistant on it.
