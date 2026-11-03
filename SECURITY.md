# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

1. Open the repository on GitHub, go to the **Security** tab and choose **Report a vulnerability**. This opens a
   private advisory that only the maintainers can see.
2. Describe the problem, how to reproduce it, the version (Settings → Updates shows it) and what an attacker could
   do with it. A proof of concept helps.

You'll get a reply in the advisory. Once a fix is out, the advisory is published with credit to you, unless you'd
rather stay anonymous.

## What counts

Ganban keeps private data: tasks, files, mail linked to projects, chats with the assistant. Examples of what we want
to hear about:

- a member reaching another project's data, or a task hidden from them (task visibility);
- a paired device, a share link or an invite getting more access than it was given;
- the AI assistant changing data without the user's approval, or being steered by text in a file, an email or a web
  page into leaking data;
- a way in from the network to a host that wasn't paired;
- secrets (API keys, passwords, tokens) reaching a client, a log or a member.

The trust model, its invariants and the tests that hold them are in
[docs/design/SECURITY_MODEL.md](docs/design/SECURITY_MODEL.md).

## Supported versions

Fixes go into the latest release. Hosts update with `ops/update.sh` or from Settings → Updates, and apps update from
their host ([docs/host/SELF_HOSTING.md](docs/host/SELF_HOSTING.md)).
