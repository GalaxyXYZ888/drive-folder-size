const toggle = document.getElementById("enabledToggle");
const connStatus = document.getElementById("connStatus");
const openOptions = document.getElementById("openOptions");
const reconnectBtn = document.getElementById("reconnectBtn");

async function refreshConnStatus() {
  const { clientId } = await browser.storage.local.get("clientId");
  if (!clientId) {
    connStatus.textContent = "Not set up yet — add your Client ID first.";
    connStatus.style.color = "#c5221f";
    reconnectBtn.style.display = "none";
    return;
  }

  const authCheck = await browser.runtime.sendMessage({ type: "CHECK_AUTH" }).catch(() => ({ ok: false }));
  if (authCheck && authCheck.ok) {
    connStatus.textContent = "";
    reconnectBtn.style.display = "none";
  } else {
    // Tokens expire roughly hourly and Firefox's silent-refresh doesn't
    // always have a session to reuse, so this is an expected, normal state
    // — not a bug. One click fixes it (this button click is a real user
    // gesture, so the interactive popup can safely open here).
    connStatus.textContent = "Signed out — badges will show \"?\" until you reconnect.";
    connStatus.style.color = "#c5221f";
    reconnectBtn.style.display = "block";
  }
}

(async () => {
  const { enabled } = await browser.runtime.sendMessage({ type: "GET_ENABLED" });
  toggle.checked = !!enabled;
  await refreshConnStatus();
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
