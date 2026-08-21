// Drive Folder Size — background script
//
// Architecture (v0.2): instead of walking the folder tree one API call per
// folder (slow — O(number of folders) sequential round-trips for a deep/wide
// tree), we fetch the user's ENTIRE file list ONCE (paginated, ~1000
// files/page, every file's id/size/mimeType/parents), then compute every
// folder's recursive size as plain in-memory arithmetic: for each non-folder
// file, walk its parent chain and add its size to every ancestor folder's
// running total. That's it — no more per-folder network calls after the
// initial sync. The whole index is cached for 24h in storage.local.
//
// Responsibilities:
//  - OAuth (implicit flow via browser.identity.launchWebAuthFlow, no client secret needed)
//  - The one full-Drive listing + in-memory folder-size computation
//  - Answering messages from content.js / popup.js / options.js

const INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
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

async function fetchDriveJson(url, token, attempt = 0) {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (resp.status === 401) throw new Error("AUTH_EXPIRED");

  if (resp.status === 403 || resp.status === 429 || resp.status >= 500) {
    if (attempt >= 4) throw new Error("RATE_LIMITED_OR_FORBIDDEN");
    const delay = 300 * 2 ** attempt + Math.random() * 200;
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
    if (onPage) onPage(data.files || [], pageCount);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
}

// Builds { totals: {id -> {size, hasNativeDocs}}, childFolders: {id -> [folderId,...]} }
// for EVERY folder in the Drive (keyed by "root" for My Drive itself), in one
// pass of pure in-memory arithmetic over the full file list.
async function buildFullIndex(token) {
  const rootId = await fetchRootId(token);
  const normalize = (id) => (id === rootId ? ROOT_KEY : id);

  const mimeById = new Map();
  const sizeById = new Map();
  const parentsById = new Map();

  await fetchAllFiles(token, (files) => {
    for (const f of files) {
      mimeById.set(f.id, f.mimeType);
      sizeById.set(f.id, f.size ? parseInt(f.size, 10) : 0);
      parentsById.set(f.id, (f.parents || []).map(normalize));
    }
  });

  const totals = new Map(); // id -> {size, hasNativeDocs}
  const childFolders = new Map(); // parentId -> [folderId, ...]
  const ensureTotal = (id) => {
    if (!totals.has(id)) totals.set(id, { size: 0, hasNativeDocs: false });
    return totals.get(id);
  };
  ensureTotal(ROOT_KEY);

  // Build the folder->children index (folders only) directly from parents.
  for (const [id, mime] of mimeById) {
    if (mime !== FOLDER_MIME) continue;
    for (const parentId of parentsById.get(id) || []) {
      if (!childFolders.has(parentId)) childFolders.set(parentId, []);
      childFolders.get(parentId).push(id);
    }
  }

  // For every non-folder file, walk its parent chain upward, adding its size
  // to every ancestor folder's running total (a file/folder can technically
  // have multiple parents in Drive's data model, so this can branch).
  for (const [id, mime] of mimeById) {
    if (mime === FOLDER_MIME) continue;
    const size = sizeById.get(id) || 0;
    const isNativeDoc = !sizeById.get(id) && mime && mime.startsWith("application/vnd.google-apps.");

    const seen = new Set();
    const stack = [...(parentsById.get(id) || [])];
    while (stack.length) {
      const parentId = stack.pop();
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const bucket = ensureTotal(parentId);
      bucket.size += size;
      if (isNativeDoc) bucket.hasNativeDocs = true;
      if (parentId !== ROOT_KEY) {
        stack.push(...(parentsById.get(parentId) || []));
      }
    }
  }

  return {
    totals: Object.fromEntries(totals),
    childFolders: Object.fromEntries([...childFolders].map(([k, v]) => [k, v])),
  };
}

async function getIndex(token, forceRefresh) {
  if (!forceRefresh) {
    const stored = await browser.storage.local.get(["driveIndex", "indexSyncedAt"]);
    if (stored.driveIndex && stored.indexSyncedAt && Date.now() - stored.indexSyncedAt < INDEX_TTL_MS) {
      return stored.driveIndex;
    }
  }
  if (fullSyncInFlight) return fullSyncInFlight;

  fullSyncInFlight = (async () => {
    const index = await buildFullIndex(token);
    await browser.storage.local.set({ driveIndex: index, indexSyncedAt: Date.now() });
    return index;
  })().finally(() => {
    fullSyncInFlight = null;
  });

  return fullSyncInFlight;
}

async function clearIndex() {
  await browser.storage.local.remove(["driveIndex", "indexSyncedAt"]);
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
      // User-triggered (button click) full re-sync, ignoring the 24h cache.
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
