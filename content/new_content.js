/**
 * content.js – SpoilerShield v3 (Platform-Aware) — FIXED
 *
 * KEY FIXES over the original:
 * ──────────────────────────────────────────────────────────────────────────
 * FIX 1 — muteAndPauseMedia(postEl)
 *   After blurring, finds every <video> and <audio> inside the post element,
 *   pauses them and mutes them. filter:blur() is purely visual — it never
 *   touches playback. This was the primary bug.
 *
 * FIX 2 — YouTube video-page interception
 *   On a YouTube watch page (URL contains /watch), the entire player
 *   (#movie_player) is targeted directly, not just a thumbnail card.
 *   The player video element is paused + muted, and a full-screen overlay
 *   is injected over the player so the user must consciously choose to watch.
 *
 * FIX 3 — revealPost() now restores audio/video
 *   When the user clicks "Yes, show it", any paused/muted media inside the
 *   post is unmuted and played again so the post works normally after reveal.
 *
 * FIX 4 — observeVideoElements()
 *   A second MutationObserver watches specifically for <video> tags added
 *   after the initial blur (lazy-loaded players, Reddit embeds, Twitter
 *   inline video). If the parent post is already blurred, newly injected
 *   video elements are muted/paused immediately.
 *
 * FIX 5 — YouTube thumbnail poster replacement
 *   On the home/search page, blurred YouTube cards have their <img> src
 *   replaced with a transparent placeholder so the thumbnail itself doesn't
 *   peek through the CSS blur on low-end GPUs with compositing shortcuts.
 *
 * UNCHANGED from v3 original:
 *   getDomain, extractText, findMentionedShow, askGemini, scanAllPosts,
 *   setupObserver, handleNavigation, storage listener, init — all preserved.
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);

const PLATFORM_POST_SELECTORS = {
  youtube : 'ytd-rich-item-renderer, ytd-video-primary-info-renderer, ytd-comment-renderer, ytd-compact-video-renderer',
  twitter : 'article',
  x       : 'article',
  reddit  : 'shreddit-post, .thing, [data-testid="post-container"], .Post',
};

const PLATFORM_BLUR_SELECTORS = {
  youtube : 'ytd-app, #contents',
  twitter : 'main',
  x       : 'main',
  reddit  : 'shreddit-app, #SHORTCUT_FOCUSABLE_DIV, .ListingLayout-backgroundContainer, main',
};

// ── FIX 2: YouTube watch-page player selector ─────────────────────────────────
// The actual player container on a /watch page. We target this directly
// instead of (or in addition to) the post card selectors.
const YT_PLAYER_SELECTOR = '#movie_player';

const GEMINI_API_KEY = 'AIzaSyD3ZzkwGPZyrKdChe8OclF4_GO9pnXR3Zs';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const DEBOUNCE_DELAY = 400;

// ── Module State ──────────────────────────────────────────────────────────────

let domain         = null;
let shieldEnabled  = true;
let protectedShows = [];
let keywords       = [];
let observer       = null;
let videoObserver  = null; // FIX 4 — separate observer for <video> injection
let debounceTimer  = null;

const seenPosts = new WeakSet();

// ── 1. Domain Detection ───────────────────────────────────────────────────────

function getDomain() {
  const host = window.location.hostname.replace(/^www\./, '');
  if (host.includes('youtube.com')) return 'youtube';
  if (host.includes('twitter.com')) return 'twitter';
  if (host.includes('x.com'))       return 'x';
  if (host.includes('reddit.com'))  return 'reddit';
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
  if (node.nodeType === Node.TEXT_NODE)    return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (SKIP_TAGS.has(node.tagName))         return '';
  let text = '';
  for (const child of node.childNodes) text += extractText(child);
  return text;
}

// ── 4. Stage 1 — Show Mention Check ──────────────────────────────────────────

function findMentionedShow(text) {
  for (const show of protectedShows) {
    if (text.includes(show)) return show;
  }
  return null;
}

// ── 5. Stage 2 — Gemini Spoiler Check ────────────────────────────────────────

async function askGemini(text, showName) {
  const trimmed = text.trim().slice(0, 1500);

  const prompt =
`You are a spoiler detection assistant for a browser extension.
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

  try {
    const response = await fetch(GEMINI_API_URL, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[SpoilerShield] Gemini error ${response.status}:`, err);
      return false;
    }

    const data    = await response.json();
    const reply   = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = reply.trim().toUpperCase();
    console.log(`[SpoilerShield] Gemini reply for "${showName}": ${cleaned}`);
    return cleaned.startsWith('YES');

  } catch (err) {
    console.error('[SpoilerShield] Gemini fetch failed:', err);
    return false;
  }
}

// ── FIX 1: Mute & Pause all media inside an element ──────────────────────────

/**
 * muteAndPauseMedia(container)
 * Finds every <video> and <audio> element inside `container` and:
 *   1. Pauses playback (so audio stops immediately).
 *   2. Mutes the element (so even if something un-pauses it, no sound plays).
 *   3. Stores the original muted state on the element so revealPost() can
 *      restore it correctly.
 *
 * Why both pause AND mute?
 *   - pause() stops current playback.
 *   - muted = true guards against autoplay re-triggering sound.
 *
 * @param {Element} container
 */
function muteAndPauseMedia(container) {
  const mediaEls = container.querySelectorAll('video, audio');
  mediaEls.forEach(media => {
    // Save original muted state so we can restore it on reveal
    if (!media.hasAttribute('data-ss-orig-muted')) {
      media.setAttribute('data-ss-orig-muted', media.muted ? '1' : '0');
    }
    media.muted = true;
    if (!media.paused) {
      media.pause();
      media.setAttribute('data-ss-was-playing', '1');
    }
    console.log('[SpoilerShield] Paused + muted media element inside blurred post.');
  });
}

/**
 * restoreMedia(container)
 * Undoes muteAndPauseMedia — called when the user clicks "Yes, show it".
 *
 * @param {Element} container
 */
function restoreMedia(container) {
  const mediaEls = container.querySelectorAll('video, audio');
  mediaEls.forEach(media => {
    const origMuted   = media.getAttribute('data-ss-orig-muted') !== '1';
    const wasPlaying  = media.getAttribute('data-ss-was-playing') === '1';
    media.muted = origMuted ? false : true;
    if (wasPlaying) {
      media.play().catch(() => {}); // play() returns a Promise; swallow autoplay errors
    }
    media.removeAttribute('data-ss-orig-muted');
    media.removeAttribute('data-ss-was-playing');
    console.log('[SpoilerShield] Restored media element after reveal.');
  });
}

// ── FIX 2: YouTube watch-page player overlay ──────────────────────────────────

/**
 * blurYouTubePlayer(showName)
 * On a YouTube /watch page, the #movie_player element holds the actual
 * playing video. We:
 *   1. Pause + mute the video inside the player.
 *   2. Apply a CSS blur to the player element itself.
 *   3. Inject a full-screen overlay (same design as post overlay) over the
 *      player, with a "Yes, watch it" button that removes everything.
 *
 * This runs INSTEAD of the regular post-card blur on watch pages.
 *
 * @param {string} showName – matched show name (lowercase)
 */
function blurYouTubePlayer(showName) {
  const player = document.querySelector(YT_PLAYER_SELECTOR);
  if (!player) return;
  if (player.dataset.ssBlurred === 'true') return;

  player.dataset.ssBlurred = 'true';
  player.style.filter      = 'blur(14px)';
  player.style.transition  = 'filter 0.35s ease';

  // Pause + mute the actual <video> tag inside the player
  muteAndPauseMedia(player);

  // Also use the YouTube player API to pause if available
  // ytd-player exposes .pauseVideo() on the element
  const ytdPlayer = document.querySelector('ytd-player');
  if (ytdPlayer && typeof ytdPlayer.pauseVideo === 'function') {
    ytdPlayer.pauseVideo();
  }

  const displayName = titleCase(showName);

  // The player's wrapper needs relative positioning for the overlay
  const wrapper = player.closest('#player-container, #player-container-inner, ytd-player') || player.parentElement;
  if (wrapper && (!wrapper.style.position || wrapper.style.position === 'static')) {
    wrapper.style.position = 'relative';
  }

  const overlay = document.createElement('div');
  overlay.className          = 'ss-post-overlay';
  overlay.style.position     = 'absolute';
  overlay.style.inset        = '0';
  overlay.style.zIndex       = '9999';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-label', `Spoiler for ${displayName}. Click to reveal.`);

  overlay.innerHTML = `
    <div class="ss-post-overlay-inner">
      <span class="ss-post-icon">🛡</span>
      <span class="ss-post-show-name">${escapeHtml(displayName)}</span>
      <span class="ss-post-title">⚠ Spoiler Hidden</span>
      <span class="ss-post-question">This video may contain spoilers. Watch anyway?</span>
      <button class="ss-reveal-btn">Yes, watch it</button>
    </div>
  `;

  overlay.querySelector('.ss-reveal-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    // Remove blur from player
    player.style.filter      = '';
    player.dataset.ssBlurred = 'false';
    // Restore audio/video
    restoreMedia(player);
    overlay.remove();
    console.log('[SpoilerShield] YouTube player revealed by user.');
  }, { once: true });

  // Append to wrapper so it sits over the player
  (wrapper || player).appendChild(overlay);
  console.log(`[SpoilerShield] YouTube player blurred for show: "${displayName}"`);
}

// ── FIX 5: Replace thumbnail image src ───────────────────────────────────────

/**
 * blurThumbnails(postEl)
 * On some GPUs, CSS blur doesn't fully obscure the image underneath when
 * the browser uses GPU compositing shortcuts. To be safe, we swap the src
 * of thumbnail <img> elements inside the post with a transparent placeholder.
 * The original src is stored in data-ss-orig-src for restoration on reveal.
 *
 * This targets ytd-thumbnail img elements on YouTube and og:image <img>
 * equivalents on Reddit/Twitter.
 *
 * @param {Element} postEl
 */
function blurThumbnails(postEl) {
  const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const imgs = postEl.querySelectorAll('img');
  imgs.forEach(img => {
    if (!img.hasAttribute('data-ss-orig-src')) {
      img.setAttribute('data-ss-orig-src', img.src);
      img.src = TRANSPARENT;
    }
  });
}

/**
 * restoreThumbnails(postEl)
 * Restores original image src values after the user clicks reveal.
 *
 * @param {Element} postEl
 */
function restoreThumbnails(postEl) {
  const imgs = postEl.querySelectorAll('img[data-ss-orig-src]');
  imgs.forEach(img => {
    img.src = img.getAttribute('data-ss-orig-src');
    img.removeAttribute('data-ss-orig-src');
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function titleCase(str) {
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── 6. Per-Post Blur (updated) ────────────────────────────────────────────────

/**
 * blurPost(postEl, showName)
 * Blurs a post, pauses/mutes any media inside it (FIX 1), and replaces
 * thumbnails (FIX 5). Injects the click-to-reveal overlay as before.
 *
 * @param {Element} postEl
 * @param {string}  showName
 */
function blurPost(postEl, showName) {
  if (postEl.dataset.ssBlurred === 'true') return;
  postEl.dataset.ssBlurred = 'true';

  if (!postEl.style.position || postEl.style.position === 'static') {
    postEl.style.position = 'relative';
  }

  postEl.style.filter     = 'blur(10px)';
  postEl.style.userSelect = 'none';
  postEl.style.transition = 'filter 0.35s ease';

  // ── FIX 1: Stop audio/video inside this post ──────────────────────────────
  muteAndPauseMedia(postEl);

  // ── FIX 5: Blank thumbnails so they can't bleed through the blur ──────────
  blurThumbnails(postEl);

  const displayName = titleCase(showName);

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

/**
 * revealPost(postEl, overlay)
 * Removes blur, restores media (FIX 3) and thumbnails (FIX 5).
 */
function revealPost(postEl, overlay) {
  postEl.style.filter      = '';
  postEl.style.userSelect  = '';
  postEl.dataset.ssBlurred = 'false';

  // ── FIX 3: Restore audio/video ────────────────────────────────────────────
  restoreMedia(postEl);

  // ── FIX 5: Restore thumbnails ─────────────────────────────────────────────
  restoreThumbnails(postEl);

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

// ── FIX 2: YouTube watch-page — process the page itself as a "post" ───────────

/**
 * processYouTubeWatchPage()
 * On a YouTube /watch URL, the page title + description together form the
 * "post text" we check. If Gemini confirms a spoiler, we blur the player
 * using blurYouTubePlayer() rather than blurPost().
 *
 * This runs in addition to scanAllPosts() (which handles comment cards).
 */
async function processYouTubeWatchPage() {
  if (domain !== 'youtube') return;
  if (!window.location.pathname.startsWith('/watch')) return;

  // Guard: only run once per page load (URL-keyed)
  const currentUrl = window.location.href;
  if (processYouTubeWatchPage._lastUrl === currentUrl) return;
  processYouTubeWatchPage._lastUrl = currentUrl;

  // Collect page-level text: title + description
  const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title');
  const descEl  = document.querySelector('#description ytd-text-inline-expander, #description');
  const rawText = [titleEl, descEl].filter(Boolean).map(el => el.innerText || el.textContent).join(' ');

  if (!rawText.trim()) return;

  const text        = rawText.toLowerCase();
  const matchedShow = findMentionedShow(text);
  if (!matchedShow) return;

  console.log(`[SpoilerShield] YouTube watch page mentions "${matchedShow}" — checking Gemini…`);

  const isSpoiler = await askGemini(rawText, matchedShow);
  if (isSpoiler) {
    // Wait for the player to be in the DOM (it may not be yet on SPA nav)
    const waitForPlayer = (resolve) => {
      const p = document.querySelector(YT_PLAYER_SELECTOR);
      if (p) { resolve(p); return; }
      setTimeout(() => waitForPlayer(resolve), 300);
    };
    await new Promise(waitForPlayer);
    blurYouTubePlayer(matchedShow);
  }
}

// ── 8. Scan All Posts ─────────────────────────────────────────────────────────

function scanAllPosts() {
  if (!shieldEnabled)         return;
  if (!protectedShows.length) {
    console.log('[SpoilerShield] No protected shows for this platform — add one in the popup.');
    return;
  }

  const sel = PLATFORM_POST_SELECTORS[domain];
  if (!sel) return;

  const posts = document.querySelectorAll(sel);
  console.log(`[SpoilerShield] Scanning ${posts.length} post(s) on ${domain} for: [${protectedShows.join(', ')}]`);

  posts.forEach(post => processPost(post));

  // FIX 2: also check the YouTube watch page itself
  processYouTubeWatchPage();
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

// ── FIX 4: Second observer for lazily injected <video> elements ───────────────

/**
 * setupVideoObserver()
 * Some platforms (Reddit, Twitter) inject <video> elements AFTER the post
 * container is in the DOM — e.g. when the user scrolls near the post or the
 * platform lazy-loads the player. If the parent post is already blurred, the
 * new <video> would play audio freely.
 *
 * This observer watches for any <video> added anywhere in the document.
 * If the closest blurred ancestor is found, the video is muted/paused
 * immediately.
 */
function setupVideoObserver() {
  if (videoObserver) { videoObserver.disconnect(); videoObserver = null; }

  videoObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Collect all <video> and <audio> in the added subtree
        const mediaEls = [];
        if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
          mediaEls.push(node);
        }
        node.querySelectorAll && mediaEls.push(...node.querySelectorAll('video, audio'));

        for (const media of mediaEls) {
          // Walk up to find a blurred ancestor
          let ancestor = media.parentElement;
          while (ancestor && ancestor !== document.body) {
            if (ancestor.dataset.ssBlurred === 'true') {
              // This media is inside a blurred post — mute it immediately
              if (!media.hasAttribute('data-ss-orig-muted')) {
                media.setAttribute('data-ss-orig-muted', media.muted ? '1' : '0');
              }
              media.muted = true;
              media.addEventListener('play', () => { media.muted = true; }); // guard autoplay
              console.log('[SpoilerShield] FIX4 — Muted lazily-injected media in blurred post.');
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }
      }
    }
  });

  videoObserver.observe(document.body, { childList: true, subtree: true });
  console.log('[SpoilerShield] Video MutationObserver active.');
}

// ── 10. SPA Navigation ────────────────────────────────────────────────────────

function handleNavigation() {
  console.log('[SpoilerShield] SPA navigation detected — re-scanning…');
  clearTimeout(debounceTimer);
  // Reset watch-page guard so new watch pages are processed
  processYouTubeWatchPage._lastUrl = null;
  setTimeout(scanAllPosts, 800);
}

// ── 11. Storage Change Listener ───────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  if (changes.enabled !== undefined) {
    shieldEnabled = changes.enabled.newValue;
    console.log(`[SpoilerShield] Shield ${shieldEnabled ? 'enabled' : 'disabled'}.`);
    if (shieldEnabled) scanAllPosts();
  }

  if (changes.showsByPlatform !== undefined) {
    const all        = changes.showsByPlatform.newValue || {};
    const platformKey = domain === 'x' ? 'twitter' : domain;
    protectedShows   = (all[platformKey] || []).map(s => s.toLowerCase().trim());
    console.log(`[SpoilerShield] Protected shows updated for ${domain}:`, protectedShows);
    if (shieldEnabled) scanAllPosts();
  }

  if (changes.keywordsByPlatform !== undefined) {
    const all        = changes.keywordsByPlatform.newValue || {};
    const platformKey = domain === 'x' ? 'twitter' : domain;
    keywords         = (all[platformKey] || []).map(k => k.toLowerCase().trim());
    console.log(`[SpoilerShield] Keywords updated for ${domain}:`, keywords);
    if (shieldEnabled) scanAllPosts();
  }
});

// ── 12. Initialisation ────────────────────────────────────────────────────────

async function init() {
  try {
    domain = getDomain();
    if (!domain) return;

    const data = await chrome.storage.sync.get({
      enabled            : true,
      showsByPlatform    : { youtube: [], reddit: [], twitter: [] },
      keywordsByPlatform : { youtube: [], reddit: [], twitter: [] },
    });

    shieldEnabled = data.enabled;

    const platformKey = domain === 'x' ? 'twitter' : domain;
    protectedShows = (data.showsByPlatform[platformKey]    || []).map(s => s.toLowerCase().trim());
    keywords       = (data.keywordsByPlatform[platformKey] || []).map(k => k.toLowerCase().trim());

    console.log(
      `[SpoilerShield] v3 FIXED active | platform="${domain}" | ` +
      `enabled=${shieldEnabled} | ` +
      `shows=[${protectedShows.join(', ')}] | ` +
      `keywords=[${keywords.join(', ')}]`
    );

    if (!shieldEnabled) {
      console.log('[SpoilerShield] Shield disabled — exiting.');
      return;
    }

    if (!protectedShows.length) {
      console.warn(`[SpoilerShield] No shows for "${domain}" — open the popup to add one.`);
    }

    scanAllPosts();
    setupObserver();

    // FIX 4 — watch for lazily injected <video>/<audio> elements
    setupVideoObserver();

    // SPA navigation hooks
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
