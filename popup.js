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

// Last sync and backup times come with the state from the background, so they
// are never a separate storage read that could wait behind a running sync.
function renderTimes(state, info) {
  if (info.indexSyncedAt) {
    const files = info.fileCount ? `, ${info.fileCount.toLocaleString()} files` : "";
    lastSync.textContent = `Last synced ${timeAgo(info.indexSyncedAt)}${files}`;
  } else {
    lastSync.textContent = state === "ready" || state === "syncing" ? "Not synced yet" : "";
  }
  lastBackup.textContent = info.lastBackupAt ? `Last backup to Drive: ${timeAgo(info.lastBackupAt)}` : "";
}

// While the background is busy with a sync it can take a while to answer, so
// nothing here waits for it indefinitely. null means it didn't answer in time,
// undefined that the message failed.
const ANSWER_TIMEOUT_MS = 2500;
const BUSY_TEXT = "Busy, this will update shortly.";

function ask(message) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ANSWER_TIMEOUT_MS);
    browser.runtime.sendMessage(message).then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

// The switch stays disabled until the first real answer, so it never shows a
// guess.
let toggleKnown = false;
toggle.disabled = true;

async function refreshConnStatus() {
  const seq = ++refreshSeq;
  const apply = (state, detail, hint, info) => {
    // A slower, older refresh must not overwrite a newer one.
    if (seq !== refreshSeq) return;
    render(state, detail, hint);
    if (info) renderTimes(state, info);
  };

  const s = await ask({ type: "GET_POPUP_STATE" });
  if (!s) return apply("syncing", BUSY_TEXT);
  if (!toggleKnown) {
    toggleKnown = true;
    toggle.checked = !!s.enabled;
    toggle.disabled = false;
  }
  if (!s.enabled) return apply("disabled", "", undefined, s);
  if (!s.hasClient) return apply("disconnected", "Not set up yet. Add your Client ID first.", undefined, s);

  if (s.progress) {
    const p = s.progress;
    const elapsedSec = Math.round((Date.now() - p.startedAt) / 1000);
    return apply(
      "syncing",
      p.mode === "restore"
        ? `Restoring the Drive backup… ${elapsedSec}s elapsed.`
        : `${p.mode === "incremental" ? "Checking for changes" : "Full sync"}… ${p.filesSoFar.toLocaleString()} items, ${elapsedSec}s elapsed.`,
      undefined,
      s,
    );
  }
  if (syncNowRunning) return apply("syncing", "", undefined, s);

  const authCheck = await ask({ type: "CHECK_AUTH" });
  if (authCheck === null) return apply("syncing", BUSY_TEXT, undefined, s);
  if (authCheck && authCheck.ok) return apply("ready", "", undefined, s);
  // The refresh token normally renews access silently in the background,
  // so landing here means it's gone: revoked, or (Testing-mode Cloud
  // projects) past its ~7-day limit. Not a bug, just needs a fresh
  // consent. One click fixes it (this button click is a real user
  // gesture, so the interactive popup can safely open here).
  return apply("disconnected", "Signed out. Badges will show \"?\" until you reconnect.", "reconnect", s);
}

(async () => {
  await refreshConnStatus();
  // Popups are short-lived, but while the user keeps this one open (e.g.
  // watching a sync progress), keep it live rather than a one-time snapshot.
  // A tick is skipped while the previous one is still waiting for an answer.
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    refreshConnStatus().finally(() => {
      polling = false;
    });
  }, 1500);
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
