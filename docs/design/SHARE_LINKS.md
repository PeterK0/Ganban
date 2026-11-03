# Share links: the brief

A **share link** gives someone outside the team a task's or a project's files over the internet: no account, an expiry, optionally a
password. The design and its reasons are in ADR 0006; the terms are in `GLOSSARY.md` ("Share link", "Share door").
The first use case is a folder of 1 GB or more attached to a task.

## The decisions (2026-11-02)

- **Reach:** a separate **share door** (a second listener) published with `tailscale funnel`. The main port stays
  tailnet-only.
- **Getting files on:** upload from the app, streamed, keeping the folder structure. The project's storage quota is
  raised as needed; the setting exists.
- **Link rules:** the expiry defaults to 7 days, and the creator picks 1, 7 or 30 days, or never. Links are
  revocable, may carry a password, and show their download count and last download.
- **What the recipient sees:** a small page with the file list, **Download all (.zip)** and per-file downloads. Both
  resume after a drop (HTTP Range).

## The interface (fixed, so the two lanes can run in parallel)

### Configuration (host, environment)

- `GANBAN_SHARE_ADDR`: the share door's listen address, for example `127.0.0.1:8770`. Unset means no door; links
  can still be made, but they have no public URL.
- `GANBAN_SHARE_URL`: the public base URL, for example `https://<machine>.<tailnet>.ts.net`, with no trailing
  slash.

### Commands (the command table, ADR 0001)

| Command | Arguments | Returns | Who |
|---|---|---|---|
| `create_share_link` | `taskId` (from a task's Files tab) or `projectId` (from Project > Files); `attachmentIds?` (task attachments: the task's own with `taskId`, any of the project's tasks' with `projectId`); `projectFileIds?` (the project's own files); with both lists left out, every host-stored file of the task, or every one of the project's own files; `label?` (default: the task's or project's title, or the folder's name when every file shares one top folder), `expiresInDays?` (number, or `null` for never; default 7), `password?` | `ShareLink` | project admins and the owner, who must see the task and every task whose file it takes (ADR 0002; refused as "not found") |
| `list_share_links` | `taskId` or `projectId` | `ShareLink[]`, newest first, revoked and expired included. A project's list has every link made from it or from its tasks, less those of tasks the caller can't see | same |
| `revoke_share_link` | `linkId` | `ShareLink` | same |
| `get_share_door` | none | `{ enabled: boolean, publicUrl: string \| null }` | any member |

`ShareLink` (JSON, camelCase):
```
{ id, taskId /* the task it was made from, or null from Project > Files */, projectId, label, url /* publicUrl + "/s/" + token, or null without GANBAN_SHARE_URL */, path /* "/s/<token>" */,
  status /* "preparing" | "active" | "expired" | "revoked" */, expiresAt /* ISO or null */, hasPassword,
  fileCount, totalBytes, downloadCount, lastDownloadAt /* ISO or null */, revokedAt, createdBy, createdAt }
```

In a link made from Project > Files, a task's file sits under a folder named after its task (`<task title>/<its
folder path>`); the project's own files keep their folder paths. `share_link_files` records each file's kind
(`attachment`, blob `<storage>/<id>`, or `project`, blob `<storage>/pf/<id>`).

Files that exist only on a member's device, not on the host, can't be shared. `create_share_link` rejects them with
a message naming how many there are, and the UI says to upload them first.

### The share door's routes (the only public surface)

- `GET /s/:token`: the page. It's server-rendered HTML with inline CSS in Gilt's Mocha palette, readable on a phone.
  It shows the label, the file list (folder path, name, size), the total, the expiry, **Download all (.zip)** and a
  link per file. A password-protected link shows a password form first.
- `POST /s/:token/unlock`: checks the password and sets a cookie scoped to `/s/<token>` (HttpOnly, Secure,
  SameSite=Lax), then redirects to the page.
- `GET /s/:token/f/:n`: file `n` of the link. It streams from disk with `Accept-Ranges`, `206` and `416`, and sends
  `Content-Length`, `ETag`, `Last-Modified` and `Content-Disposition: attachment` (with RFC 5987 `filename*`).
- `GET /s/:token/zip`: every file of the link as one zip that is **deterministic**:
  - files are stored, not compressed; their CRC-32s are computed once when the link is made (the link is
    `preparing` until then, a few seconds per GB);
  - folder paths are kept;
  - zip64 records appear only where needed (a file or offset of 4 GB or more), because macOS's Archive Utility is
    fussy with needless zip64;
  - there are no data descriptors;
  - an exact `Content-Length`, `ETag` and **Range support**, so a dropped 1 GB download resumes;
  - it never writes a temp file, and memory stays flat.
- **A link that's unknown, expired or revoked** gets the same "This link isn't available" page with a 404. A wrong
  password gets a 401 and the form again.
- **Bad tokens and wrong passwords are rate-limited** per client address (Funnel passes it in `X-Forwarded-For`;
  otherwise use the peer address) and globally.
- **Headers:** `Referrer-Policy: no-referrer`; a CSP of `default-src 'none'; style-src 'unsafe-inline'; img-src
  data:; form-action 'self'; frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; `Cache-Control: no-store`
  on pages.
- Each download counts once (a `206` that continues one doesn't count again) and updates `lastDownloadAt`. The
  host log records what was downloaded and from where.
- Nothing else answers on the door: anything else is a bare 404. The door shares the database and the storage
  root with the main listener, and nothing more.

### What the host's owner runs (step by step in `docs/host/SELF_HOSTING.md`)

1. Set `GANBAN_SHARE_ADDR=127.0.0.1:8770` and `GANBAN_SHARE_URL=https://<machine>.<tailnet>.ts.net` for the host
   service (`ops/install.sh` learns both).
2. Turn on HTTPS and Funnel for the tailnet: the admin console, plus a `funnel` node attribute in the policy.
3. Run `tailscale funnel --bg 8770`, which publishes 443 to the door only.
