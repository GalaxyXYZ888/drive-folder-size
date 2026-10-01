const toggle = document.getElementById("enabledToggle");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const lastSync = document.getElementById("lastSync");
const lastBackup = document.getElementById("lastBackup");
const connStatus = document.getElementById("connStatus");
const openOptions = document.getElementById("openOptions");
const reconnectBtn = document.getElementById("reconnectBtn");
const syncNowBtn = document.getElementById("syncNowBtn");
const versionEl = document.getElementById("version");

versionEl.textContent = `v${browser.runtime.getManifest().version}`;

// Result of the last failed button action, shown until the next attempt
// succeeds. Polling would otherwise wipe it within 1.5 seconds. Each applies
// only to the state its button lives in.
let syncError = "";
let reconnectError = "";
let syncNowRunning = false;
let refreshSeq = 0;

function timeAgo(ms) {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function render(state, detail, hint) {
  statusDot.className = `dot ${state}`;
  statusText.textContent = { ready: "Ready", syncing: "Syncing…", disconnected: "Not connected", disabled: "Off" }[state];
  const error = state === "ready" ? syncError : state === "disconnected" ? reconnectError : "";
  connStatus.textContent = error || detail || "";
  connStatus.style.color = error || state === "disconnected" ? "#c5221f" : "#5f6368";
  reconnectBtn.style.display = hint === "reconnect" ? "block" : "none";
  const showSync = state === "ready" || state === "syncing";
  syncNowBtn.style.display = showSync ? "block" : "none";
  syncNowBtn.disabled = state === "syncing";
  syncNowBtn.textContent = state === "syncing" ? "Syncing…" : "Sync now";
}

async function refreshTimes(state) {
  const { indexSyncedAt, lastSyncMeta, lastBackupAt } = await browser.storage.local.get([
    "indexSyncedAt",
    "lastSyncMeta",
    "lastBackupAt",
  ]);
  if (indexSyncedAt) {
    const files = lastSyncMeta && lastSyncMeta.fileCount ? `, ${lastSyncMeta.fileCount.toLocaleString()} files` : "";
    lastSync.textContent = `Last synced ${timeAgo(indexSyncedAt)}${files}`;
  } else {
    lastSync.textContent = state === "ready" || state === "syncing" ? "Not synced yet" : "";
  }
  lastBackup.textContent = lastBackupAt ? `Last backup to Drive: ${timeAgo(lastBackupAt)}` : "";
}

async function refreshConnStatus() {
  const seq = ++refreshSeq;
  const apply = (state, detail, hint) => {
    // A slower, older refresh must not overwrite a newer one.
    if (seq !== refreshSeq) return;
    render(state, detail, hint);
    return refreshTimes(state);
  };

  const { enabled, clientId } = await browser.storage.local.get(["enabled", "clientId"]);
  if (!enabled) return apply("disabled");
  if (!clientId) return apply("disconnected", "Not set up yet. Add your Client ID first.");

  const progressResp = await browser.runtime.sendMessage({ type: "GET_SYNC_PROGRESS" }).catch(() => null);
  if (progressResp && progressResp.progress) {
    const p = progressResp.progress;
    const elapsedSec = Math.round((Date.now() - p.startedAt) / 1000);
    return apply(
      "syncing",
      p.mode === "restore"
        ? `Restoring the Drive backup… ${elapsedSec}s elapsed.`
        : `${p.mode === "incremental" ? "Checking for changes" : "Full sync"}… ${p.filesSoFar.toLocaleString()} items, ${elapsedSec}s elapsed.`,
    );
  }
  if (syncNowRunning) return apply("syncing");

  const authCheck = await browser.runtime.sendMessage({ type: "CHECK_AUTH" }).catch(() => ({ ok: false }));
  if (authCheck && authCheck.ok) return apply("ready");
  // The refresh token normally renews access silently in the background,
  // so landing here means it's gone: revoked, or (Testing-mode Cloud
  // projects) past its ~7-day limit. Not a bug, just needs a fresh
  // consent. One click fixes it (this button click is a real user
  // gesture, so the interactive popup can safely open here).
  return apply("disconnected", "Signed out. Badges will show \"?\" until you reconnect.", "reconnect");
}

(async () => {
  const { enabled } = await browser.runtime.sendMessage({ type: "GET_ENABLED" });
  toggle.checked = !!enabled;
  await refreshConnStatus();
  // Popups are short-lived, but while the user keeps this one open (e.g.
  // watching a sync progress), keep it live rather than a one-time snapshot.
  setInterval(refreshConnStatus, 1500);
})();

toggle.addEventListener("change", async () => {
  await browser.runtime.sendMessage({ type: "SET_ENABLED", enabled: toggle.checked });
  await refreshConnStatus();
});

reconnectBtn.addEventListener("click", async () => {
  reconnectBtn.disabled = true;
  reconnectBtn.textContent = "Opening Google sign-in…";
  const resp = await browser.runtime.sendMessage({ type: "TEST_CONNECTION" });
  reconnectBtn.disabled = false;
  reconnectBtn.textContent = "Reconnect Google account";
  reconnectError = resp && resp.ok ? "" : `Reconnect failed: ${(resp && resp.error) || "unknown error"}`;
  if (resp && resp.ok) syncError = "";
  await refreshConnStatus();
});

syncNowBtn.addEventListener("click", async () => {
  syncNowRunning = true;
  syncError = "";
  syncNowBtn.disabled = true;
  refreshConnStatus();
  const resp = await browser.runtime.sendMessage({ type: "SYNC_NOW" }).catch((e) => ({ ok: false, error: e.message }));
  syncNowRunning = false;
  syncError = resp && resp.ok ? "" : `Sync failed: ${(resp && resp.error) || "unknown error"}`;
  await refreshConnStatus();
});

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});
