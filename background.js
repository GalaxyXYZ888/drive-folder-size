// Drive Folder Size — background script
//
// Architecture (v0.3): a folder's recursive size is computed as plain
// in-memory arithmetic over a locally-held copy of every file's
// id/size/mimeType/parents — walk each file's parent chain, add its size to
// every ancestor. No per-folder network calls, ever.
//
// Getting that local copy has two paths:
//   - FULL sync (v0.2): fetch every file, paginated at 1000/page. For a
//     Drive with hundreds of thousands of files this is inherently a lot of
//     sequential round-trips — Drive's pagination requires each page's token
//     before the next page can be requested, so this can't be parallelized
//     away, and it's close to a hard floor imposed by the API itself.
//   - INCREMENTAL sync (v0.3, new): after any full sync, we hold onto a
//     Drive "changes" API checkpoint token. Every sync after that calls
//     changes.list with that token and gets back only what's actually
//     different since last time (usually a handful of files, one request) —
//     this is the same mechanism Google's own Drive desktop client uses to
//     avoid re-scanning everything on every refresh. A full resync only
//     happens once (first install) or if Google invalidates an old
//     checkpoint token (rare; we detect it and fall back automatically).
//
// Responsibilities:
//  - OAuth (implicit flow via browser.identity.launchWebAuthFlow, no client secret needed)
//  - The full/incremental sync + in-memory folder-size computation
//  - Answering messages from content.js / popup.js / options.js

const SYNC_CHECK_INTERVAL_MS = 15 * 60 * 1000; // don't even check for changes more often than this
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT_KEY = "root"; // our internal alias for "My Drive" itself

let fullSyncInFlight = null;

browser.runtime.onInstalled.addListener(async () => {
  const { enabled } = await browser.storage.local.get("enabled");
  if (enabled === undefined) {
    // Off by default until the user has set up a Client ID and flips the
    // popup toggle — avoids error badges everywhere on first install.
    await browser.storage.local.set({ enabled: false });
  }
});

// ---------- storage helpers ----------

async function getSetting(key) {
  const result = await browser.storage.local.get(key);
  return result[key];
}

async function setSetting(key, value) {
  await browser.storage.local.set({ [key]: value });
}

// ---------- auth ----------

async function getClientId() {
  const clientId = await getSetting("clientId");
  if (!clientId) throw new Error("NO_CLIENT_ID");
  return clientId;
}

async function getToken(interactive) {
  const stored = await browser.storage.local.get(["authToken", "authTokenExpiry"]);
  if (stored.authToken && stored.authTokenExpiry && Date.now() < stored.authTokenExpiry) {
    return stored.authToken;
  }

  const clientId = await getClientId();
  const redirectUri = browser.identity.getRedirectURL();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("scope", DRIVE_SCOPE);
  authUrl.searchParams.set("prompt", interactive ? "consent" : "none");

  let redirectResult;
  try {
    redirectResult = await browser.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: !!interactive,
    });
  } catch (err) {
    throw new Error(interactive ? "AUTH_FAILED" : "SILENT_AUTH_FAILED");
  }

  const hash = new URL(redirectResult).hash.slice(1);
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");
  const expiresIn = parseInt(params.get("expires_in") || "3600", 10);
  if (!token) throw new Error("NO_TOKEN_IN_RESPONSE");

  await browser.storage.local.set({
    authToken: token,
    authTokenExpiry: Date.now() + expiresIn * 1000 - 60000, // refresh a minute early
  });
  return token;
}

async function clearToken() {
  await browser.storage.local.remove(["authToken", "authTokenExpiry"]);
}

// Content-script-triggered calls have no user gesture behind them, so they
// must NEVER fall back to an interactive OAuth popup (browsers block or
// misbehave on popups not tied to a click, and it'd be a confusing surprise
// popup anyway). Silent-only; caller gets a clear AUTH_REQUIRED error and the
// popup/options page is where the user explicitly reconnects.
async function getSilentToken() {
  try {
    return await getToken(false);
  } catch (e) {
    throw new Error("AUTH_REQUIRED");
  }
}

// ---------- throttled Drive API fetch ----------

// A global cap on actual concurrent HTTP requests to the Drive API.
const MAX_CONCURRENT_FETCHES = 6;
let activeFetches = 0;
const fetchQueue = [];

function runFetchQueue() {
  while (activeFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length) {
    const job = fetchQueue.shift();
    activeFetches++;
    job().finally(() => {
      activeFetches--;
      runFetchQueue();
    });
  }
}

function throttled(task) {
  return new Promise((resolve, reject) => {
    fetchQueue.push(() => task().then(resolve, reject));
    runFetchQueue();
  });
}

// Visible while a sync is running — polled by popup.js/options.js so "is
// this actually working or just stuck?" has a real answer instead of a
// static "Syncing…" label. Also logged to the background console (inspect
// it via about:debugging → this extension → Inspect) so a slow sync's cause
// (huge file count vs. repeated rate-limit backoff) is visible, not guessed.
let syncProgress = null; // { mode:'full'|'incremental', filesSoFar, pageCount, rateLimitHits, startedAt } | null

async function fetchDriveJson(url, token, attempt = 0) {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (resp.status === 401) throw new Error("AUTH_EXPIRED");

  if (resp.status === 403 || resp.status === 429 || resp.status >= 500) {
    if (syncProgress) syncProgress.rateLimitHits++;
    if (attempt >= 4) throw new Error("RATE_LIMITED_OR_FORBIDDEN");
    const delay = 300 * 2 ** attempt + Math.random() * 200;
    console.log(
      `[Drive Folder Size] HTTP ${resp.status} — backing off ${Math.round(delay)}ms (attempt ${attempt + 1}/5). ` +
        `If this keeps happening, your Google Cloud project's Drive API quota is probably too low — see the setup page.`
    );
    await new Promise((r) => setTimeout(r, delay));
    return fetchDriveJson(url, token, attempt + 1);
  }

  if (!resp.ok) throw new Error(`DRIVE_API_${resp.status}`);
  return resp.json();
}

// ---------- the one full-Drive listing + in-memory folder totals ----------

async function fetchRootId(token) {
  const data = await throttled(() =>
    fetchDriveJson("https://www.googleapis.com/drive/v3/files/root?fields=id", token)
  );
  return data.id;
}

async function fetchAllFiles(token, onPage) {
  let pageToken = null;
  let pageCount = 0;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    // 'me' in owners keeps this scoped to your own My Drive content — not
    // shared-drive items (already excluded by default) and not stray
    // shared-with-me files that happen to be visible but aren't really
    // "yours" for folder-size purposes.
    url.searchParams.set("q", "trashed = false and 'me' in owners");
    url.searchParams.set("fields", "nextPageToken, files(id, mimeType, size, parents)");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("spaces", "drive");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    // Pagination is inherently sequential (each page's token depends on the
    // last), but still goes through the shared throttle for retry/backoff.
    const data = await throttled(() => fetchDriveJson(url.toString(), token));
    pageCount++;
    const files = data.files || [];
    if (syncProgress) {
      syncProgress.filesSoFar += files.length;
      syncProgress.pageCount = pageCount;
    }
    console.log(`[Drive Folder Size] page ${pageCount}: ${files.length} files (running total via syncProgress)`);
    if (onPage) onPage(files, pageCount);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
}

async function fetchStartPageToken(token) {
  const data = await throttled(() =>
    fetchDriveJson("https://www.googleapis.com/drive/v3/changes/startPageToken", token)
  );
  return data.startPageToken;
}

// Full listing, but building the same compact {m,s,p} shape we persist —
// short keys because this gets JSON-stringified as a whole and can run into
// the hundreds of thousands of entries.
async function fetchAllFilesAsMap(token, rootId) {
  const normalize = (id) => (id === rootId ? ROOT_KEY : id);
  const files = new Map(); // id -> {m: mimeType, s: size, p: [parentId,...]}
  await fetchAllFiles(token, (page) => {
    for (const f of page) {
      files.set(f.id, {
        m: f.mimeType,
        s: f.size ? parseInt(f.size, 10) : 0,
        p: (f.parents || []).map(normalize),
      });
    }
  });
  return files;
}

// Applies a changes.list delta directly onto an existing {m,s,p} file map —
// mutates it in place and returns the new checkpoint token to save for next
// time. Throws INVALID_CHANGES_TOKEN if Google no longer recognizes the
// checkpoint we had (it can expire after a long enough gap), signaling the
// caller to fall back to a full resync.
async function applyChanges(token, files, startPageToken, rootId) {
  const normalize = (id) => (id === rootId ? ROOT_KEY : id);
  let pageToken = startPageToken;
  let newStartPageToken = null;
  let pageCount = 0;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/changes");
    url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set(
      "fields",
      "nextPageToken, newStartPageToken, changes(fileId, removed, file(id, mimeType, size, parents, trashed))"
    );
    url.searchParams.set("restrictToMyDrive", "true");

    let data;
    try {
      data = await throttled(() => fetchDriveJson(url.toString(), token));
    } catch (e) {
      if (e.message === "DRIVE_API_400" || e.message === "DRIVE_API_404") {
        throw new Error("INVALID_CHANGES_TOKEN");
      }
      throw e;
    }

    pageCount++;
    const changes = data.changes || [];
    if (syncProgress) {
      syncProgress.filesSoFar += changes.length;
      syncProgress.pageCount = pageCount;
    }
    console.log(`[Drive Folder Size] changes page ${pageCount}: ${changes.length} changed item(s)`);

    for (const c of changes) {
      if (c.removed || !c.file || c.file.trashed) {
        files.delete(c.fileId);
        continue;
      }
      files.set(c.file.id, {
        m: c.file.mimeType,
        s: c.file.size ? parseInt(c.file.size, 10) : 0,
        p: (c.file.parents || []).map(normalize),
      });
    }

    pageToken = data.nextPageToken || null;
    if (data.newStartPageToken) newStartPageToken = data.newStartPageToken;
  } while (pageToken);

  return newStartPageToken;
}

// Pure in-memory pass over the {m,s,p} file map → { totals, childFolders }.
// Same computation whether the map came from a full listing or an
// incremental patch — the expensive part was ever getting the map, not this.
function computeTotals(files) {
  const totals = new Map(); // id -> {size, hasNativeDocs}
  const childFolders = new Map(); // parentId -> [folderId, ...]
  const ensureTotal = (id) => {
    if (!totals.has(id)) totals.set(id, { size: 0, hasNativeDocs: false });
    return totals.get(id);
  };
  ensureTotal(ROOT_KEY);

  for (const [id, f] of files) {
    if (f.m !== FOLDER_MIME) continue;
    for (const parentId of f.p) {
      if (!childFolders.has(parentId)) childFolders.set(parentId, []);
      childFolders.get(parentId).push(id);
    }
  }

  for (const [id, f] of files) {
    if (f.m === FOLDER_MIME) continue;
    const size = f.s || 0;
    const isNativeDoc = !f.s && f.m && f.m.startsWith("application/vnd.google-apps.");

    const seen = new Set();
    const stack = [...f.p];
    while (stack.length) {
      const parentId = stack.pop();
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const bucket = ensureTotal(parentId);
      bucket.size += size;
      if (isNativeDoc) bucket.hasNativeDocs = true;
      if (parentId !== ROOT_KEY) {
        const parentFile = files.get(parentId);
        if (parentFile) stack.push(...parentFile.p);
      }
    }
  }

  return {
    totals: Object.fromEntries(totals),
    childFolders: Object.fromEntries(childFolders),
  };
}

// forceCheck=true (from "Sync now") skips the 15-minute throttle but still
// prefers an incremental check over a full resync whenever we have a base
// to patch — a full resync should really only ever happen once.
async function getIndex(token, forceCheck) {
  const stored = await browser.storage.local.get(["driveFiles", "driveTotals", "changesToken", "indexSyncedAt"]);
  const hasBase = stored.driveFiles && stored.changesToken;

  if (!forceCheck && stored.driveTotals && stored.indexSyncedAt) {
    if (Date.now() - stored.indexSyncedAt < SYNC_CHECK_INTERVAL_MS) return stored.driveTotals;
  }
  if (fullSyncInFlight) return fullSyncInFlight;

  const startedAt = Date.now();

  fullSyncInFlight = (async () => {
    let files = null;
    let changesToken;
    let mode;

    if (hasBase) {
      mode = "incremental";
      syncProgress = { mode, filesSoFar: 0, pageCount: 0, rateLimitHits: 0, startedAt };
      try {
        const rootId = await fetchRootId(token);
        files = new Map(Object.entries(stored.driveFiles));
        changesToken = await applyChanges(token, files, stored.changesToken, rootId);
      } catch (e) {
        if (e.message !== "INVALID_CHANGES_TOKEN") throw e;
        console.log("[Drive Folder Size] saved checkpoint is no longer valid — falling back to a full resync");
        files = null; // fall through below
      }
    }

    if (!files) {
      mode = "full";
      syncProgress = { mode, filesSoFar: 0, pageCount: 0, rateLimitHits: 0, startedAt };
      const rootId = await fetchRootId(token);
      // Grab the checkpoint BEFORE listing, so the next incremental sync
      // also catches anything that changed while this listing was running.
      changesToken = await fetchStartPageToken(token);
      files = await fetchAllFilesAsMap(token, rootId);
    }

    const totals = computeTotals(files);
    const finishedAt = Date.now();
    await browser.storage.local.set({
      driveFiles: Object.fromEntries(files),
      driveTotals: totals,
      changesToken,
      indexSyncedAt: finishedAt,
      lastSyncMeta: {
        mode,
        fileCount: files.size,
        folderCount: Object.keys(totals.totals).length,
        durationMs: finishedAt - startedAt,
      },
    });
    return totals;
  })().finally(() => {
    fullSyncInFlight = null;
    syncProgress = null;
  });

  return fullSyncInFlight;
}

async function clearIndex() {
  await browser.storage.local.remove(["driveFiles", "driveTotals", "changesToken", "indexSyncedAt", "lastSyncMeta"]);
}

// ---------- message handling ----------

// Single call per folder navigation: returns every child folder's id AND its
// already-computed recursive size together (the index is either already
// synced — instant — or this is the first call ever and it triggers the one
// full sync, which can take a while on a big Drive).
async function getFolderContents(folderId) {
  const enabled = await getSetting("enabled");
  if (!enabled) return { ok: false, error: "DISABLED" };

  let token;
  try {
    token = await getSilentToken();
  } catch (e) {
    return { ok: false, error: e.message || "AUTH_REQUIRED" };
  }

  try {
    const index = await getIndex(token, false);
    const key = folderId || ROOT_KEY;
    const folderIds = index.childFolders[key] || [];
    const sizes = {};
    let anyNativeDocs = false;
    for (const id of folderIds) {
      const t = index.totals[id] || { size: 0, hasNativeDocs: false };
      sizes[id] = t.size;
      anyNativeDocs = anyNativeDocs || t.hasNativeDocs;
    }
    return { ok: true, sizes, hasNativeDocs: anyNativeDocs };
  } catch (e) {
    if (e.message === "AUTH_EXPIRED") {
      await clearToken();
      return { ok: false, error: "AUTH_EXPIRED" };
    }
    return { ok: false, error: e.message || "UNKNOWN_ERROR" };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "GET_FOLDER_CONTENTS":
      return getFolderContents(msg.folderId);

    case "GET_SYNC_PROGRESS":
      return Promise.resolve({ progress: syncProgress });

    case "GET_ENABLED":
      return getSetting("enabled").then((v) => ({ enabled: !!v }));

    case "SET_ENABLED":
      return setSetting("enabled", !!msg.enabled).then(() => ({ ok: true }));

    case "CHECK_AUTH":
      return getSilentToken()
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: e.message }));

    case "TEST_CONNECTION":
      // Only ever called from a real button click (options/popup), so an
      // interactive popup here is expected and won't be blocked.
      return (async () => {
        try {
          const token = await getToken(true);
          const resp = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!resp.ok) return { ok: false, error: `HTTP_${resp.status}` };
          const data = await resp.json();
          return { ok: true, email: data.user && data.user.emailAddress };
        } catch (e) {
          return { ok: false, error: e.message || "AUTH_FAILED" };
        }
      })();

    case "SYNC_NOW":
      // User-triggered (button click): forces an immediate check now instead
      // of waiting for the 15-minute throttle. Still prefers a small
      // incremental changes.list patch over a full resync whenever possible.
      return (async () => {
        try {
          const token = await getToken(true);
          const index = await getIndex(token, true);
          const folderCount = Object.keys(index.totals).length;
          return { ok: true, folderCount };
        } catch (e) {
          return { ok: false, error: e.message || "SYNC_FAILED" };
        }
      })();

    case "CLEAR_CACHE":
      return clearIndex().then(() => ({ ok: true }));

    case "DISCONNECT":
      return clearToken().then(() => ({ ok: true }));

    default:
      return undefined;
  }
});
