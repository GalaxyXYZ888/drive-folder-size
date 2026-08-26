const toggle = document.getElementById("enabledToggle");
const connStatus = document.getElementById("connStatus");
const openOptions = document.getElementById("openOptions");
const reconnectBtn = document.getElementById("reconnectBtn");

async function refreshConnStatus() {
  const { clientId } = await browser.storage.local.get("clientId");
  if (!clientId) {
    connStatus.textContent = "Not set up yet. Add your Client ID first.";
    connStatus.style.color = "#c5221f";
    reconnectBtn.style.display = "none";
    return;
  }

  const progressResp = await browser.runtime.sendMessage({ type: "GET_SYNC_PROGRESS" }).catch(() => null);
  if (progressResp && progressResp.progress) {
    const p = progressResp.progress;
    const elapsedSec = Math.round((Date.now() - p.startedAt) / 1000);
    const label = p.mode === "incremental" ? "Checking for changes" : "Full sync";
    connStatus.textContent = `${label}… ${p.filesSoFar.toLocaleString()} items, ${elapsedSec}s elapsed. See the setup page for details.`;
    connStatus.style.color = "#5f6368";
    reconnectBtn.style.display = "none";
    return;
  }

  const authCheck = await browser.runtime.sendMessage({ type: "CHECK_AUTH" }).catch(() => ({ ok: false }));
  if (authCheck && authCheck.ok) {
    connStatus.textContent = "";
    reconnectBtn.style.display = "none";
  } else {
    // The refresh token normally renews access silently in the background,
    // so landing here means it's gone: revoked, or (Testing-mode Cloud
    // projects) past its ~7-day limit. Not a bug, just needs a fresh
    // consent. One click fixes it (this button click is a real user
    // gesture, so the interactive popup can safely open here).
    connStatus.textContent = "Signed out. Badges will show \"?\" until you reconnect.";
    connStatus.style.color = "#c5221f";
    reconnectBtn.style.display = "block";
  }
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
  if (toggle.checked) await refreshConnStatus();
});

reconnectBtn.addEventListener("click", async () => {
  reconnectBtn.disabled = true;
  reconnectBtn.textContent = "Opening Google sign-in…";
  const resp = await browser.runtime.sendMessage({ type: "TEST_CONNECTION" });
  reconnectBtn.disabled = false;
  reconnectBtn.textContent = "Reconnect Google account";
  if (resp && resp.ok) {
    await refreshConnStatus();
  } else {
    connStatus.textContent = `Reconnect failed: ${(resp && resp.error) || "unknown error"}`;
  }
});

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});
