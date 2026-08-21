# Drive Folder Size (Firefox extension)

Shows recursive folder sizes inline in Google Drive's list view — the "File size"
column that normally just shows "—" for folders gets filled in. Toggle on/off
from the toolbar icon.

**How it computes sizes (v0.2):** the first time it needs folder sizes, it
fetches your entire My Drive file list once (paginated — every file's id,
size, mimeType and parent folder), then computes every folder's recursive
size as plain in-memory arithmetic over that list: for each file, walk up its
parent chain and add its size to every ancestor folder. No per-folder API
calls, no waiting on deep/wide trees — one sync, then it's all just math,
cached for 24h. Use "Sync now" on the setup page to refresh early after big
uploads/deletes.

## Install (unpacked / temporary)

1. Open Firefox, go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` from this folder.
3. The toolbar icon (folder + green "B" badge) should appear.

Note: a temporary add-on unloads when Firefox restarts. To make it stick, see
"Making it permanent" below.

## One-time setup (Google API access)

The extension talks to the Drive API directly with **your own** Google Cloud
OAuth client — nothing routes through a third party. Click the toolbar icon →
**Set up API access** and follow the steps on that page:

1. Enable the Drive API in Google Cloud Console.
2. Configure the OAuth consent screen (External, add the
   `drive.readonly` scope, add yourself as a test user, leave it in
   **Testing** mode — this skips Google's verification review entirely since
   it's just for your own account).
3. Create an OAuth Client ID (type: **Web application**), and add the redirect
   URI shown on the setup page to "Authorized redirect URIs".
4. Paste the Client ID into the setup page, click **Connect & test**.
5. Flip the toggle on in the popup.

Full step-by-step with links is on the in-extension setup page (`options.html`).

## Known limitations

- **List view only** (My Drive root + folder pages). Grid view, Recent,
  Starred, and Shared-with-me use different layouts and aren't handled.
- **Google-native files** (Docs, Sheets, Slides, Forms) don't report a byte
  size via the API, so a folder containing them will show a slightly
  undercounted total. Hover a size badge — it says so when this applies.
- **Tokens expire roughly hourly.** Silent refresh is attempted automatically;
  if it fails (Firefox's auth flow doesn't always have your Google session
  available) badges will show "?" and the toolbar popup will show a one-click
  **Reconnect** button. Content-script-triggered code never pops an
  interactive sign-in window on its own (unrequested popups get blocked
  anyway, and it'd be a bad surprise) — reconnecting is always a deliberate
  click.
- **DOM selectors are best-effort.** Google ships Drive updates that rename
  internal (minified) CSS classes fairly often. This extension deliberately
  avoids depending on those — it identifies folders via the Drive API, not
  icon classes — and finds the "File size" `<td>` by content (the "—") once
  per row, then keeps writing to that same column position even after Drive
  re-renders the row (e.g. on hover, which otherwise reverts our text — this
  is checked/repaired continuously, not just once). If badges stop appearing
  at all, the fix is almost always in `content.js`'s `ROW_SELECTOR` /
  `findInitialSizeCellIndex`.

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
- `background.js` — OAuth, the one full-Drive sync, in-memory folder totals
- `content.js` — injects size badges into the Drive page, hover-resistant
- `popup.html`/`popup.js` — on/off toggle, Reconnect button, link to setup
- `options.html`/`options.js` — setup page (Client ID entry, connect/test, sync now, disconnect)
