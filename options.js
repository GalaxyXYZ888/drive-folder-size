const clientIdInput = document.getElementById("clientId");
const clientSecretInput = document.getElementById("clientSecret");
const saveBtn = document.getElementById("saveBtn");
const connectBtn = document.getElementById("connectBtn");
const statusLine = document.getElementById("statusLine");
const redirectUriBox = document.getElementById("redirectUri");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const syncNowBtn = document.getElementById("syncNowBtn");
const syncStatus = document.getElementById("syncStatus");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFile = document.getElementById("importFile");
const backupDriveBtn = document.getElementById("backupDriveBtn");
const restoreDriveBtn = document.getElementById("restoreDriveBtn");
const backupStatus = document.getElementById("backupStatus");

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
    syncStatus.textContent = "Not synced yet. Happens automatically the first time you open a folder.";
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
    `Last synced ${when}: ${folderCount.toLocaleString()} folders, ${fileCount.toLocaleString()} files, ` +
    `took ${formatDuration(durationMs)} (${modeLabel}).`;
}

// Polls the background script's live progress so "Syncing…" isn't a black
// box, shows real file/page counts and flags whether repeated rate-limit
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
        ? `, hit the API rate limit ${progress.rateLimitHits}× so far`
        : "";
    const label = progress.mode === "incremental" ? "Checking for changes" : "Full sync";
    syncStatus.textContent = `${label}… ${progress.filesSoFar.toLocaleString()} items across ${progress.pageCount} page(s), ${elapsedSec}s elapsed${rateNote}.`;
  }, 1000);
}

(async () => {
  redirectUriBox.textContent = browser.identity.getRedirectURL();
  const { clientId, clientSecret } = await browser.storage.local.get(["clientId", "clientSecret"]);
  if (clientId) clientIdInput.value = clientId;
  if (clientSecret) clientSecretInput.value = clientSecret;
  await refreshSyncStatus();
  startProgressPolling();
})();

saveBtn.addEventListener("click", async () => {
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();
  if (!clientId || !clientSecret) {
    setStatus("Enter both the Client ID and Client secret first.", true);
    return;
  }
  await browser.storage.local.set({ clientId, clientSecret });
  setStatus("Saved.", false);
});

connectBtn.addEventListener("click", async () => {
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();
  if (!clientId || !clientSecret) {
    setStatus("Enter and save both the Client ID and Client secret first.", true);
    return;
  }
  await browser.storage.local.set({ clientId, clientSecret });
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

function setBackupStatus(text, isError) {
  backupStatus.textContent = text;
  backupStatus.style.color = isError ? "#c5221f" : "#188038";
}

// Friendlier text for the errors someone's actually likely to hit here.
function describeSnapshotError(error) {
  if (error === "APPDATA_SCOPE_MISSING") {
    return (
      "missing Drive backup access. Add scope drive.appdata to your Cloud project's OAuth consent " +
      'screen, then click "Disconnect" and "Connect & test" again above.'
    );
  }
  if (error === "NOTHING_TO_EXPORT") return "nothing to export yet, sync at least once first.";
  if (error === "NO_BACKUP_FOUND") return "no backup found in Drive yet, use \"Back up\" first.";
  if (error === "INVALID_SNAPSHOT") return "that file doesn't look like a Drive Folder Size export.";
  return error || "unknown error";
}

exportBtn.addEventListener("click", async () => {
  const resp = await browser.runtime.sendMessage({ type: "EXPORT_SNAPSHOT" });
  if (!resp || !resp.ok) {
    setBackupStatus(`Export failed: ${describeSnapshotError(resp && resp.error)}`, true);
    return;
  }
  const blob = new Blob([JSON.stringify(resp.snapshot)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `drive-folder-size-index-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  const fileCount = Object.keys(resp.snapshot.driveFiles).length.toLocaleString();
  setBackupStatus(`Exported index (covers ${fileCount} files) to a file.`, false);
});

importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  importFile.value = ""; // so re-selecting the same file still fires "change"
  if (!file) return;
  try {
    const snapshot = JSON.parse(await file.text());
    const resp = await browser.runtime.sendMessage({ type: "IMPORT_SNAPSHOT", snapshot });
    if (resp && resp.ok) {
      setBackupStatus(
        `Imported index (covers ${resp.fileCount.toLocaleString()} files). ` +
          "The next sync will catch up on anything that's changed since.",
        false
      );
      await refreshSyncStatus();
    } else {
      setBackupStatus(`Import failed: ${describeSnapshotError(resp && resp.error)}`, true);
    }
  } catch (e) {
    setBackupStatus("Import failed: that file isn't valid JSON.", true);
  }
});

backupDriveBtn.addEventListener("click", async () => {
  setBackupStatus("Backing up…", false);
  const resp = await browser.runtime.sendMessage({ type: "BACKUP_TO_DRIVE" });
  if (resp && resp.ok) {
    setBackupStatus(`Backed up index (covers ${resp.fileCount.toLocaleString()} files) to Drive.`, false);
  } else {
    setBackupStatus(`Backup failed: ${describeSnapshotError(resp && resp.error)}`, true);
  }
});

restoreDriveBtn.addEventListener("click", async () => {
  setBackupStatus("Restoring…", false);
  const resp = await browser.runtime.sendMessage({ type: "RESTORE_FROM_DRIVE" });
  if (resp && resp.ok) {
    const when = resp.modifiedTime ? new Date(resp.modifiedTime).toLocaleString() : "unknown time";
    setBackupStatus(
      `Restored index (covers ${resp.fileCount.toLocaleString()} files) from a Drive backup saved ${when}. ` +
        "The next sync will catch up on anything new since.",
      false
    );
    await refreshSyncStatus();
  } else {
    setBackupStatus(`Restore failed: ${describeSnapshotError(resp && resp.error)}`, true);
  }
});
