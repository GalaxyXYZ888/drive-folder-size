const clientIdInput = document.getElementById("clientId");
const saveBtn = document.getElementById("saveBtn");
const connectBtn = document.getElementById("connectBtn");
const statusLine = document.getElementById("statusLine");
const redirectUriBox = document.getElementById("redirectUri");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const syncNowBtn = document.getElementById("syncNowBtn");
const syncStatus = document.getElementById("syncStatus");

function setStatus(text, isError) {
  statusLine.textContent = text;
  statusLine.style.color = isError ? "#c5221f" : "#188038";
}

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

async function refreshSyncStatus() {
  const { indexSyncedAt, lastSyncMeta } = await browser.storage.local.get(["indexSyncedAt", "lastSyncMeta"]);
  if (!indexSyncedAt) {
    syncStatus.textContent = "Not synced yet — happens automatically the first time you open a folder.";
    return;
  }
  const when = new Date(indexSyncedAt).toLocaleString();
  if (!lastSyncMeta) {
    syncStatus.textContent = `Last synced ${when}.`;
    return;
  }
  const { mode, folderCount, fileCount, durationMs } = lastSyncMeta;
  const modeLabel = mode === "incremental" ? "incremental check" : "full sync";
  syncStatus.textContent =
    `Last synced ${when} — ${folderCount.toLocaleString()} folders, ${fileCount.toLocaleString()} files, ` +
    `took ${formatDuration(durationMs)} (${modeLabel}).`;
}

// Polls the background script's live progress so "Syncing…" isn't a black
// box — shows real file/page counts and flags whether repeated rate-limit
// backoff (not just raw file count) is what's making it slow. Runs
// continuously in the background so it also picks up a sync that was
// triggered by just browsing Drive in another tab, not only the button here.
let progressPollHandle = null;
function startProgressPolling() {
  if (progressPollHandle) return;
  progressPollHandle = setInterval(async () => {
    const resp = await browser.runtime.sendMessage({ type: "GET_SYNC_PROGRESS" }).catch(() => null);
    const progress = resp && resp.progress;
    if (!progress) {
      syncNowBtn.disabled = false;
      syncNowBtn.textContent = "Sync now";
      return;
    }
    syncNowBtn.disabled = true;
    syncNowBtn.textContent = progress.mode === "incremental" ? "Checking for changes…" : "Full sync…";
    const elapsedSec = Math.round((Date.now() - progress.startedAt) / 1000);
    const rateNote =
      progress.rateLimitHits > 0
        ? ` — hit the API rate limit ${progress.rateLimitHits}× so far (see "Speeding up a slow sync" below)`
        : "";
    const label = progress.mode === "incremental" ? "Checking for changes" : "Full sync";
    syncStatus.textContent = `${label}… ${progress.filesSoFar.toLocaleString()} items across ${progress.pageCount} page(s), ${elapsedSec}s elapsed${rateNote}.`;
  }, 1000);
}

(async () => {
  redirectUriBox.textContent = browser.identity.getRedirectURL();
  const { clientId } = await browser.storage.local.get("clientId");
  if (clientId) clientIdInput.value = clientId;
  await refreshSyncStatus();
  startProgressPolling();
})();

saveBtn.addEventListener("click", async () => {
  const value = clientIdInput.value.trim();
  if (!value) {
    setStatus("Enter a Client ID first.", true);
    return;
  }
  await browser.storage.local.set({ clientId: value });
  setStatus("Saved.", false);
});

connectBtn.addEventListener("click", async () => {
  const value = clientIdInput.value.trim();
  if (!value) {
    setStatus("Enter and save a Client ID first.", true);
    return;
  }
  await browser.storage.local.set({ clientId: value });
  setStatus("Opening Google sign-in…", false);
  const resp = await browser.runtime.sendMessage({ type: "TEST_CONNECTION" });
  if (resp && resp.ok) {
    setStatus(`Connected as ${resp.email || "your Google account"}. All set.`, false);
  } else {
    setStatus(`Connection failed: ${(resp && resp.error) || "unknown error"}`, true);
  }
});

syncNowBtn.addEventListener("click", async () => {
  // Button state during the sync is driven by startProgressPolling() above,
  // which is already running and will pick this up within a second.
  const resp = await browser.runtime.sendMessage({ type: "SYNC_NOW" });
  if (resp && resp.ok) {
    setStatus(`Synced ${resp.folderCount} folders.`, false);
  } else {
    setStatus(`Sync failed: ${(resp && resp.error) || "unknown error"}`, true);
  }
  await refreshSyncStatus();
});

clearCacheBtn.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CLEAR_CACHE" });
  setStatus("Cache cleared.", false);
  await refreshSyncStatus();
});

disconnectBtn.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "DISCONNECT" });
  setStatus("Disconnected. Click \"Connect & test\" to sign in again.", false);
});
