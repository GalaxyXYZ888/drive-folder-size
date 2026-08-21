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

async function refreshSyncStatus() {
  const { indexSyncedAt, driveIndex } = await browser.storage.local.get(["indexSyncedAt", "driveIndex"]);
  if (!indexSyncedAt) {
    syncStatus.textContent = "Not synced yet — happens automatically the first time you open a folder.";
    return;
  }
  const folderCount = driveIndex ? Object.keys(driveIndex.totals || {}).length : 0;
  syncStatus.textContent = `Last synced ${new Date(indexSyncedAt).toLocaleString()} (${folderCount} folders indexed).`;
}

(async () => {
  redirectUriBox.textContent = browser.identity.getRedirectURL();
  const { clientId } = await browser.storage.local.get("clientId");
  if (clientId) clientIdInput.value = clientId;
  await refreshSyncStatus();
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
  syncNowBtn.disabled = true;
  const original = syncNowBtn.textContent;
  syncNowBtn.textContent = "Syncing…";
  syncStatus.textContent = "Syncing your Drive — this can take a bit on a large Drive…";
  const resp = await browser.runtime.sendMessage({ type: "SYNC_NOW" });
  syncNowBtn.disabled = false;
  syncNowBtn.textContent = original;
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
