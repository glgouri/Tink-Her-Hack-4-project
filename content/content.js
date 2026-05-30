/**
 * content.js – SpoilerShield v3 (Platform-Aware, Fixed)
 *
 * Fixes:
 * 1. Whole-word keyword matching to reduce false positives.
 * 2. Ignore cross-origin iframes to prevent storage access errors.
 * 3. Updated YouTube selectors for home, trending, search, and comments.
 * 4. Preserves existing platform-aware blur and Gemini integration.
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);

const PLATFORM_POST_SELECTORS = {
  youtube: `
    ytd-rich-grid-media,           /* Home / Recommendations */
    ytd-video-renderer,            /* Search results */
    ytd-compact-video-renderer,    /* Small video tiles / trending */
    ytd-comment-thread-renderer    /* Video comments */
  `,
  twitter: 'article',
  x: 'article',
  reddit: 'shreddit-post, .thing, [data-testid="post-container"], .Post',
};

const PLATFORM_BLUR_SELECTORS = {
  youtube: `
    ytd-app,           /* Main YouTube app container */
    #contents,         /* Home / video content container */
    #primary,          /* Video page main section */
    #comments          /* Video page comments section */
  `,
  twitter: 'main',
  x: 'main',
  reddit: 'shreddit-app, #SHORTCUT_FOCUSABLE_DIV, .ListingLayout-backgroundContainer, main',
};

// ── Gemini API ────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = 'YOUR_NEW_API_KEY_HERE';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const DEBOUNCE_DELAY = 400; // ms

// ── Module State ──────────────────────────────────────────────────────────────
let domain = null;
let shieldEnabled = true;
let protectedShows = [];
let keywords = [];
let observer = null;
let debounceTimer = null;

const seenPosts = new WeakSet();

// ── 1. Domain Detection ───────────────────────────────────────────────────────
function getDomain() {
  const host = window.location.hostname.replace(/^www\./, '');
  if (host.includes('youtube.com')) return 'youtube';
  if (host.includes('twitter.com')) return 'twitter';
  if (host.includes('x.com')) return 'x';
  if (host.includes('reddit.com')) return 'reddit';
  return null;
}

// ── 2. Content Root ───────────────────────────────────────────────────────────
function getContentRoot() {
  const selectors = (PLATFORM_BLUR_SELECTORS[domain] || '').split(',').map(s => s.trim());
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body;
}

// ── 3. Text Extraction ────────────────────────────────────────────────────────
function extractText(node) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (SKIP_TAGS.has(node.tagName)) return '';
  if (node.tagName === 'IFRAME') return ''; // Ignore inaccessible iframes

  let text = '';
  for (const child of node.childNodes) text += extractText(child);
  return text;
}

// ── 4. Stage 1 — Show Mention Check ──────────────────────────────────────────
function findMentionedShow(text) {
  for (const show of protectedShows) {
    const regex = new RegExp(`\\b${show.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'); // whole-word match
    if (regex.test(text)) return show;
  }
  return null;
}

// ── 5. Stage 2 — Gemini Spoiler Check ────────────────────────────────────────
async function askGemini(text, showName) {
  const trimmed = text.trim().slice(0, 1500);

  const prompt = `You are a spoiler detection assistant for a browser extension.
The user has NOT yet watched "${showName}" and wants to avoid spoilers.
Analyze the following text and decide: does it reveal spoilers about "${showName}"?
A spoiler includes: character deaths, plot twists, season or series endings,
villain reveals, relationship outcomes, or any major story event.

Reply with ONE word only:
- YES if the text contains spoilers about "${showName}"
- NO  if it does not

Do not explain. Do not add punctuation. One word only.

Text:
${trimmed}`;

  console.log(`[SpoilerShield] Asking Gemini about "${showName}"…`);
  console.log('[SpoilerShield] Text sent to Gemini:', trimmed);

  try {
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[SpoilerShield] Gemini error ${response.status}:`, err);
      return false;
    }

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = reply.trim().toUpperCase();
    console.log(`[SpoilerShield] Gemini reply for "${showName}": ${cleaned}`);
    return cleaned.startsWith('YES');
  } catch (err) {
    console.error('[SpoilerShield] Gemini fetch failed:', err);
    return false;
  }
}

// ── 6. Per-Post Blur ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function blurPost(postEl, showName) {
  if (postEl.dataset.ssBlurred === 'true') return;
  postEl.dataset.ssBlurred = 'true';

  if (!postEl.style.position || postEl.style.position === 'static') {
    postEl.style.position = 'relative';
  }

  postEl.style.filter = 'blur(10px)';
  postEl.style.userSelect = 'none';
  postEl.style.transition = 'filter 0.35s ease';

  const displayName = showName
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const overlay = document.createElement('div');
  overlay.className = 'ss-post-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-label', `Spoiler for ${displayName}. Click to reveal.`);

  overlay.innerHTML = `
    <div class="ss-post-overlay-inner">
      <span class="ss-post-icon">🛡</span>
      <span class="ss-post-show-name">${escapeHtml(displayName)}</span>
      <span class="ss-post-title">⚠ Spoiler Hidden</span>
      <span class="ss-post-question">Do you want to see this spoiler?</span>
      <button class="ss-reveal-btn">Yes, show it</button>
    </div>
  `;

  overlay.querySelector('.ss-reveal-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    revealPost(postEl, overlay);
  }, { once: true });

  postEl.appendChild(overlay);
  console.log(`[SpoilerShield] Blurred post for show: "${displayName}"`);
}

function revealPost(postEl, overlay) {
  postEl.style.filter = '';
  postEl.style.userSelect = '';
  postEl.dataset.ssBlurred = 'false';
  overlay.remove();
  console.log('[SpoilerShield] Post revealed by user.');
}

// ── 7. Process a Single Post ──────────────────────────────────────────────────
async function processPost(postEl) {
  if (seenPosts.has(postEl)) return;
  seenPosts.add(postEl);

  const rawText = extractText(postEl).trim();
  if (!rawText) return;

  const text = rawText.toLowerCase();
  const matchedShow = findMentionedShow(text);
  if (!matchedShow) return;

  console.log(`[SpoilerShield] Post mentions "${matchedShow}" on ${domain} — checking with Gemini…`);
  const isSpoiler = await askGemini(rawText, matchedShow);
  if (isSpoiler) {
    blurPost(postEl, matchedShow);
  } else {
    console.log(`[SpoilerShield] Gemini: not a spoiler for "${matchedShow}".`);
  }
}

// ── 8. Scan All Posts ─────────────────────────────────────────────────────────
function scanAllPosts() {
  if (!shieldEnabled) return;
  if (!protectedShows.length) {
    console.log('[SpoilerShield] No protected shows for this platform.');
    return;
  }

  const sel = PLATFORM_POST_SELECTORS[domain];
  if (!sel) return;

  const posts = document.querySelectorAll(sel.split(',').map(s => s.trim()).join(', '));
  console.log(`[SpoilerShield] Scanning ${posts.length} post(s) on ${domain} for: [${protectedShows.join(', ')}]`);

  posts.forEach(post => processPost(post));
}

// ── 9. MutationObserver ───────────────────────────────────────────────────────
function setupObserver() {
  if (observer) { observer.disconnect(); observer = null; }

  observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanAllPosts, DEBOUNCE_DELAY);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  console.log('[SpoilerShield] MutationObserver active.');
}

// ── 10. SPA Navigation ───────────────────────────────────────────────────────
function handleNavigation() {
  console.log('[SpoilerShield] SPA navigation detected — re-scanning…');
  clearTimeout(debounceTimer);
  setTimeout(scanAllPosts, 800);
}

// ── 11. Storage Change Listener ─────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  if (changes.enabled !== undefined) {
    shieldEnabled = changes.enabled.newValue;
    console.log(`[SpoilerShield] Shield ${shieldEnabled ? 'enabled' : 'disabled'}.`);
    if (shieldEnabled) scanAllPosts();
  }

  if (changes.showsByPlatform !== undefined) {
    const all = changes.showsByPlatform.newValue || {};
    const platformKey = domain === 'x' ? 'twitter' : domain;
    protectedShows = (all[platformKey] || []).map(s => s.toLowerCase().trim());
    console.log(`[SpoilerShield] Protected shows updated for ${domain}:`, protectedShows);
    if (shieldEnabled) scanAllPosts();
  }

  if (changes.keywordsByPlatform !== undefined) {
    const all = changes.keywordsByPlatform.newValue || {};
    const platformKey = domain === 'x' ? 'twitter' : domain;
    keywords = (all[platformKey] || []).map(k => k.toLowerCase().trim());
    console.log(`[SpoilerShield] Keywords updated for ${domain}:`, keywords);
    if (shieldEnabled) scanAllPosts();
  }
});

// ── 12. Initialisation ───────────────────────────────────────────────────────
async function init() {
  try {
    domain = getDomain();
    if (!domain) return;

    const data = await chrome.storage.sync.get({
      enabled: true,
      showsByPlatform: { youtube: [], reddit: [], twitter: [] },
      keywordsByPlatform: { youtube: [], reddit: [], twitter: [] },
    });

    shieldEnabled = data.enabled;
    const platformKey = domain === 'x' ? 'twitter' : domain;
    protectedShows = (data.showsByPlatform[platformKey] || []).map(s => s.toLowerCase().trim());
    keywords = (data.keywordsByPlatform[platformKey] || []).map(k => k.toLowerCase().trim());

    console.log(`[SpoilerShield] v3 active | platform="${domain}" | enabled=${shieldEnabled} | shows=[${protectedShows.join(', ')}] | keywords=[${keywords.join(', ')}]`);

    if (!shieldEnabled) {
      console.log('[SpoilerShield] Shield disabled — exiting.');
      return;
    }

    scanAllPosts();
    setupObserver();

    const originalPushState = history.pushState.bind(history);
    history.pushState = function (...args) {
      originalPushState(...args);
      handleNavigation();
    };
    window.addEventListener('popstate', handleNavigation);

  } catch (err) {
    console.error('[SpoilerShield] init() failed:', err);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();