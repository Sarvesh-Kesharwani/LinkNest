if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(console.error);
}

const params = new URLSearchParams(window.location.search);
const title = params.get("title") || "";
const text = params.get("text") || "";
const url = params.get("url") || "";
const combined = [url, text, title].filter(Boolean).join(" ");
const detectedUrl = extractFirstUrl(combined);

const status = document.querySelector("#status");
const output = document.querySelector("#shared-url");
const saveButton = document.querySelector("#save-button");

if (output instanceof HTMLTextAreaElement) {
  output.value = detectedUrl || combined || "No shared text/url received.";
}

if (status) {
  status.textContent = detectedUrl
    ? "Share target worked. URL received."
    : "Opened, but no URL was received.";
}

if (saveButton instanceof HTMLButtonElement) {
  saveButton.addEventListener("click", () => {
    const saved = JSON.parse(localStorage.getItem("clipvault-test-links") || "[]");
    saved.unshift({
      url: detectedUrl || combined,
      createdAt: new Date().toISOString(),
    });
    localStorage.setItem("clipvault-test-links", JSON.stringify(saved.slice(0, 50)));
    if (status) status.textContent = "Saved locally for test.";
  });
}

function extractFirstUrl(input) {
  const match = input.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[),.;!?]+$/g, "") : "";
}
