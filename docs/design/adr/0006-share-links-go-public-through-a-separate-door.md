# Share links go public through a separate door, published with Tailscale Funnel

The host stays tailnet-only. Share links are the one exception, and they get their own door: a second listener in the
same process (`GANBAN_SHARE_ADDR`, off unless set) that serves only `/s/<token>` pages and downloads, with no API, no
device tokens and no app bundle. Only that listener is published to the internet, with `tailscale funnel`. TLS ends
on the host, so the files go from the host to the recipient with no third party storing or reading them. A link
names a fixed set of a task's files, chosen when it's made, so files added to the task later aren't published by
accident. Links expire (7 days by default; the creator picks 1 day to never), can be revoked, may carry a password, and
count their downloads.

## Considered options

- **Funnel the whole host:** rejected. Device tokens never expire (`docs/host/SELF_HOSTING.md`), so a stolen one would
  work from anywhere, and every API route would be on the internet.
- **Recipients join through a Tailscale device share:** rejected for this use. It's safest, but each recipient needs
  a Tailscale account to fetch one folder.
- **A file host (Google Drive and the like):** rejected. The files must not leave the host for a
  third party's storage.

## Consequences

- `docs/host/SELF_HOSTING.md`'s "never funnel" now reads "never funnel the host's main port". Funnel the share door only.
- The door must stay small: every route on it is public. Adding one is a security review, not a convenience.
- Tailscale caps Funnel's bandwidth (the figure is unpublished), so big downloads may be slower than the uplink.
- Downloads stream from disk, with HTTP Range for single files and an uncompressed zip64 built while it streams for
  "Download all", so a 1 GB+ folder needs neither a temp file nor more memory.
