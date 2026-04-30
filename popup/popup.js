const titleInput = document.getElementById("title-input");
const tagsInput = document.getElementById("tags-input");
const tagsList = document.getElementById("tags-list");
const preview = document.getElementById("preview");
const clipBtn = document.getElementById("clip-btn");
const statusArea = document.getElementById("status-area");
const statusMessage = document.getElementById("status-message");
const driveLink = document.getElementById("drive-link");
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const notConfigured = document.getElementById("status-not-configured");
const openOptions = document.getElementById("open-options");
const imageInfo = document.getElementById("image-info");
const includeImagesRow = document.getElementById("include-images-row");
const includeImagesCheckbox = document.getElementById("include-images");
const includeImagesLabel = document.getElementById("include-images-label");
const historyList = document.getElementById("history-list");

let extractedData = null;
let userTags = [];

// --- Tag input ---
function renderTags() {
  tagsList.innerHTML = "";
  userTags.forEach((tag, idx) => {
    const el = document.createElement("span");
    el.className = "tag";
    el.textContent = tag;
    const remove = document.createElement("span");
    remove.className = "tag-remove";
    remove.textContent = "\u00d7";
    remove.addEventListener("click", () => {
      userTags.splice(idx, 1);
      renderTags();
    });
    el.appendChild(remove);
    tagsList.appendChild(el);
  });
}

tagsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    const tag = tagsInput.value.trim().replace(/,/g, "");
    if (tag && !userTags.includes(tag)) {
      userTags.push(tag);
      renderTags();
    }
    tagsInput.value = "";
  }
  // Backspace on empty input removes last tag
  if (e.key === "Backspace" && !tagsInput.value && userTags.length > 0) {
    userTags.pop();
    renderTags();
  }
});

// --- Load default tags from settings ---
chrome.storage.sync.get({ folderId: "", defaultTags: "" }, (settings) => {
  if (!settings.folderId) {
    notConfigured.style.display = "block";
    clipBtn.disabled = true;
  }
  // Pre-populate with default tags
  if (settings.defaultTags) {
    const defaults = settings.defaultTags.split(",").map(t => t.trim()).filter(Boolean);
    defaults.forEach(t => {
      if (!userTags.includes(t)) userTags.push(t);
    });
    renderTags();
  }
});

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// --- Extract content from the active tab ---
async function extractFromTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/readability.js", "lib/turndown.js", "content/content-script.js"]
    });
  } catch (err) {
    // Scripts may already be injected
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { action: "extract" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.success) {
        reject(new Error(response?.error || "Failed to extract content"));
        return;
      }
      resolve({ ...response.data, url: tab.url });
    });
  });
}

// On popup open, extract content
extractFromTab()
  .then((data) => {
    if (!data) {
      showError("Could not extract content from this page.");
      return;
    }
    extractedData = data;
    titleInput.value = data.title || "";
    preview.value = data.markdown
      ? data.markdown.slice(0, 500) + (data.markdown.length > 500 ? "\n..." : "")
      : "(no content extracted)";

    // Show image count + include-images checkbox (sticky)
    if (data.imageUrls && data.imageUrls.length > 0) {
      const count = data.imageUrls.length;
      imageInfo.textContent = `${count} image(s) found on page`;
      imageInfo.style.display = "block";

      includeImagesLabel.textContent = `Include ${count} image${count === 1 ? "" : "s"}`;
      chrome.storage.local.get({ includeImagesSticky: true }, (state) => {
        includeImagesCheckbox.checked = state.includeImagesSticky;
      });
      includeImagesRow.style.display = "flex";
    }

    clipBtn.disabled = false;

    chrome.storage.sync.get({ folderId: "" }, (settings) => {
      if (!settings.folderId) clipBtn.disabled = true;
    });
  })
  .catch((err) => {
    showError("Extraction failed: " + err.message);
  });

// --- Clip button ---
clipBtn.addEventListener("click", async () => {
  if (!extractedData) return;

  clipBtn.disabled = true;
  loading.style.display = "flex";
  statusArea.style.display = "none";

  const hasImages = extractedData.imageUrls && extractedData.imageUrls.length > 0;
  const includeImages = includeImagesCheckbox.checked;
  if (hasImages && includeImages) {
    loadingText.textContent = "Uploading images & clipping...";
  } else {
    loadingText.textContent = "Clipping...";
  }

  // Persist sticky choice for next time
  if (hasImages) {
    chrome.storage.local.set({ includeImagesSticky: includeImages });
  }

  const today = new Date().toISOString().slice(0, 10);

  chrome.runtime.sendMessage(
    {
      action: "clip",
      data: {
        title: titleInput.value || extractedData.title,
        markdown: extractedData.markdown,
        url: extractedData.url,
        clippedDate: today,
        tags: userTags,
        imageUrls: extractedData.imageUrls || [],
        includeImages: includeImages
      }
    },
    (response) => {
      loading.style.display = "none";

      if (response && response.success) {
        let msg = `Saved as ${response.fileName}`;
        if (response.imageCount > 0) {
          msg += ` (${response.imageCount} image(s) uploaded)`;
        }
        showSuccess(msg);
        if (response.webViewLink) {
          driveLink.href = response.webViewLink;
          driveLink.style.display = "inline-block";
        }
        // Refresh history
        loadHistory();
      } else {
        showError(response?.error || "Unknown error");
        clipBtn.disabled = false;
      }
    }
  );
});

// --- Clip history ---
function loadHistory() {
  chrome.runtime.sendMessage({ action: "getHistory" }, (response) => {
    if (!response || !response.success || !response.history.length) {
      historyList.innerHTML = '<div class="history-empty">No clips yet.</div>';
      return;
    }

    historyList.innerHTML = "";
    response.history.forEach((entry) => {
      const item = document.createElement("a");
      item.className = "history-item";
      item.href = entry.webViewLink || "#";
      item.target = "_blank";

      const title = document.createElement("div");
      title.className = "history-title";
      title.textContent = entry.title;

      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent = entry.clippedDate;
      if (entry.imageCount > 0) {
        meta.textContent += ` · ${entry.imageCount} img`;
      }

      item.appendChild(title);
      item.appendChild(meta);
      historyList.appendChild(item);
    });
  });
}

// Load history on popup open
loadHistory();

// --- Status helpers ---
function showSuccess(msg) {
  statusMessage.textContent = msg;
  statusArea.className = "status success";
  statusArea.style.display = "block";
}

function showError(msg) {
  statusMessage.textContent = msg;
  statusArea.className = "status error";
  statusArea.style.display = "block";
}
