const folderIdInput = document.getElementById("folder-id");
const folderNameEl = document.getElementById("folder-name");
const defaultTagsInput = document.getElementById("default-tags");
const saveBtn = document.getElementById("save-btn");
const status = document.getElementById("status");

// Picker elements
const browseBtn = document.getElementById("browse-btn");
const picker = document.getElementById("picker");
const pickerBack = document.getElementById("picker-back");
const pickerPath = document.getElementById("picker-path");
const pickerClose = document.getElementById("picker-close");
const pickerList = document.getElementById("picker-list");
const pickerSelect = document.getElementById("picker-select");

// Picker state
let navStack = []; // [{ id, name }]
let currentFolder = { id: "root", name: "My Drive" };

// Load saved settings
chrome.storage.sync.get(
  { folderId: "", folderName: "", defaultTags: "" },
  (settings) => {
    folderIdInput.value = settings.folderId;
    defaultTagsInput.value = settings.defaultTags;
    if (settings.folderName) {
      folderNameEl.textContent = settings.folderName;
    }
  }
);

saveBtn.addEventListener("click", () => {
  const folderId = folderIdInput.value.trim();
  const defaultTags = defaultTagsInput.value.trim();
  const folderName = folderNameEl.textContent || "";

  if (!folderId) {
    showStatus("Please select a Drive folder.", "error");
    return;
  }

  chrome.storage.sync.set({ folderId, defaultTags, folderName }, () => {
    showStatus("Settings saved.", "success");
  });
});

// --- Folder picker ---

browseBtn.addEventListener("click", () => {
  navStack = [];
  currentFolder = { id: "root", name: "My Drive" };
  picker.style.display = "block";
  loadFolders("root");
});

pickerClose.addEventListener("click", () => {
  picker.style.display = "none";
});

pickerBack.addEventListener("click", () => {
  if (navStack.length === 0) return;
  currentFolder = navStack.pop();
  updatePickerHeader();
  loadFolders(currentFolder.id);
});

pickerSelect.addEventListener("click", () => {
  if (currentFolder.id === "root") {
    showStatus("Navigate into a folder first.", "error");
    return;
  }
  folderIdInput.value = currentFolder.id;
  folderNameEl.textContent = currentFolder.name;
  picker.style.display = "none";
});

function updatePickerHeader() {
  pickerPath.textContent = currentFolder.name;
  pickerBack.disabled = navStack.length === 0;
}

function loadFolders(parentId) {
  pickerList.innerHTML = '<p class="picker-loading">Loading...</p>';
  updatePickerHeader();

  chrome.runtime.sendMessage(
    { action: "listFolders", parentId },
    (response) => {
      if (!response || !response.success) {
        pickerList.innerHTML = `<p class="empty-msg">Error: ${response?.error || "unknown"}</p>`;
        return;
      }

      const folders = response.folders;
      if (folders.length === 0) {
        pickerList.innerHTML = '<p class="empty-msg">No subfolders</p>';
        return;
      }

      pickerList.innerHTML = "";
      for (const folder of folders) {
        const item = document.createElement("button");
        item.className = "folder-item";
        item.innerHTML = `<span class="folder-icon">\uD83D\uDCC1</span><span>${escapeHtml(folder.name)}</span>`;
        item.addEventListener("click", () => {
          navStack.push(currentFolder);
          currentFolder = { id: folder.id, name: folder.name };
          loadFolders(folder.id);
        });
        pickerList.appendChild(item);
      }
    }
  );
}

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function showStatus(msg, type) {
  status.textContent = msg;
  status.className = type;
  status.style.display = "block";
  setTimeout(() => {
    status.style.display = "none";
  }, 3000);
}
