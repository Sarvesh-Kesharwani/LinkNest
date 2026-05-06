if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
}

const status = document.querySelector("#install-status");

if (status) {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  status.textContent = standalone
    ? "Installed mode detected."
    : "Install this app, then try sharing into it.";
}
