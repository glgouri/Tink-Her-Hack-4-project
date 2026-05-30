'use strict';

const PLATFORMS = ['youtube', 'reddit', 'twitter'];

// Per-platform state
const state = {
  shows: { youtube: [], reddit: [], twitter: [] },
  keywords: { youtube: [], reddit: [], twitter: [] },
};

let statusTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }
function platShort(p) { return p === 'youtube' ? 'yt' : p === 'reddit' ? 'rd' : 'tw'; }

function showStatus(msg, type) {
  type = type || 'saved';
  const bar = document.getElementById('statusBar');
  bar.className = 'status-bar ' + type;
  document.getElementById('statusText').textContent = msg.toUpperCase();
  clearTimeout(statusTimer);
  statusTimer = setTimeout(function () {
    bar.className = 'status-bar';
    document.getElementById('statusText').textContent = 'READY';
  }, 2000);
}

// ── Counts ───────────────────────────────────────────────────────────────────
function updateCounts() {
  var showTotal = 0, kwTotal = 0;
  PLATFORMS.forEach(function (p) {
    var ps = platShort(p);
    var sn = state.shows[p].length;
    var kn = state.keywords[p].length;
    showTotal += sn; kwTotal += kn;
    document.getElementById('show-' + ps + '-count').textContent = sn;
    document.getElementById('kw-' + ps + '-count').textContent = kn;
  });
  document.getElementById('showTotalCount').textContent = showTotal;
  document.getElementById('kwTotalCount').textContent = kwTotal;
}

// ── Render a single platform list ─────────────────────────────────────────────
function renderList(section, plat) {
  var isShows = section === 'shows';
  var listEl = document.getElementById((isShows ? 'show' : 'kw') + '-list-' + plat);
  var items = state[isShows ? 'shows' : 'keywords'][plat];
  var ps = platShort(plat);
  var tagBase = isShows ? 'show-tag' : 'tag';
  var delBase = isShows ? 'show-del' : 'tag-del';

  listEl.innerHTML = '';

  if (!items.length) {
    listEl.innerHTML = '<span class="empty-msg">no entries — add one above</span>';
    updateCounts();
    return;
  }

  items.forEach(function (val, i) {
    var tag = document.createElement('span');
    tag.className = tagBase + ' ' + tagBase + '-' + ps;
    var label = isShows ? ('🎬 ' + escapeHtml(titleCase(val))) : escapeHtml(val);
    tag.innerHTML = '<span>' + label + '</span><button class="' + delBase + '" data-section="' + section + '" data-plat="' + plat + '" data-index="' + i + '" title="Remove">×</button>';
    listEl.appendChild(tag);
  });

  updateCounts();
}

function renderAll() {
  PLATFORMS.forEach(function (p) { renderList('shows', p); renderList('keywords', p); });
}

// ── Add / Remove ──────────────────────────────────────────────────────────────
function addItem(section, plat) {
  var isShows = section === 'shows';
  var input = document.getElementById((isShows ? 'show' : 'kw') + '-input-' + plat);
  var raw = input.value.trim().toLowerCase();
  if (!raw) return;

  var arr = state[isShows ? 'shows' : 'keywords'][plat];
  if (arr.includes(raw)) { showStatus('Already exists', 'error'); input.select(); return; }

  arr.push(raw);
  input.value = '';
  renderList(section, plat);
  persist();
  showStatus('"' + raw + '" added', 'saved');
}

function removeItem(section, plat, index) {
  var isShows = section === 'shows';
  var arr = state[isShows ? 'shows' : 'keywords'][plat];
  var removed = arr.splice(index, 1)[0];
  renderList(section, plat);
  persist();
  showStatus('"' + removed + '" removed', 'saved');
}

// ── Storage ───────────────────────────────────────────────────────────────────
function persist() {
  var payload = {
    showsByPlatform: state.shows,
    keywordsByPlatform: state.keywords,
    enabled: document.getElementById('enabledToggle').checked,
  };
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.sync.set(payload);
    }
  } catch (e) { showStatus('Save failed', 'error'); }
}

function loadSettings() {
  var defaults = {
    showsByPlatform: { youtube: [], reddit: [], twitter: [] },
    keywordsByPlatform: { youtube: [], reddit: [], twitter: [] },
    enabled: true,
  };
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.sync.get(defaults, function (data) {
        state.shows = data.showsByPlatform;
        state.keywords = data.keywordsByPlatform;
        document.getElementById('enabledToggle').checked = data.enabled;
        updateShieldState(data.enabled);
        renderAll();
      });
    }
  } catch (e) { showStatus('Load error', 'error'); }
}

// ── Shield toggle ─────────────────────────────────────────────────────────────
function updateShieldState(on) {
  document.getElementById('popupRoot').classList.toggle('shield-disabled', !on);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function setupTabs(tabsId, panelsId) {
  document.getElementById(tabsId).addEventListener('click', function (e) {
    var tab = e.target.closest('.ptab');
    if (!tab) return;
    var plat = tab.dataset.plat;

    document.getElementById(tabsId).querySelectorAll('.ptab').forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');

    document.getElementById(panelsId).querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
    document.getElementById(panelsId).querySelector('[data-plat="' + plat + '"]').classList.add('active');
  });
}

// ── Event delegation ──────────────────────────────────────────────────────────
// Add buttons inside panels
document.querySelectorAll('.tab-panels .btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var panel = btn.closest('.tab-panel');
    if (!panel) return;
    addItem(panel.dataset.section, panel.dataset.plat);
  });
});

// Enter key on inputs
document.querySelectorAll('.cyber-input').forEach(function (input) {
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var panel = input.closest('.tab-panel');
    if (!panel) return;
    addItem(panel.dataset.section, panel.dataset.plat);
  });
});

// Delete — shows
document.getElementById('showsSection').addEventListener('click', function (e) {
  var del = e.target.closest('.show-del');
  if (del) removeItem('shows', del.dataset.plat, parseInt(del.dataset.index, 10));
});

// Delete — keywords
document.getElementById('keywordsSection').addEventListener('click', function (e) {
  var del = e.target.closest('.tag-del');
  if (del) removeItem('keywords', del.dataset.plat, parseInt(del.dataset.index, 10));
});

// Toggle
document.getElementById('enabledToggle').addEventListener('change', function (e) {
  updateShieldState(e.target.checked);
  persist();
  showStatus(e.target.checked ? 'Shield active' : 'Shield offline', e.target.checked ? 'saved' : 'error');
});

document.getElementById('saveApiKey').addEventListener('click', () => {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) return;
  chrome.storage.sync.set({ geminiApiKey: key });
  showStatus('API key saved', 'saved');
});

// ── Init ─────────────────────────────────────────────────────────────────────
setupTabs('showTabs', 'show-panels');
setupTabs('kwTabs', 'kw-panels');
loadSettings();