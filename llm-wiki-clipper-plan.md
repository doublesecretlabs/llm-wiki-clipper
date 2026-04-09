# LLM Wiki Web Clipper — Chrome Extension Project Plan

## Overview

A Chrome extension that clips web pages as clean markdown and saves them **directly to a Google Drive folder** — no local sync required. Designed to feed into an LLM Wiki `raw/` layer from any machine.

---

## Goals

- Clip any web page to clean markdown with one click
- Save directly to a designated Google Drive folder via the Drive API (no local filesystem dependency)
- Work from any machine — just install the extension and authenticate
- Strip noise (ads, nav, sidebars) and preserve meaningful content
- Optionally save images locally to Drive alongside the markdown file
- Lightweight, no backend server required

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Extension framework | Chrome Manifest V3 | Current standard, required for Chrome Web Store |
| Auth | Google OAuth 2.0 (chrome.identity API) | Native Chrome extension auth, no backend needed |
| Drive integration | Google Drive REST API v3 | Write files directly to a folder |
| Content extraction | Readability.js (Mozilla) | Battle-tested article extraction, strips clutter |
| HTML → Markdown | Turndown.js | Clean, configurable HTML to markdown conversion |
| Storage (settings) | chrome.storage.sync | Persist target folder ID and preferences across machines |

---

## Architecture

```
[Web Page]
    │
    ▼
[Content Script]
    │  Extracts page DOM using Readability.js
    │  Converts to markdown via Turndown.js
    ▼
[Background Service Worker]
    │  Receives markdown + metadata
    │  Authenticates via chrome.identity (OAuth)
    │  Calls Google Drive API to write file
    ▼
[Google Drive — raw/ folder]
    │
    ▼
[LLM Wiki Agent reads from Drive]
```

---

## File Structure

```
llm-wiki-clipper/
├── manifest.json               # Manifest V3 config, OAuth scopes
├── background/
│   └── service-worker.js       # Drive API calls, OAuth token handling
├── content/
│   └── content-script.js       # Page extraction (Readability + Turndown)
├── popup/
│   ├── popup.html              # Extension popup UI
│   ├── popup.js                # Clip button logic, status display
│   └── popup.css               # Popup styles
├── options/
│   ├── options.html            # Settings page
│   ├── options.js              # Save folder ID, preferences
│   └── options.css
├── lib/
│   ├── readability.js          # Mozilla Readability (bundled)
│   └── turndown.js             # Turndown HTML→MD (bundled)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## manifest.json — Key Config

```json
{
  "manifest_version": 3,
  "name": "LLM Wiki Clipper",
  "version": "1.0.0",
  "description": "Clip web pages as markdown directly to Google Drive for LLM Wiki ingestion",
  "permissions": [
    "identity",
    "storage",
    "activeTab",
    "scripting"
  ],
  "oauth2": {
    "client_id": "YOUR_GOOGLE_CLIENT_ID",
    "scopes": [
      "https://www.googleapis.com/auth/drive.file"
    ]
  },
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": "icons/icon48.png"
  },
  "options_page": "options/options.html",
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["lib/readability.js", "lib/turndown.js", "content/content-script.js"],
      "run_at": "document_idle"
    }
  ]
}
```

> **Note:** Use `drive.file` scope (not `drive`) — it only grants access to files the extension itself creates, which is safer and easier to get approved.

---

## Core Flows

### 1. Authentication Flow
1. User clicks extension icon for the first time
2. `chrome.identity.getAuthToken()` triggers Google OAuth consent screen
3. Token stored in memory by Chrome — auto-refreshed
4. No backend or server needed

### 2. First-Time Setup Flow
1. User opens Options page
2. Clicks "Select Drive Folder" — triggers a Drive folder picker (or manual folder ID entry)
3. Folder ID saved to `chrome.storage.sync` (syncs across machines with same Chrome profile)

### 3. Clip Flow
1. User is on a web page, clicks extension icon
2. Popup appears with page title pre-filled, editable
3. User clicks "Clip to Drive"
4. Content script runs Readability on the page DOM → extracts clean article content
5. Turndown converts HTML → markdown
6. Frontmatter is prepended (see below)
7. Background service worker posts file to Drive API in target folder
8. Popup shows success with link to the file in Drive

### 4. Cross-Machine Flow
- Extension installed on Machine B
- User signs in with same Google account
- `chrome.storage.sync` restores the saved folder ID automatically
- Ready to clip immediately — no re-configuration needed

---

## Markdown Output Format

Each clipped file is saved as `YYYY-MM-DD-page-title-slug.md` with frontmatter:

```markdown
---
title: "How Transformers Work"
url: "https://example.com/transformers"
clipped: "2026-04-08"
tags: []
source_type: web_clip
---

# How Transformers Work

[clean article content here...]
```

This format drops directly into the LLM Wiki `raw/` layer with provenance intact.

---

## Google Drive API — Write File

```javascript
// background/service-worker.js

async function saveFileToDrive(filename, markdownContent, folderId, token) {
  const metadata = {
    name: filename,
    mimeType: "text/markdown",
    parents: [folderId]
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", new Blob([markdownContent], { type: "text/markdown" }));

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form
    }
  );

  return response.json(); // Returns file id, name, webViewLink
}
```

---

## Options / Settings

| Setting | Description |
|---|---|
| Target folder ID | Google Drive folder to save clips into |
| Default tags | Pre-populate frontmatter tags (e.g. `web_clip, research`) |
| Include images | Whether to also upload page images to Drive |
| Filename format | Date-first slug (default) or custom pattern |
| Strip elements | Additional CSS selectors to strip before conversion |

---

## Setup Steps for Development

```bash
# 1. Clone / create project folder
mkdir llm-wiki-clipper && cd llm-wiki-clipper

# 2. Download dependencies (bundle locally — no build step needed for V1)
# - Readability.js: https://github.com/mozilla/readability
# - Turndown.js: https://github.com/mixmark-io/turndown

# 3. Create Google Cloud project
#    - Enable Google Drive API
#    - Create OAuth 2.0 Client ID (Chrome Extension type)
#    - Add your extension ID to allowed origins

# 4. Load unpacked extension in Chrome
#    chrome://extensions → Developer mode → Load unpacked

# 5. Test on a few pages before packaging
```

---

## Google Cloud Console Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create new project: `llm-wiki-clipper`
3. Enable **Google Drive API**
4. Create credentials → OAuth 2.0 Client ID → **Chrome Extension**
5. Paste your extension ID (from `chrome://extensions`)
6. Copy the Client ID into `manifest.json`

---

## V1 Scope (Keep it Simple)

- [x] OAuth login with Google
- [x] Clip page to clean markdown
- [x] Save directly to a configured Drive folder
- [x] Editable title before saving
- [x] Frontmatter with URL + date
- [x] Success/error feedback in popup
- [x] Options page to set target folder

## V2 Ideas (Post-MVP)

- [ ] Folder picker UI (browse Drive folders visually)
- [ ] Highlight-to-clip (select text, right-click → clip selection only)
- [ ] Tag input in popup before saving
- [ ] Upload referenced images to Drive alongside markdown
- [ ] Clip history in popup (last 10 clips with Drive links)
- [ ] Auto-trigger LLM Wiki compilation via webhook after clip

---

## Notes

- `drive.file` scope is intentional — the extension only sees files it creates, not your entire Drive. This is the right permission for a Web Store submission.
- No backend server is needed at any point — auth, storage, and Drive writes all happen client-side via Chrome APIs.
- The output markdown is intentionally simple and raw — the LLM Wiki agent handles the compilation step, not the clipper.
