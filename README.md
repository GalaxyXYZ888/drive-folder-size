# Drive Folder Size (Firefox extension)

Shows recursive folder sizes inline in Google Drive's list view. The "File size"
column that normally shows nothing useful for folders gets filled in. Toggle
on/off from the toolbar icon.

The first sync reads your whole Drive once (a few minutes on a large Drive).
Every sync after that only checks what changed, so it's near-instant, and also
kicks off in the background when the browser starts, so it's usually already
done by the time you open Drive. Sizes from the last sync show up immediately
and update on their own once the check finishes.

## Install

1. Download the latest `.xpi` from the
   [Releases page](https://github.com/GalaxyXYZ888/drive-folder-size/releases/latest).
2. Open it in Firefox (click the download, or drag it into a Firefox window) and click **Add**
   when prompted.
3. The toolbar icon should appear. It's signed and permanent, nothing else to do.

## One-time setup (Google API access)

The extension talks to the Drive API directly with **your own** Google Cloud
OAuth client, so nothing routes through a third party. Click the toolbar icon,
then **Set up API access**, and follow the steps there: enable the Drive API,
configure an OAuth consent screen (with the `drive.readonly` and
`drive.appdata` scopes), create a Client ID and secret, paste both in, and
connect.

## Restoring without redoing the full sync

Reinstalling, or moving to a new computer, normally means redoing that full
sync. The setup page has two ways around it:

- **Export / Import**: save the index as a local JSON file you carry
  yourself.
- **Back up / Restore to Drive**: same snapshot, stored in a hidden folder in
  your own Drive (`drive.appdata` scope). Handy on a new computer since
  there's no file to carry over. Works right away as long as you added that
  scope during setup above.

Either way, the very next sync automatically catches up on anything that
changed since, the same as a normal incremental sync, just a bigger catch-up
if the snapshot is old. Restore and Import ask for confirmation first, since
they replace the index on this computer.

### Automatic

With the "Use the Drive backup automatically" checkbox on (the default):

- The backup refreshes itself about once a week, right after a sync, updating
  the same single file. If Drive already holds the same state, nothing is
  uploaded.
- A computer with no index yet, or one whose saved checkpoint has expired,
  restores the backup and catches up from there instead of doing a full sync.
  In every other case the backup is left alone, since a small catch-up is
  cheaper than downloading the whole thing.

"Clear cache" still forces a true full sync, and turning the checkbox off
stops both of the above. The setup page shows when the index was last updated
and when the last backup happened.

## Known limitations

- **List view only** (My Drive root and folder pages), not Grid view, Recent,
  Starred, or Shared with me.
- **Google-native files** (Docs, Sheets, Slides, Forms) don't report a byte
  size, so a folder containing them shows a slightly undercounted total.
  Shortcuts to a regular file resolve to the target's real size. Shortcuts
  to a native doc inherit the same caveat.
- **Sizes can be briefly out of date.** When you open Drive they show right
  away from the last sync, then update on their own once the background check
  finishes (usually a few seconds).
- **No background timer.** A sync runs when the browser starts and when you
  open a Drive folder (at most every 15 minutes), so a browser left open with
  Drive closed doesn't sync.
- **Reconnecting roughly weekly**, Google's hard limit for OAuth apps left
  in Testing mode. A one-click **Reconnect** appears in the toolbar popup
  when it's needed. It's never triggered without a deliberate click.

## Developing

Working on the source directly, rather than installing a release build?

1. Open Firefox, go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` from this folder.
3. It unloads on Firefox restart, and on any file change you'll need to click **Reload**
   there to pick it up.

Releases are built by zipping this folder and submitting it to
[addons.mozilla.org](https://addons.mozilla.org/developers/) as an **unlisted** add-on (free, a
few minutes, no public listing), then attaching the signed `.xpi` it gives back to a GitHub
release.

## Files

- `manifest.json`: extension manifest (MV3)
- `background.js`: OAuth (auth-code + PKCE, refresh tokens), full and incremental (`changes.list`) sync, background refresh on browser start and folder open, in-memory folder totals, portable snapshots (local export/import, Drive appDataFolder backup with weekly upload and automatic restore)
- `content.js`: injects size badges into the Drive page (stored sizes first, refreshed when the sync ends), hover-resistant, tracks Drive SPA navigation
- `popup.html`/`popup.js`: on/off toggle, live sync progress, Reconnect button, link to setup
- `options.html`/`options.js`: setup page (Client ID/secret entry, connect/test, sync now, clear cache, disconnect, export/import, Drive backup and restore, last sync and backup times)

## Version history

- **0.2 Beta**: First working version. Folder detection via the Drive API (not icon/DOM
  sniffing). Recursive size computed by walking the folder tree one API call per
  folder. Worked, but slow on wide/deep trees and fragile against Drive's React
  re-renders (badges could revert on hover).
- **0.3 Beta**: Rebuilt size computation around one full Drive file listing and
  in-memory arithmetic instead of per-folder API calls (the real fix for
  speed). Rewrote badge rendering to keep re-asserting the correct value
  instead of writing it once, fixing the hover-revert bug. Added live sync
  progress, a "Sync now" button, and a Reconnect flow that never pops an
  unrequested OAuth window.
- **0.4 Beta**: Replaced full-resync-every-time with Drive's `changes.list` API.
  The initial full listing only ever needs to happen once, and every sync
  after that fetches just what changed. Fixed a navigation bug where
  visiting Computers (or Recent/Starred) and returning to My Drive wouldn't
  refresh badges until manually re-entering the folder.
- **1.0.0**: Approved AMO first version.
- **1.1.0**: Replaced the implicit OAuth flow with authorization-code + PKCE,
  exchanged for a refresh token: reconnecting drops from roughly hourly to
  roughly weekly (the hard limit Google imposes on unverified/Testing-mode
  apps), with silent renewal in between. Requires a Client Secret now, saved
  alongside the Client ID on the setup page, see "One-time setup" above.
  Also fixed shortcuts being counted as 0-byte native docs: a shortcut to a
  regular file now contributes its target's real size to folder totals.
- **1.2.0 (Restore Improvements)**: Added a way to skip redoing the one-time
  full sync on a reinstall or a new computer: export/import the index as a
  local JSON file, or back it up to/restore it from a hidden folder in your
  own Drive (`drive.appdata` scope). See "Restoring without redoing the full
  sync" above.
- **1.2.2**: The incremental sync now also runs silently when the browser
  starts, so it's usually already caught up by the time you open Drive. The
  Drive backup also refreshes itself about once a week, right after a sync,
  replacing the previous backup file. There's a checkbox on the setup page to
  turn it off, and it shows when the last backup happened.
- **1.3.0**:
  - Folder sizes appear immediately from the last sync when you open Drive,
    then update on their own once the background check finishes, instead of
    showing nothing until it's done. This also works while signed out.
  - A new computer, or one whose saved checkpoint has expired, now restores
    the Drive backup and catches up instead of doing a full sync. "Clear cache"
    still forces a true full sync, and the Drive checkbox now covers this as
    well as the weekly upload.
  - The weekly backup skips the upload when Drive already has the same state.
  - The setup page always shows when the index was last updated (also next to
    the backup info), with sync progress on its own line instead of replacing
    it, and a restored index is labelled as restored.
  - Clear cache, Disconnect, Restore from Drive and Import now ask for
    confirmation first.
  - The Drive backup's missing-scope error now appears right away with the
    proper message, instead of a rate-limit error after a delay.
