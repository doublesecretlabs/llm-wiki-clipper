// Background service worker — handles Drive API calls, OAuth, context menus, clip history

// --- Context menu for highlight-to-clip ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "clip-selection",
    title: "Clip selection to Drive",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "clip-selection") {
    try {
      // Inject scripts
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["lib/readability.js", "lib/turndown.js", "content/content-script.js"]
        });
      } catch (e) { /* already injected */ }

      // Extract selection from the content script
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) return null;

          const container = document.createElement("div");
          for (let i = 0; i < sel.rangeCount; i++) {
            container.appendChild(sel.getRangeAt(i).cloneContents());
          }

          // Extract image URLs from the selection
          const images = container.querySelectorAll("img[src]");
          const imageUrls = [];
          for (const img of images) {
            const src = img.src;
            if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
              imageUrls.push(src);
            }
          }

          const turndown = new TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
            bulletListMarker: "-",
            emDelimiter: "*"
          });
          return {
            markdown: turndown.turndown(container.innerHTML),
            title: document.title,
            imageUrls: [...new Set(imageUrls)]
          };
        }
      });

      if (!result.result) return;

      const today = new Date().toISOString().slice(0, 10);
      const data = {
        title: result.result.title,
        markdown: result.result.markdown,
        url: tab.url,
        clippedDate: today,
        tags: [],
        imageUrls: result.result.imageUrls || []
      };

      const clipResult = await handleClip(data);

      // Show a badge briefly to indicate success
      chrome.action.setBadgeText({ text: "OK", tabId: tab.id });
      chrome.action.setBadgeBackgroundColor({ color: "#28a745", tabId: tab.id });
      setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 2000);
    } catch (err) {
      chrome.action.setBadgeText({ text: "ERR", tabId: tab.id });
      chrome.action.setBadgeBackgroundColor({ color: "#dc3545", tabId: tab.id });
      setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 3000);
      console.error("Clip selection failed:", err);
    }
  }
});

// --- Message handler ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "clip") {
    handleClip(message.data)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "listFolders") {
    (async () => {
      try {
        const token = await getAuthToken();
        const parentId = message.parentId || "root";
        const query = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&orderBy=name&pageSize=100`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) throw new Error(`Drive API error: ${resp.status}`);
        const data = await resp.json();
        sendResponse({ success: true, folders: data.files || [] });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "getHistory") {
    getClipHistory()
      .then(history => sendResponse({ success: true, history }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// --- Auth ---
async function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

// --- Settings ---
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({
      folderId: "",
      defaultTags: "",
      includeImages: true
    }, resolve);
  });
}

// --- Clip history ---
async function getClipHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ clipHistory: [] }, (data) => resolve(data.clipHistory));
  });
}

async function addToClipHistory(entry) {
  const history = await getClipHistory();
  history.unshift(entry);
  // Keep only last 10
  if (history.length > 10) history.length = 10;
  return new Promise((resolve) => {
    chrome.storage.local.set({ clipHistory: history }, resolve);
  });
}

// --- Main clip handler ---
async function handleClip({ title, markdown, url, clippedDate, tags = [], imageUrls = [] }) {
  const token = await getAuthToken();
  const settings = await getSettings();

  if (!settings.folderId) {
    throw new Error("No Drive folder configured. Please set one in the extension options.");
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  const filename = `${clippedDate}-${slug}.md`;

  // Merge default tags with user-provided tags
  const defaultTags = settings.defaultTags
    ? settings.defaultTags.split(",").map(t => t.trim()).filter(Boolean)
    : [];
  const allTags = [...new Set([...defaultTags, ...tags])];

  // Upload images if enabled and present
  let updatedMarkdown = markdown;
  const uploadedImages = [];
  if (settings.includeImages && imageUrls.length > 0) {
    const imageFolder = await getOrCreateImageFolder(settings.folderId, token);
    for (const imgUrl of imageUrls) {
      try {
        const result = await uploadImageToDrive(imgUrl, imageFolder, token);
        if (result) {
          uploadedImages.push(result);
          // Replace original URL with relative path to images folder
          updatedMarkdown = updatedMarkdown.split(imgUrl).join(`images/${result.name}`);
        }
      } catch (err) {
        console.warn("Failed to upload image:", imgUrl, err);
      }
    }
  }

  const frontmatter = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `url: "${url}"`,
    `clipped: "${clippedDate}"`,
    `tags: [${allTags.map(t => `"${t}"`).join(", ")}]`,
    `source_type: web_clip`,
    uploadedImages.length > 0 ? `images: ${uploadedImages.length}` : null,
    "---",
    "",
  ].filter(Boolean).join("\n");

  const fullMarkdown = frontmatter + updatedMarkdown;

  const file = await saveFileToDrive(filename, fullMarkdown, settings.folderId, token);

  // Save to clip history
  await addToClipHistory({
    title,
    url,
    fileName: file.name,
    fileId: file.id,
    webViewLink: file.webViewLink,
    clippedDate,
    imageCount: uploadedImages.length
  });

  return {
    fileId: file.id,
    fileName: file.name,
    webViewLink: file.webViewLink,
    imageCount: uploadedImages.length
  };
}

// --- Image upload ---
async function getOrCreateImageFolder(parentFolderId, token) {
  // Check if "images" subfolder already exists
  const query = `name='images' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (searchResponse.ok) {
    const data = await searchResponse.json();
    if (data.files && data.files.length > 0) {
      return data.files[0].id;
    }
  }

  // Create the folder
  const metadata = {
    name: "images",
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentFolderId]
  };

  const response = await fetch(
    "https://www.googleapis.com/drive/v3/files?fields=id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(metadata)
    }
  );

  if (!response.ok) {
    throw new Error("Failed to create images folder");
  }

  const folder = await response.json();
  return folder.id;
}

async function uploadImageToDrive(imageUrl, folderId, token) {
  // Download the image
  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) {
    console.warn(`Image fetch failed (${imgResponse.status}): ${imageUrl}`);
    return null;
  }

  const contentType = imgResponse.headers.get("content-type") || "image/png";
  const blob = await imgResponse.arrayBuffer();

  // Extract filename from URL, prefixed with a short hash to avoid duplicates
  const urlPath = new URL(imageUrl).pathname;
  const baseName = urlPath.split("/").pop().split("?")[0] || `image.png`;
  const hashBuf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(imageUrl));
  const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
  const dotIdx = baseName.lastIndexOf(".");
  const imgFilename = dotIdx > 0
    ? `${baseName.slice(0, dotIdx)}-${hashHex}${baseName.slice(dotIdx)}`
    : `${baseName}-${hashHex}`;

  const metadata = {
    name: imgFilename,
    parents: [folderId]
  };

  const boundary = "-------img_boundary_" + Date.now();
  const metadataStr = JSON.stringify(metadata);

  // Build multipart body manually with binary support
  const encoder = new TextEncoder();
  const metaPart = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataStr}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const endPart = encoder.encode(`\r\n--${boundary}--`);

  const body = new Uint8Array(metaPart.length + blob.byteLength + endPart.length);
  body.set(metaPart, 0);
  body.set(new Uint8Array(blob), metaPart.length);
  body.set(endPart, metaPart.length + blob.byteLength);

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body: body
    }
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.warn(`Drive image upload failed (${response.status}): ${imgFilename}`, errText);
    return null;
  }
  return response.json();
}

// --- Save markdown file to Drive ---
async function saveFileToDrive(filename, markdownContent, folderId, token) {
  const metadata = {
    name: filename,
    mimeType: "text/markdown",
    parents: [folderId]
  };

  const boundary = "-------clipper_boundary";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/markdown; charset=UTF-8",
    "",
    markdownContent,
    `--${boundary}--`
  ].join("\r\n");

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body: body
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Drive API error (${response.status}): ${err}`);
  }

  return response.json();
}
