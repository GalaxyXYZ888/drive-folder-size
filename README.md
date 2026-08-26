# Drive Folder Size (Firefox extension)

Shows recursive folder sizes inline in Google Drive's list view — the "File size"
column that normally just shows "—" for folders gets filled in. Toggle on/off
from the toolbar icon.

The first sync reads your whole Drive once (the slow part — a few minutes on
a large Drive). Every sync after that only checks what changed, so it's
near-instant.

## Install (unpacked / temporary)

1. Open Firefox, go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` from this folder.
3. The toolbar icon (folder + green "B" badge) should appear.

Note: a temporary add-on unloads when Firefox restarts. To make it stick, see
"Making it permanent" below.

## One-time setup (Google API access)

The extension talks to the Drive API directly with **your own** Google Cloud
OAuth client — nothing routes through a third party. Click the toolbar icon →
**Set up API access** and follow the steps there: enable the Drive API,
configure an OAuth consent screen, create a Client ID + secret, paste both
in, and connect. Takes about 5 minutes.

## Restoring without redoing the full sync

Reinstalling, or moving to a new computer, normally means redoing that full
sync. Two ways around it, both on the setup page:

- **Export / Import**: save the index as a local JSON file you carry
  yourself.
- **Back up / Restore to Drive**: same snapshot, stored in a hidden folder in
  your own Drive — handy on a new computer since there's no file to carry
  over (needs one extra one-time consent step, explained on the setup page).

Either way, the very next sync automatically catches up on anything that
changed since — same as a normal incremental sync, just a bigger catch-up if
the snapshot is old.

## Known limitations

- **List view only** (My Drive root + folder pages) — not Grid view, Recent,
  Starred, or Shared with me.
- **Google-native files** (Docs, Sheets, Slides, Forms) don't report a byte
  size, so a folder containing them shows a slightly undercounted total —
  hover a badge to check. Shortcuts to a regular file resolve to the
  target's real size; shortcuts to a native doc inherit the same caveat.
- **Reconnecting roughly weekly** — Google's hard limit for OAuth apps left
  in Testing mode. A one-click **Reconnect** appears in the toolbar popup
  when it's needed; it's never triggered without a deliberate click.

## Making it permanent

Temporary add-ons disappear on Firefox restart. Options, cheapest first:

- **Firefox Developer Edition or Nightly**: set `xpinstall.signatures.required`
  to `false` in `about:config`, then install the zipped extension normally —
  it'll persist across restarts without needing to be signed.
- **Self-distribute a signed build**: zip this folder's contents and submit it
  to [addons.mozilla.org](https://addons.mozilla.org/developers/) as an
  **unlisted** add-on (free, a few minutes, no public listing, no manual
  review queue for unlisted). Download the signed `.xpi` it gives you back and
  install that in regular Firefox — it'll survive restarts.

## Files

- `manifest.json` — extension manifest (MV3)
- `background.js` — OAuth (auth-code + PKCE, refresh tokens), full + incremental (`changes.list`) sync, in-memory folder totals, portable snapshots (local export/import + Drive appDataFolder backup)
- `content.js` — injects size badges into the Drive page, hover-resistant, tracks Drive SPA navigation
- `popup.html`/`popup.js` — on/off toggle, live sync progress, Reconnect button, link to setup
- `options.html`/`options.js` — setup page (Client ID/secret entry, connect/test, sync now, disconnect, restore)

## Version history

- **0.2** — First working version. Folder detection via the Drive API (not icon/DOM
  sniffing); recursive size computed by walking the folder tree one API call per
  folder. Worked, but slow on wide/deep trees and fragile against Drive's React
  re-renders (badges could revert on hover).
- **0.3** — Rebuilt size computation around one full Drive file listing +
  in-memory arithmetic instead of per-folder API calls (the real fix for
  speed). Rewrote badge rendering to keep re-asserting the correct value
  instead of writing it once, fixing the hover-revert bug. Added live sync
  progress, a "Sync now" button, and a Reconnect flow that never pops an
  unrequested OAuth window.
- **0.4** — Replaced full-resync-every-time with Drive's `changes.list` API:
  the initial full listing only ever needs to happen once, and every sync
  after that fetches just what changed. Fixed a navigation bug where
  visiting Computers (or Recent/Starred) and returning to My Drive wouldn't
  refresh badges until manually re-entering the folder.
- **1.0** — Approved AMO first version.
- **1.1** — Replaced the implicit OAuth flow with authorization-code + PKCE,
  exchanged for a refresh token: reconnecting drops from roughly hourly to
  roughly weekly (the hard limit Google imposes on unverified/Testing-mode
  apps), with silent renewal in between. Requires a Client Secret now, saved
  alongside the Client ID on the setup page — see "One-time setup" above.
  Also fixed shortcuts being counted as 0-byte native docs: a shortcut to a
  regular file now contributes its target's real size to folder totals.
- **1.2 (Restore Improvements)** — Added a way to skip redoing the one-time
  full sync on a reinstall or a new computer: export/import the index as a
  local JSON file, or back it up to/restore it from a hidden folder in your
  own Drive (`drive.appdata` scope). See "Restoring without redoing the full
  sync" above.
