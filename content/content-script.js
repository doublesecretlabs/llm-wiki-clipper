// Content script — extracts page content using Readability and converts to Markdown via Turndown

function createTurndownService() {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*"
  });

  // Remove empty links, but preserve links that contain images
  turndown.addRule("removeEmptyLinks", {
    filter: (node) =>
      node.nodeName === "A" &&
      (!node.textContent || !node.textContent.trim()) &&
      !node.querySelector("img"),
    replacement: () => ""
  });

  return turndown;
}

function extractImageUrls(htmlContent) {
  const container = document.createElement("div");
  container.innerHTML = htmlContent;
  const images = container.querySelectorAll("img[src]");
  const urls = [];
  for (const img of images) {
    const src = img.src;
    // Only include absolute http(s) URLs
    if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
      urls.push(src);
    }
  }
  // Deduplicate
  return [...new Set(urls)];
}

function extractContent() {
  // Clone the document so Readability doesn't mutate the live page
  const docClone = document.cloneNode(true);

  const article = new Readability(docClone).parse();

  if (!article || !article.content) {
    return null;
  }

  const turndown = createTurndownService();
  const markdown = turndown.turndown(article.content);
  const imageUrls = extractImageUrls(article.content);

  return {
    title: article.title || document.title,
    markdown: markdown,
    excerpt: article.excerpt || "",
    imageUrls: imageUrls
  };
}

function extractSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;

  const container = document.createElement("div");
  for (let i = 0; i < sel.rangeCount; i++) {
    container.appendChild(sel.getRangeAt(i).cloneContents());
  }

  const html = container.innerHTML;
  const turndown = createTurndownService();
  const markdown = turndown.turndown(html);
  const imageUrls = extractImageUrls(html);

  return {
    title: document.title,
    markdown: markdown,
    excerpt: "",
    imageUrls: imageUrls
  };
}

// Listen for extraction requests from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "extract") {
    try {
      const result = extractContent();
      sendResponse({ success: true, data: result });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }
  if (message.action === "extractSelection") {
    try {
      const result = extractSelection();
      sendResponse({ success: true, data: result });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }
  return true;
});
