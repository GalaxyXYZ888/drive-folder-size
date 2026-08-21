// Drive Folder Size — content script
//
// Injected on drive.google.com. Watches the file list, and for "list view"
// writes each folder's recursive size into its "File size" cell (which
// Drive otherwise leaves as "—").
//
// Two things this version specifically fixes vs. the first pass:
//
// 1. "Numbers disappear on hover." Drive is a React app; hovering a row
//    triggers Drive to re-render that row's cells (to show the Share/
//    Download/Rename icons), and React puts its own last-known value back —
//    the literal "—" — overwriting whatever we wrote. We don't track "did we
//    already handle this row" via a DOM attribute anymore (Google can wipe
//    that along with the text). Instead we keep our own results in a plain
//    JS Map (`resultsCache`, immune to Drive's re-renders) and re-assert the
//    right text into the row on every tick, however often that turns out to
//    be — cheap, since it's just a string comparison for whatever rows are
//    currently visible.
//
// 2. Folder detection is still done via the API (background script), not
//    DOM/icon sniffing — see background.js. All of a folder's children and
//    their sizes now arrive in ONE message per folder navigation (the
//    background does one full/incremental sync up front and everything
//    after that is in-memory arithmetic, so this is normally fast).
//
// 3. "Root doesn't refresh after visiting Computers." Computers, Recent,
//    Starred etc. all fell through to the same "root" key as My Drive
//    itself (both have no folder id in the URL), so bouncing through one and
//    back looked like no navigation happened at all — see computeContextKey.
//
// DOM facts this relies on (verified live on drive.google.com, Aug 2026):
//   - Each row is [role="row"][data-id="<driveFileId>"]
//   - A folder's URL is https://drive.google.com/drive/folders/<id>
//     (optionally with a /u/<n>/ segment); "My Drive" root has no id in the
//     URL and the Drive API accepts the alias "root" for it.
//   - Within a row, the "File size" cell is the <td> whose trimmed text is
//     exactly "—" for folders. We locate it once per row (by content) and
//     remember its column position, rather than re-searching by content
//     forever, since after we've written a real value there's no more "—"
//     to search for.
// If Google reshuffles the DOM, the symptom is just "no badges appear" —
// nothing breaks; see ROW_SELECTOR / findInitialSizeCellIndex below.

const ROW_SELECTOR = '[role="row"][data-id]';
const EMPTY_SIZE_TEXT = "—"; // em dash, what Drive shows for folders
const TICK_INTERVAL_MS = 500;

let currentFolderId = null; // null = My Drive root
let currentFolderKey = null;
let folderSizes = new Map(); // childFolderId -> bytes, for the CURRENT folder's children
let hasNativeDocsForCurrentFolder = false;
let contentsRequestToken = 0; // guards against a stale response applying after navigating away

const resultsCache = new Map(); // folderId -> {status:'pending'|'done'|'error', size?, hasNativeDocs?, message?}
const rowCellIndex = new WeakMap(); // row element -> td index of its size cell

function isMyDriveRootUrl() {
  return /\/drive\/my-drive/.test(location.pathname);
}

function parseFolderIdFromUrl() {
  const m = location.pathname.match(/\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null; // null => root ("My Drive") OR an unsupported page — see computeContextKey
}

function isSupportedListingUrl() {
  return isMyDriveRootUrl() || /\/drive\/(u\/\d+\/)?folders\//.test(location.pathname);
}

// A folder's id (or null for My Drive root) uniquely identifies WHAT to
// show, but "root" was also what a totally unrelated page (Computers,
// Recent, Starred — none of which match the folders/ URL pattern) collapsed
// to, since parseFolderIdFromUrl() returns null for those too. That made
// Root → Computers → Root look like "no change" to refreshFolderContext()'s
// early-exit check, so re-entering root after visiting Computers never
// re-triggered a re-scan. Give every unsupported page its own distinct key
// (its raw path) so leaving and coming back to root is always a real change.
function computeContextKey() {
  if (isMyDriveRootUrl()) return "root";
  const folderId = parseFolderIdFromUrl();
  if (folderId) return folderId;
  return `unsupported:${location.pathname}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const decimals = n < 10 && i > 0 ? 1 : 0;
  return `${n.toFixed(decimals)} ${units[i]}`;
}

function findInitialSizeCellIndex(row) {
  const tds = row.querySelectorAll("td");
  for (let i = 0; i < tds.length; i++) {
    if (tds[i].textContent.trim() === EMPTY_SIZE_TEXT) return i;
  }
  return -1;
}

function getSizeCell(row) {
  let idx = rowCellIndex.get(row);
  if (idx === undefined) {
    idx = findInitialSizeCellIndex(row);
    if (idx === -1) return null;
    rowCellIndex.set(row, idx);
  }
  const tds = row.querySelectorAll("td");
  return tds[idx] || null;
}

function displayFor(entry) {
  if (!entry || entry.status === "pending") return { text: "…", title: "Drive Folder Size: calculating…" };
  if (entry.status === "error") return { text: "?", title: `Drive Folder Size: ${entry.message}` };
  return {
    text: formatBytes(entry.size),
    title: entry.hasNativeDocs
      ? "Recursive folder size. Note: Google Docs/Sheets/Slides inside don't report a byte size, so this may undercount."
      : "Recursive folder size (Drive Folder Size)",
  };
}

function tick() {
  if (!folderSizes.size && resultsCache.size === 0) return;
  const rows = document.querySelectorAll(ROW_SELECTOR);
  for (const row of rows) {
    const id = row.getAttribute("data-id");
    if (!id || !folderSizes.has(id)) continue;

    if (!resultsCache.has(id)) {
      resultsCache.set(id, { status: "done", size: folderSizes.get(id), hasNativeDocs: hasNativeDocsForCurrentFolder });
    }

    const cell = getSizeCell(row);
    if (!cell) continue;
    const { text, title } = displayFor(resultsCache.get(id));
    if (cell.textContent !== text) cell.textContent = text;
    if (cell.title !== title) cell.title = title;
  }
}

let tickIntervalHandle = null;
function ensureTicking() {
  if (tickIntervalHandle) return;
  tickIntervalHandle = setInterval(tick, TICK_INTERVAL_MS);
}

let observer = null;
function startObserving() {
  if (observer) return;
  observer = new MutationObserver(() => tick());
  observer.observe(document.body, { childList: true, subtree: true });
}

async function refreshFolderContext() {
  const key = computeContextKey();
  if (key === currentFolderKey) return;
  currentFolderKey = key;
  currentFolderId = key === "root" ? null : parseFolderIdFromUrl();
  folderSizes = new Map();
  hasNativeDocsForCurrentFolder = false;

  if (!isSupportedListingUrl()) return;

  const enabledResp = await browser.runtime.sendMessage({ type: "GET_ENABLED" }).catch(() => null);
  if (!enabledResp || !enabledResp.enabled) return;

  const myRequestToken = ++contentsRequestToken;
  const resp = await browser.runtime
    .sendMessage({ type: "GET_FOLDER_CONTENTS", folderId: currentFolderId })
    .catch(() => null);

  // Bail if the user navigated again while this was in flight (this can take
  // a while on the very first sync of a big Drive).
  if (myRequestToken !== contentsRequestToken) return;

  if (!resp || !resp.ok) return;

  hasNativeDocsForCurrentFolder = !!resp.hasNativeDocs;
  folderSizes = new Map(Object.entries(resp.sizes || {}));
  for (const [id, size] of folderSizes) {
    resultsCache.set(id, { status: "done", size, hasNativeDocs: hasNativeDocsForCurrentFolder });
  }
  ensureTicking();
  tick();
}

function watchForNavigation() {
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      refreshFolderContext();
    }
  }, 600);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  if (changes.enabled.newValue) {
    currentFolderKey = null;
    refreshFolderContext();
  }
});

function init() {
  startObserving();
  ensureTicking();
  watchForNavigation();
  refreshFolderContext();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
