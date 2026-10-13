// ==UserScript==
// @name         F95Zone OS Filter
// @namespace    https://github.com/neokatin/f95zone-os-filter
// @version      2.0.0
// @description  Filter F95Zone game listings (Latest Updates, game forums, search, watched/what's new) by verified OS support: Windows, macOS, Linux, Android.
// @author       neokatin
// @license      MIT
// @homepageURL  https://github.com/neokatin/f95zone-os-filter
// @supportURL   https://github.com/neokatin/f95zone-os-filter/issues
// @updateURL    https://github.com/neokatin/f95zone-os-filter/raw/main/f95zone-os-filter.user.js
// @downloadURL  https://github.com/neokatin/f95zone-os-filter/raw/main/f95zone-os-filter.user.js
// @match        https://f95zone.to/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

/*
 * HOW OS SUPPORT IS DETERMINED (nothing is guessed):
 *   1. The "OS:" / "Platform:" line in the thread's first post (what the uploader states).
 *   2. Download section labels in the first post ("Win/Linux:", "Mac:", "Android:" ...),
 *      meaning a build for that OS is actually linked.
 *   Engine (Ren'Py, Unity, ...) is NEVER used to infer support. If neither source
 *   mentions an OS, the game is "Unknown" and handled by your Unknown policy.
 *
 * Metadata is fetched from each thread page (throttled, cached for 7 days, and
 * re-checked when the listed version changes).
 *
 * WHERE THE CONTROLS LIVE:
 *   Latest Updates  -> an "Operating system" section in the site's Filters drawer,
 *                      plus a toolbar button showing the hidden count.
 *   Forums / search -> a row inside the forum's filter bar above the thread list.
 *   Anywhere else    -> a small floating button (fallback only).
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const OS_LIST = [
    { id: 'windows', label: 'Windows', icon: 'fab fa-windows', short: 'Win' },
    { id: 'mac', label: 'macOS', icon: 'fab fa-apple', short: 'Mac' },
    { id: 'linux', label: 'Linux', icon: 'fab fa-linux', short: 'Linux' },
    { id: 'android', label: 'Android', icon: 'fab fa-android', short: 'Android' },
  ];
  const OS_IDS = OS_LIST.map((o) => o.id);

  const CACHE_KEY = 'osf_cache_v1';
  const SETTINGS_KEY = 'osf_settings_v1';
  const CACHE_TTL_KNOWN = 7 * 24 * 3600e3;
  const CACHE_TTL_UNKNOWN = 24 * 3600e3;
  const CACHE_MAX_ENTRIES = 5000;
  const MAX_CONCURRENT = 2;
  const MIN_GAP_MS = 700; // between request starts
  const BACKOFF_BASE_MS = 30e3;

  const DEFAULT_SETTINGS = {
    enabled: true,
    selected: [], // empty = no filtering
    matchMode: 'any', // 'any' | 'all'
    unknownPolicy: 'show', // 'show' | 'dim' | 'hide'
    mismatchStyle: 'hide', // 'hide' | 'dim'
    showBadges: true,
    autoFetch: true,
    pcMeansWindows: true,
    forumScope: 'games', // 'games' | 'all'
    pages: { latest: true, forums: true, search: true, other: true },
    peek: false,
    panelOpen: false,
  };

  // Each adapter describes one kind of listing. Selectors are kept here so they
  // are easy to adjust if F95Zone changes its markup.
  const ADAPTERS = [
    {
      name: 'latest',
      page: 'latest',
      // Latest Updates (/sam/latest_alpha/) renders tiles client-side.
      item: '.resource-tile',
      tid: (el) => (/^\d+$/.test(el.dataset.threadId || '') ? el.dataset.threadId : null),
      version: (el) => textOf(el.querySelector('.resource-tile_label-version, .header_title-ver')),
      badgeHost: (el) => el,
      overlay: true,
    },
    {
      name: 'structItem',
      page: null, // forums / watched / whats-new decide via pageKind()
      item: '.structItem--thread',
      link: '.structItem-title a[data-tp-primary], .structItem-title a[href*="/threads/"]:not(.labelLink)',
      version: (el) => versionFromTitle(textOf(el.querySelector('.structItem-title a[data-tp-primary]'))),
      badgeHost: (el) => el.querySelector('.structItem-title'),
    },
    {
      name: 'contentRow',
      page: null,
      // Search results, tag pages, find-threads etc.
      item: '.block-body > li.block-row, ol.listPlain > li.block-row',
      link: '.contentRow-title a[href*="/threads/"]',
      version: (el) => versionFromTitle(textOf(el.querySelector('.contentRow-title a[href*="/threads/"]'))),
      badgeHost: (el) => el.querySelector('.contentRow-title'),
    },
  ];

  function textOf(el) {
    return el ? el.textContent.trim().slice(0, 80) : '';
  }
  // "Game Name [v0.1.3] [Dev]" -> "v0.1.3" (first bracket containing a digit)
  function versionFromTitle(title) {
    const m = title.match(/\[([^\]]*\d[^\]]*)\]/);
    return m ? m[1].trim() : '';
  }

  // ---------------------------------------------------------------------------
  // Storage helpers (GM storage with localStorage fallback)
  // ---------------------------------------------------------------------------
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  function load(key, fallback) {
    try {
      if (hasGM) return GM_getValue(key, fallback);
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      if (hasGM) GM_setValue(key, value);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('[OS Filter] save failed', e);
    }
  }

  function loadSettings() {
    const s = load(SETTINGS_KEY, {}) || {};
    const merged = { ...DEFAULT_SETTINGS, ...s, pages: { ...DEFAULT_SETTINGS.pages, ...(s.pages || {}) } };
    merged.selected = Array.isArray(merged.selected) ? merged.selected.filter((id) => OS_IDS.includes(id)) : [];
    if (!['any', 'all'].includes(merged.matchMode)) merged.matchMode = 'any';
    if (!['show', 'dim', 'hide'].includes(merged.unknownPolicy)) merged.unknownPolicy = 'show';
    if (!['hide', 'dim'].includes(merged.mismatchStyle)) merged.mismatchStyle = 'hide';
    merged.peek = false; // never persist peek
    return merged;
  }
  const settings = loadSettings();
  function saveSettings() {
    const { peek, ...rest } = settings;
    save(SETTINGS_KEY, rest);
  }

  let cache = load(CACHE_KEY, {}) || {};
  let cacheSaveTimer = null;
  function saveCacheSoon() {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => {
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX_ENTRIES) {
        keys.sort((a, b) => cache[a].t - cache[b].t);
        for (const k of keys.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete cache[k];
      }
      save(CACHE_KEY, cache);
    }, 1000);
  }
  // Version shown in the listing, per thread. A different version than the one
  // cached means the game was updated, so its OS info is re-checked.
  const listedVersion = new Map();
  function getCached(tid) {
    const c = cache[tid];
    if (!c) return null;
    const ttl = c.unknown ? CACHE_TTL_UNKNOWN : CACHE_TTL_KNOWN;
    if (Date.now() - c.t > ttl) return null;
    const v = listedVersion.get(tid);
    if (v && c.ver && v !== c.ver) return null;
    return c;
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------
  // Segments matching this are not counted as support. JoiPlay is an emulator, not a native build.
  const NEGATION = /\b(no|not supported|unsupported|without|n\/a|none|coming soon|planned|soon|wip|dropped|discontinued|joiplay)\b/i;

  // Words allowed in a download label such as "Win/Linux (Compressed)" or "Android APK".
  // Anything else ("Mac users", "Note") means the line is not a download label.
  const LABEL_WORDS = new Set(
    ('win windows pc mac macos osx os x linux android apk and x64 x86 64 32 bit 64bit 32bit arm arm64 compressed ' +
      'uncompressed version ver build builds port official unofficial full game zip rar 7z universal intel apple silicon ' +
      'm1 download downloads link links mirror mirrors').split(' ')
  );
  function isOsLabel(label) {
    if (NEGATION.test(label)) return false;
    const words = label
      .toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .split(/[\s\/&+,\-–]+/)
      .filter(Boolean);
    return words.length > 0 && words.length <= 8 && words.every((w) => LABEL_WORDS.has(w));
  }

  function osFromText(text) {
    const t = ' ' + text.toLowerCase() + ' ';
    const found = new Set();
    if (/\bwin(?:dows)?\b|\bwin(?:32|64|xp|7|8|10|11)\b|\bwindows\s*(?:xp|vista|7|8|10|11)\b/.test(t)) found.add('windows');
    if (settings.pcMeansWindows && /\bpc\b/.test(t)) found.add('windows');
    if (/\bmac(?:os|intosh)?\b|\bmac\s*os(?:\s*x)?\b|\bos\s*x\b|\bosx\b|\bapple\s*silicon\b/.test(t)) found.add('mac');
    if (/\blinux\b|\bubuntu\b|\bdebian\b/.test(t)) found.add('linux');
    if (/\bandroid\b|\bapk\b/.test(t)) found.add('android');
    return found;
  }

  function osFromList(value) {
    const found = new Set();
    // "Win/Linux", "Windows, Mac & Android", "Windows + Linux"
    for (const seg of value.split(/[,;|&+\/]|\band\b/i)) {
      if (!seg.trim() || NEGATION.test(seg)) continue;
      for (const os of osFromText(seg)) found.add(os);
    }
    return found;
  }

  function elementToText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
    c.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    c.querySelectorAll('div, p, li, tr, h1, h2, h3, h4, h5, blockquote, dd, dt').forEach((n) => n.append('\n'));
    return (c.textContent || '')
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n');
  }

  function parseFirstPost(text) {
    const result = {}; // os -> 'os' | 'dl' | 'both'
    let raw = '';

    // 1) Explicit OS line
    const m = text.match(/^(?:OS|O\.S\.|Platforms?|Operating Systems?|Supported (?:OS|Platforms?))\s*[:：]\s*(.*)$/im);
    if (m) {
      raw = m[1].trim();
      if (!raw) {
        // "OS:\nWindows, Linux"
        const after = text.slice(m.index + m[0].length).split('\n').map((s) => s.trim()).find(Boolean);
        raw = after || '';
      }
      raw = raw.slice(0, 160);
      for (const os of osFromList(raw)) result[os] = 'os';
    }

    // 2) Download section labels
    const dlIdx = text.search(/^\s*DOWNLOADS?\b/im);
    if (dlIdx >= 0) {
      const section = text.slice(dlIdx, dlIdx + 4000);
      for (const line of section.split('\n').slice(1)) {
        const lm = line.match(/^([^:\n]{2,40}):/);
        if (!lm) continue;
        const label = lm[1];
        if (!isOsLabel(label)) continue;
        for (const os of osFromList(label)) result[os] = result[os] === 'os' ? 'both' : result[os] || 'dl';
      }
    }

    return { os: result, raw };
  }

  function parseThreadHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const post =
      doc.querySelector('article.message--post.message-threadStarterPost .bbWrapper') ||
      doc.querySelector('article.message .message-body .bbWrapper') ||
      doc.querySelector('.bbWrapper');
    if (!post) {
      const body = (doc.body && doc.body.textContent) || '';
      const blocked = /cloudflare|ddos-guard|checking your browser|just a moment|attention required/i.test(body + doc.title);
      const login = /must be logged in|log in or register/i.test(body);
      return { error: blocked ? 'blocked' : login ? 'login' : 'noparse' };
    }
    return parseFirstPost(elementToText(post));
  }

  // ---------------------------------------------------------------------------
  // Fetch queue
  // ---------------------------------------------------------------------------
  const queue = new Set();
  const inFlight = new Set();
  const errors = new Map(); // tid -> reason
  const visibleTids = new Set();
  let active = 0;
  let lastStart = 0;
  let pausedUntil = 0;
  let backoff = 0;
  let pumpTimer = null;

  function enqueue(tid) {
    if (!settings.autoFetch || inFlight.has(tid) || queue.has(tid) || errors.has(tid)) return;
    queue.add(tid);
    schedulePump(0);
  }
  function schedulePump(delay) {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, Math.max(0, delay));
  }
  function nextTid() {
    for (const tid of queue) if (visibleTids.has(tid)) return tid;
    return queue.values().next().value;
  }
  function pump() {
    if (!settings.enabled || !settings.autoFetch) return;
    while (active < MAX_CONCURRENT && queue.size) {
      const now = Date.now();
      if (now < pausedUntil) return schedulePump(pausedUntil - now);
      const wait = lastStart + MIN_GAP_MS - now;
      if (wait > 0) return schedulePump(wait);
      const tid = nextTid();
      queue.delete(tid);
      if (getCached(tid)) {
        refreshTid(tid);
        continue;
      }
      lastStart = now;
      active++;
      inFlight.add(tid);
      fetchThread(tid).finally(() => {
        active--;
        inFlight.delete(tid);
        refreshTid(tid);
        schedulePump(0);
      });
    }
  }

  function pauseFetching() {
    backoff = Math.min(backoff ? backoff * 2 : BACKOFF_BASE_MS, 10 * 60e3);
    pausedUntil = Date.now() + backoff;
    updateStatsSoon();
  }

  async function fetchThread(tid) {
    let res;
    try {
      res = await fetch(`${location.origin}/threads/${tid}/`, { credentials: 'include' });
    } catch (e) {
      errors.set(tid, 'network');
      return;
    }
    if (res.status === 429 || res.status === 503) {
      pauseFetching();
      queue.add(tid); // retry later
      return;
    }
    if (!res.ok) {
      errors.set(tid, `HTTP ${res.status}`);
      return;
    }
    const parsed = parseThreadHtml(await res.text());
    if (parsed.error) {
      errors.set(tid, parsed.error);
      if (parsed.error === 'blocked') pauseFetching();
      return;
    }
    backoff = 0;
    const known = Object.keys(parsed.os).length > 0;
    cache[tid] = { os: parsed.os, raw: parsed.raw, ver: listedVersion.get(tid) || '', t: Date.now(), unknown: !known };
    saveCacheSoon();
  }

  function retry(tid) {
    errors.delete(tid);
    delete cache[tid];
    saveCacheSoon();
    queue.delete(tid);
    enqueue(tid);
    refreshTid(tid);
  }

  // ---------------------------------------------------------------------------
  // Page detection
  // ---------------------------------------------------------------------------
  function pageKind() {
    const p = location.pathname;
    if (/^\/sam\/latest_alpha\b/.test(p)) return 'latest';
    if (/^\/forums\//.test(p)) return 'forums';
    if (/^\/search\//.test(p)) return 'search';
    if (/^\/(watched|whats-new|find-threads|tags)\//.test(p)) return 'other';
    return null;
  }
  function isGameForum() {
    return /^\/forums\/[^/]*game[^/]*\.\d+/i.test(location.pathname);
  }
  function pageActive() {
    const kind = pageKind();
    if (!kind || !settings.pages[kind]) return false;
    if (kind === 'forums' && settings.forumScope === 'games') return isGameForum();
    return true;
  }

  function threadIdFromHref(href) {
    const m = (href || '').match(/\/threads\/(?:[^/?#]*\.)?(\d+)(?:[/?#]|$)/);
    return m ? m[1] : null;
  }
  function threadIdFor(el, adapter) {
    if (adapter.tid) {
      const tid = adapter.tid(el);
      if (tid) return tid;
    }
    if (adapter.link) {
      const a = el.querySelector(adapter.link);
      return a ? threadIdFromHref(a.getAttribute('href')) : null;
    }
    const a = el.matches('a[href*="/threads/"]') ? el : el.querySelector('a[href*="/threads/"]');
    return a ? threadIdFromHref(a.getAttribute('href')) : null;
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------
  function statusFor(tid) {
    const c = getCached(tid);
    if (c) return c.unknown ? { kind: 'unknown', c } : { kind: 'known', c };
    if (errors.has(tid)) return { kind: 'error', reason: errors.get(tid) };
    return { kind: 'pending' };
  }

  // Returns 'show' | 'dim' | 'hide' plus a reason.
  function decide(st) {
    const sel = settings.selected;
    if (!settings.enabled || !sel.length) return { action: 'show', reason: 'nofilter' };
    if (st.kind === 'pending') return { action: 'show', reason: 'pending' };
    if (st.kind === 'unknown' || st.kind === 'error') return { action: settings.unknownPolicy, reason: 'unknown' };
    const has = (id) => !!st.c.os[id];
    const ok = settings.matchMode === 'all' ? sel.every(has) : sel.some(has);
    return ok ? { action: 'show', reason: 'match' } : { action: settings.mismatchStyle, reason: 'mismatch' };
  }

  // ---------------------------------------------------------------------------
  // Badges: one compact tag per listing, styled like the site's version label
  // ---------------------------------------------------------------------------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of children) if (c != null && c !== false) node.append(c);
    return node;
  }
  const icon = (cls) => el('i', { class: cls, 'aria-hidden': 'true' });

  function tagTooltip(st) {
    if (st.kind === 'pending') return 'Checking the thread for OS info…';
    if (st.kind === 'error') return `Couldn't read OS info (${st.reason}). Click to retry.`;
    if (st.kind === 'unknown') return 'OS not stated in the first post — compatibility not verified.\nClick to re-check.';
    const fromLine = [], fromDl = [];
    for (const o of OS_LIST) {
      const src = st.c.os[o.id];
      if (src === 'os' || src === 'both') fromLine.push(o.label);
      else if (src === 'dl') fromDl.push(o.label);
    }
    const lines = [];
    if (fromLine.length) lines.push(`${fromLine.join(', ')} — stated in the thread's OS line`);
    if (fromDl.length) lines.push(`${fromDl.join(', ')} — download link only (not in OS line)`);
    if (st.c.raw) lines.push(`OS line: "${st.c.raw}"`);
    return lines.join('\n');
  }

  function renderBadges(item, adapter, tid, st) {
    let tag = item.querySelector(':scope .osf-tag');
    if (!settings.enabled || !settings.showBadges) {
      if (tag) tag.remove();
      return;
    }
    const sig = [tid, st.kind, st.c ? JSON.stringify(st.c.os) : st.reason || '', settings.selected.join(',')].join('|');
    if (tag && tag.dataset.sig === sig) return;
    const host = adapter.badgeHost(item);
    if (!host) return;
    if (!tag) {
      tag = el('span', { class: 'osf-tag ' + (adapter.overlay ? 'osf-tag--overlay' : 'osf-tag--inline') });
      tag.addEventListener('click', onTagClick);
      host.appendChild(tag);
    }
    tag.dataset.sig = sig;
    tag.dataset.tid = tid;
    tag.dataset.state = st.kind;
    tag.title = tagTooltip(st);
    tag.textContent = '';

    if (st.kind === 'pending') {
      tag.append(icon('fas fa-circle-notch fa-spin'));
    } else if (st.kind === 'error') {
      tag.append(icon('fas fa-exclamation-triangle'), el('span', {}, 'OS'));
    } else if (st.kind === 'unknown') {
      tag.append(el('span', {}, 'OS ?'));
    } else {
      for (const o of OS_LIST) {
        const src = st.c.os[o.id];
        if (!src) continue;
        let cls = o.icon + ' osf-i';
        if (src === 'dl') cls += ' is-dl';
        if (settings.selected.includes(o.id)) cls += ' is-match';
        tag.append(icon(cls));
      }
    }
  }

  // Only unknown/error tags are clickable (re-check); other clicks fall through to the listing link.
  function onTagClick(e) {
    const tag = e.currentTarget;
    if (tag.dataset.state !== 'unknown' && tag.dataset.state !== 'error') return;
    e.preventDefault();
    e.stopPropagation();
    retry(tag.dataset.tid);
  }

  function applyItem(item, adapter, tid) {
    const st = statusFor(tid);
    const d = decide(st);
    const action = settings.peek && d.action !== 'show' ? 'peek' : d.action;
    if (item.dataset.osfAction !== action) item.dataset.osfAction = action;
    if (item.dataset.osfReason !== d.reason) item.dataset.osfReason = d.reason;
    renderBadges(item, adapter, tid, st);
    if (st.kind === 'pending') enqueue(tid);
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------
  const io =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const en of entries) {
              const tid = en.target.dataset.osfTid;
              if (!tid) continue;
              if (en.isIntersecting) visibleTids.add(tid);
              else visibleTids.delete(tid);
            }
          },
          { rootMargin: '400px 0px' }
        )
      : null;

  function activeAdapters() {
    const kind = pageKind();
    return ADAPTERS.filter((a) => (a.page ? a.page === kind : kind !== 'latest'));
  }

  function clearItem(item) {
    delete item.dataset.osfAction;
    delete item.dataset.osfReason;
    delete item.dataset.osfTid;
    const t = item.querySelector(':scope .osf-tag');
    if (t) t.remove();
    if (io) io.unobserve(item);
  }

  function scan() {
    mountControls();
    if (!settings.enabled || !pageActive()) {
      document.querySelectorAll('[data-osf-tid]').forEach(clearItem);
      updateStats();
      return;
    }
    for (const adapter of activeAdapters()) {
      for (const item of document.querySelectorAll(adapter.item)) {
        if (item.closest('.osf-ui')) continue;
        const tid = threadIdFor(item, adapter);
        if (!tid) continue;
        const ver = adapter.version ? adapter.version(item) : '';
        if (ver) listedVersion.set(tid, ver);
        if (item.dataset.osfTid !== tid) {
          // New item, or element re-used for a different thread
          const old = item.querySelector(':scope .osf-tag');
          if (old) old.remove();
          item.dataset.osfTid = tid;
          item.__osfAdapter = adapter;
          if (io) io.observe(item);
        }
        applyItem(item, adapter, tid);
      }
    }
    updateStats();
  }

  function refreshTid(tid) {
    for (const item of document.querySelectorAll(`[data-osf-tid="${tid}"]`)) {
      if (item.__osfAdapter) applyItem(item, item.__osfAdapter, tid);
    }
    updateStatsSoon();
  }

  let scanTimer = null;
  function scanSoon(delay = 200) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  // ---------------------------------------------------------------------------
  // Styles — colours taken from F95Zone's dark theme so everything blends in
  // ---------------------------------------------------------------------------
  const CSS = `
    :root {
      --osf-bg: #242629; --osf-bg-deep: #181a1d; --osf-line: #3f4043; --osf-text: #eee;
      --osf-soft: #d9d9d9; --osf-muted: #9398a0; --osf-faint: #696f78; --osf-accent: #ec5555;
    }
    [data-osf-action="hide"] { display: none !important; }
    [data-osf-action="dim"] { opacity: .3; filter: grayscale(.8); transition: opacity .15s, filter .15s; }
    [data-osf-action="dim"]:hover { opacity: .9; filter: none; }
    [data-osf-action="peek"] { opacity: .55; outline: 1px dashed var(--osf-accent); outline-offset: -1px; }

    /* Listing tag */
    .osf-tag { display: inline-flex; align-items: center; gap: 5px; border-radius: 3px; font-weight: 600;
      color: var(--osf-soft); background: var(--osf-line); white-space: nowrap; font-family: inherit; }
    .osf-tag .osf-i { color: var(--osf-soft); }
    .osf-tag .osf-i.is-match { color: var(--osf-accent); }
    .osf-tag .osf-i.is-dl { opacity: .45; }
    .osf-tag[data-state="pending"] { color: var(--osf-faint); }
    .osf-tag[data-state="unknown"], .osf-tag[data-state="error"] { color: var(--osf-muted); cursor: pointer; }
    .osf-tag[data-state="error"] i { color: #d9a03f; }
    .osf-tag--overlay { position: absolute; top: 8px; right: 8px; z-index: 3; height: 22px; padding: 0 7px;
      font-size: 12px; background: rgba(24, 26, 29, .88); box-shadow: 0 1px 4px rgba(0,0,0,.4); pointer-events: none; }
    .osf-tag--overlay[data-state="unknown"], .osf-tag--overlay[data-state="error"] { pointer-events: auto; }
    .osf-tag--inline { height: 16px; padding: 0 5px; margin-left: 6px; font-size: 11px; vertical-align: 1px; }

    /* Shared controls */
    .osf-ui { font-family: inherit; color: var(--osf-text); }
    .osf-seg { display: inline-flex; border: 1px solid var(--osf-line); border-radius: 3px; overflow: hidden; vertical-align: middle; }
    .osf-seg button { all: unset; cursor: pointer; padding: 0 8px; height: 22px; line-height: 22px; font-size: 12px;
      color: var(--osf-muted); background: var(--osf-bg-deep); }
    .osf-seg button + button { border-left: 1px solid var(--osf-line); }
    .osf-seg button:hover { color: var(--osf-text); }
    .osf-seg button.is-on { color: var(--osf-accent); background: var(--osf-bg); }
    .osf-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--osf-muted); }
    .osf-stats { font-size: 12px; color: var(--osf-faint); }
    .osf-stats b { color: var(--osf-muted); font-weight: 600; }
    .osf-link { all: unset; cursor: pointer; font-size: 12px; color: var(--osf-muted); }
    .osf-link:hover, .osf-link.is-on { color: var(--osf-accent); }
    .osf-options { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--osf-line); font-size: 12px; color: var(--osf-muted); }
    .osf-options[hidden] { display: none !important; }
    .osf-check { display: flex; align-items: center; gap: 8px; padding: 3px 0; cursor: pointer; }
    .osf-check input { accent-color: var(--osf-accent); margin: 0; }
    .osf-options h5 { margin: 8px 0 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--osf-faint); }
    .osf-options .osf-row { margin-top: 10px; }
    .osf-note { font-size: 11px; color: var(--osf-faint); line-height: 1.4; margin-top: 6px; }
    .osf-off-note { font-size: 12px; color: var(--osf-muted); }

    /* Latest Updates: section in the site's Filters drawer (site classes do most of the work) */
    #osf-block { position: relative; }
    /* Like the site's own sections: the current choice sits in the top-right corner. */
    #osf-block .osf-value { position: absolute; top: 12px; right: 16px; font-size: 11.6px; font-weight: 600;
      text-transform: uppercase; color: var(--osf-muted); }
    #osf-block .filter-block_button-label { display: none; }
    #osf-block .filter-block_button:not(.filter-selected) { color: var(--osf-faint); }
    #osf-block .filter-block_button:not(.filter-selected):hover { color: var(--osf-accent); }

    /* Latest Updates: toolbar button */
    #controls_osf { position: relative; }
    #controls_osf .osf-bubble { position: absolute; top: -6px; right: -6px; min-width: 16px; height: 16px; padding: 0 4px;
      box-sizing: border-box; border-radius: 8px; background: var(--osf-accent); color: #fff; font-size: 10px; font-weight: 700;
      line-height: 16px; text-align: center; pointer-events: none; }
    #controls_osf .osf-bubble[hidden] { display: none; }
    #controls_osf.is-active { color: var(--osf-accent); }
    #osf-block.osf-flash { animation: osf-flash 1.2s ease-out; }
    @keyframes osf-flash { from { background: rgba(236,85,85,.18); } to { background: transparent; } }

    /* Forums / search: row in the filter bar */
    .osf-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 6px 8px;
      border-top: 1px solid rgba(255,255,255,.08); font-size: 12px; color: var(--osf-muted); }
    .block-filterBar.osf-own-bar { padding: 0; }
    .osf-bar .osf-bar-label { font-weight: 600; color: var(--osf-faint); text-transform: uppercase; font-size: 11px; }
    .osf-bar .osf-group { display: inline-flex; align-items: center; gap: 6px; }
    .osf-chip { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px;
      border: 1px solid var(--osf-line); border-radius: 3px; background: var(--osf-bg-deep); color: var(--osf-muted); font-size: 12px; }
    .osf-chip:hover { color: var(--osf-text); }
    .osf-chip.is-on { color: var(--osf-accent); border-color: var(--osf-accent); background: var(--osf-bg); }
    .osf-bar .osf-spacer { flex: 1; }
    .osf-bar .osf-options { flex-basis: 100%; margin-top: 2px; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0 18px; }
    .osf-bar .osf-options h5, .osf-bar .osf-options .osf-row, .osf-bar .osf-options .osf-note { grid-column: 1 / -1; }

    /* Fallback floating button */
    .osf-float { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; font-size: 13px; }
    .osf-float-btn { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
      border-radius: 3px; background: var(--osf-bg); border: 1px solid var(--osf-line); color: var(--osf-muted); box-shadow: 0 4px 14px rgba(0,0,0,.45); }
    .osf-float-btn:hover { color: var(--osf-accent); }
    .osf-float-btn .osf-bubble { background: var(--osf-accent); color: #fff; border-radius: 8px; padding: 0 5px; font-size: 10px; font-weight: 700; line-height: 16px; }
    .osf-float-btn .osf-bubble[hidden] { display: none; }
    .osf-float-panel { position: absolute; right: 0; bottom: 40px; width: 300px; max-height: calc(100vh - 80px); overflow: auto; padding: 14px;
      background: var(--osf-bg); border: 1px solid var(--osf-line); border-radius: 3px; box-shadow: 0 8px 28px rgba(0,0,0,.55); }
    .osf-float-panel[hidden] { display: none; }
    .osf-float-panel .osf-chips { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
    .osf-float-title { font-size: 11.5px; font-weight: 600; text-transform: uppercase; color: var(--osf-faint); }
  `;

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  const ui = {
    mode: null, // 'latest' | 'bar' | 'float'
    root: null, // the mounted control container
    toolbarBtn: null,
    statEls: [], // elements whose text shows the summary
    bubbles: [], // count bubbles
    optionsOpen: false,
  };

  function changed(rescan = true) {
    saveSettings();
    renderControls();
    if (rescan) scan();
    if (settings.enabled) schedulePump(0);
  }

  function toggleOs(id) {
    const set = new Set(settings.selected);
    set.has(id) ? set.delete(id) : set.add(id);
    settings.selected = OS_IDS.filter((x) => set.has(x));
    changed();
  }

  function seg(options, current, onPick, title) {
    const wrap = el('span', { class: 'osf-seg', title: title || null });
    for (const [val, label] of options) {
      wrap.append(
        el('button', { type: 'button', class: val === current ? 'is-on' : '', onclick: (e) => { e.preventDefault(); onPick(val); } }, label)
      );
    }
    return wrap;
  }

  function check(label, value, onChange, title) {
    const input = el('input', { type: 'checkbox' });
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'osf-check', title: title || null }, input, label);
  }

  function statsLine() {
    const span = el('span', { class: 'osf-stats' });
    ui.statEls.push(span);
    return span;
  }

  function optionsPanel() {
    const pageNames = [['latest', 'Latest Updates'], ['forums', 'Forums'], ['search', 'Search results'], ['other', 'Watched / What\'s new / Tags']];
    const panel = el('div', { class: 'osf-options', hidden: !ui.optionsOpen },
      el('div', { class: 'osf-row', style: 'margin-top:0' },
        el('span', {}, 'Non-matching games'),
        seg([['hide', 'Hide'], ['dim', 'Dim']], settings.mismatchStyle, (v) => { settings.mismatchStyle = v; changed(); })
      ),
      check('Enabled', settings.enabled, (v) => { settings.enabled = v; changed(); }),
      check('Show OS tags on listings', settings.showBadges, (v) => { settings.showBadges = v; changed(); }),
      check('Check threads automatically', settings.autoFetch, (v) => { settings.autoFetch = v; changed(); },
        'Reads each thread\'s first post (throttled, cached 7 days). Off = only already-checked games are filtered.'),
      check('Count "PC" as Windows', settings.pcMeansWindows, (v) => { settings.pcMeansWindows = v; changed(false); },
        'Applies to threads checked from now on. Clear the cache to re-check everything.'),
      check('Forums: game forums only', settings.forumScope === 'games', (v) => { settings.forumScope = v ? 'games' : 'all'; changed(); }),
      el('h5', {}, 'Active on'),
      ...pageNames.map(([k, label]) => check(label, settings.pages[k], (v) => { settings.pages[k] = v; changed(); })),
      el('div', { class: 'osf-row' },
        el('button', { type: 'button', class: 'osf-link', onclick: retryErrors, title: 'Retry games that failed to load' }, 'Retry failed'),
        (ui.cacheBtn = el('button', { type: 'button', class: 'osf-link', onclick: clearCache, title: 'Forget all checked OS info' }, 'Clear cache'))
      ),
      el('div', { class: 'osf-note' },
        'Tags only show what the thread states: its OS line, or a download labelled for that OS (faded icon). ' +
          'The engine is never used to guess. Click an "OS ?" tag to re-check it.')
    );
    return panel;
  }

  function footerRow(compact) {
    return el('div', { class: 'osf-row' },
      statsLine(),
      el('span', { style: 'display:flex;gap:12px' },
        el('button', {
          type: 'button', class: 'osf-link' + (settings.peek ? ' is-on' : ''), title: 'Temporarily show hidden games (outlined)',
          onclick: (e) => { e.preventDefault(); settings.peek = !settings.peek; changed(); },
        }, settings.peek ? 'Stop peeking' : 'Peek'),
        el('button', {
          type: 'button', class: 'osf-link' + (ui.optionsOpen ? ' is-on' : ''), title: 'Options',
          onclick: (e) => { e.preventDefault(); ui.optionsOpen = !ui.optionsOpen; renderControls(); },
        }, icon('fas fa-cog'), compact ? null : ' Options')
      )
    );
  }

  function unknownSeg() {
    return seg([['show', 'Show'], ['dim', 'Dim'], ['hide', 'Hide']], settings.unknownPolicy,
      (v) => { settings.unknownPolicy = v; changed(); }, 'Games whose first post doesn\'t state an OS');
  }
  function matchSeg() {
    return seg([['any', 'Any'], ['all', 'All']], settings.matchMode, (v) => { settings.matchMode = v; changed(); },
      'Any: supports at least one selected OS. All: supports every selected OS.');
  }

  // Latest Updates: a section in the site's own Filters drawer, built from its classes.
  function buildLatestBlock() {
    const block = el('div', { id: 'osf-block', class: 'filter-block osf-ui' });
    const names = OS_LIST.filter((o) => settings.selected.includes(o.id)).map((o) => o.label);
    const value = !names.length ? 'Off' : names.length <= 2 ? names.join(' + ') : `${names.length} systems`;
    const buttons = el('div', { class: 'filter-block_content filter-block_h' });
    for (const o of OS_LIST) {
      const on = settings.selected.includes(o.id);
      buttons.append(
        el('div', { class: 'filter-block_button-wrap' },
          el('a', {
            href: '#', role: 'button', 'aria-pressed': String(on), title: on ? `Stop filtering for ${o.label}` : `Show games for ${o.label}`,
            class: `filter-block_button ${o.icon}` + (on ? ' filter-selected' : ''),
            onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleOs(o.id); },
          }),
          el('div', { class: 'filter-block_button-label' }, o.label)
        )
      );
    }
    block.append(
      el('h4', { class: 'filter-block_title' }, 'Operating system'),
      el('div', { class: 'osf-value' }, value),
      buttons,
      el('div', { class: 'osf-row' }, el('span', {}, 'Match'), matchSeg()),
      el('div', { class: 'osf-row' }, el('span', {}, 'Unknown OS'), unknownSeg()),
      footerRow(true),
      optionsPanel()
    );
    if (!settings.enabled) block.append(el('div', { class: 'osf-note' }, 'The OS filter is turned off (Options → Enabled).'));
    return block;
  }

  // Forums / search: a row inside the forum software's filter bar.
  function buildBar() {
    const bar = el('div', { class: 'osf-bar osf-ui' });
    if (!pageActive()) {
      const why = pageKind() === 'forums' && settings.pages.forums && settings.forumScope === 'games'
        ? 'OS filter is off outside game forums.' : 'OS filter is off on this page.';
      bar.append(
        el('span', { class: 'osf-bar-label' }, 'OS'),
        el('span', { class: 'osf-off-note' }, why),
        el('span', { class: 'osf-spacer' }),
        el('button', { type: 'button', class: 'osf-link', onclick: () => { ui.optionsOpen = !ui.optionsOpen; renderControls(); } }, icon('fas fa-cog'), ' Options'),
        optionsPanel()
      );
      return bar;
    }
    const chips = el('span', { class: 'osf-group' });
    for (const o of OS_LIST) {
      const on = settings.selected.includes(o.id);
      chips.append(el('button', {
        type: 'button', class: 'osf-chip' + (on ? ' is-on' : ''), 'aria-pressed': String(on),
        onclick: (e) => { e.preventDefault(); toggleOs(o.id); },
      }, icon(o.icon), o.label));
    }
    const right = footerRow();
    right.style.margin = '0';
    right.style.flex = '1';
    right.style.justifyContent = 'flex-end';
    bar.append(
      el('span', { class: 'osf-bar-label' }, 'OS'),
      chips,
      el('span', { class: 'osf-group' }, 'Match', matchSeg()),
      el('span', { class: 'osf-group' }, 'Unknown', unknownSeg()),
      right,
      optionsPanel()
    );
    return bar;
  }

  // Fallback: small floating button + panel.
  function buildFloat() {
    const wrap = el('div', { class: 'osf-float osf-ui' });
    const bubble = el('span', { class: 'osf-bubble', hidden: true });
    ui.bubbles.push(bubble);
    const panel = el('div', { class: 'osf-float-panel', hidden: !settings.panelOpen });
    const chips = el('div', { class: 'osf-chips' });
    for (const o of OS_LIST) {
      const on = settings.selected.includes(o.id);
      chips.append(el('button', { type: 'button', class: 'osf-chip' + (on ? ' is-on' : ''), onclick: () => toggleOs(o.id) }, icon(o.icon), o.label));
    }
    panel.append(
      el('div', { class: 'osf-float-title' }, 'Operating system'),
      chips,
      el('div', { class: 'osf-row' }, el('span', {}, 'Match'), matchSeg()),
      el('div', { class: 'osf-row' }, el('span', {}, 'Unknown OS'), unknownSeg()),
      footerRow(),
      optionsPanel()
    );
    wrap.append(panel, el('button', { type: 'button', class: 'osf-float-btn', title: 'OS filter (Alt+O)', onclick: () => togglePanel() }, icon('fab fa-windows'), 'OS', bubble));
    return wrap;
  }

  // Latest Updates toolbar button, placed next to the site's own Filters button.
  function buildToolbarButton() {
    const bubble = el('span', { class: 'osf-bubble', hidden: true });
    ui.bubbles.push(bubble);
    const a = el('a', { id: 'controls_osf', title: 'OS filter (Alt+O)', href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); revealLatestBlock(); } },
      icon('fas fa-desktop'), bubble);
    return el('div', { id: 'sub-nav_controls_osf', class: 'controls-block osf-ui' }, a);
  }

  function revealLatestBlock() {
    const wrap = document.querySelector('#latest-page_filter-wrap');
    if (wrap && wrap.classList.contains('filter-hidden')) document.querySelector('#controls_filter-toggle')?.click();
    const block = document.querySelector('#osf-block');
    if (!block) return;
    setTimeout(() => {
      block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      block.classList.remove('osf-flash');
      void block.offsetWidth;
      block.classList.add('osf-flash');
    }, 150);
  }

  function togglePanel(force) {
    if (ui.mode === 'latest') return revealLatestBlock();
    if (ui.mode === 'bar') {
      ui.root?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    settings.panelOpen = force != null ? force : !settings.panelOpen;
    saveSettings();
    renderControls();
  }

  // Where the controls should go on this page, or null for none.
  function findMount() {
    const kind = pageKind();
    if (!kind) return null;
    if (kind === 'latest') {
      const drawer = document.querySelector('#latest-page_filter-wrap_inner .content-block_filter');
      if (drawer) return { mode: 'latest', drawer, toolbar: document.querySelector('#sub-nav_controls') };
      return null; // drawer not rendered yet; try again on next scan
    }
    const first = document.querySelector('.structItem--thread, .block-body > li.block-row');
    const container = first && first.closest('.block-container');
    if (container) return { mode: 'bar', container };
    return { mode: 'float' };
  }

  function mountControls() {
    const m = findMount();
    const stillMounted = ui.root && ui.root.isConnected && m && m.mode === ui.mode &&
      (m.mode !== 'latest' || !m.toolbar || (ui.toolbarBtn && ui.toolbarBtn.isConnected));
    if (stillMounted) return;
    unmountControls();
    if (!m) return;
    ui.mode = m.mode;
    ui.mount = m;
    renderControls();
  }

  function unmountControls() {
    ui.root?.remove();
    ui.toolbarBtn?.remove();
    ui.root = ui.toolbarBtn = null;
    ui.mode = null;
  }

  function renderControls() {
    const m = ui.mount;
    if (!ui.mode || !m) return;
    ui.statEls = [];
    ui.bubbles = [];
    let next;
    if (ui.mode === 'latest') {
      next = buildLatestBlock();
      if (ui.root && ui.root.isConnected) ui.root.replaceWith(next);
      else {
        const after = m.drawer.querySelector('#filter-block_sort') || m.drawer.querySelector('#filter-block_cat');
        after ? after.after(next) : m.drawer.prepend(next);
      }
      const btn = m.toolbar ? buildToolbarButton() : null;
      if (btn) {
        if (ui.toolbarBtn && ui.toolbarBtn.isConnected) ui.toolbarBtn.replaceWith(btn);
        else {
          const filterBtn = m.toolbar.querySelector('#sub-nav_controls_filter-toggle');
          filterBtn ? filterBtn.before(btn) : m.toolbar.append(btn);
        }
      }
      ui.toolbarBtn = btn;
    } else if (ui.mode === 'bar') {
      next = buildBar();
      if (ui.root && ui.root.isConnected) ui.root.replaceWith(next);
      else {
        let host = m.container.querySelector(':scope > .block-filterBar');
        if (!host) {
          host = el('div', { class: 'block-filterBar osf-own-bar osf-ui' });
          m.container.prepend(host);
        }
        host.append(next);
      }
    } else {
      next = buildFloat();
      if (ui.root && ui.root.isConnected) ui.root.replaceWith(next);
      else document.body.append(next);
    }
    ui.root = next;
    updateStats();
  }

  function clearCache() {
    cache = {};
    save(CACHE_KEY, cache);
    errors.clear();
    scan();
    renderControls();
  }
  function retryErrors() {
    const tids = [...errors.keys()];
    errors.clear();
    tids.forEach((tid) => { queue.add(tid); refreshTid(tid); });
    schedulePump(0);
  }

  let statsTimer = null;
  function updateStatsSoon() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => { statsTimer = null; updateStats(); }, 150);
  }

  function updateStats() {
    let shown = 0, hidden = 0, dimmed = 0, unknown = 0, pending = 0;
    for (const item of document.querySelectorAll('[data-osf-tid]')) {
      const a = item.dataset.osfAction;
      const effective = a === 'peek' ? (item.dataset.osfReason === 'unknown' ? settings.unknownPolicy : settings.mismatchStyle) : a;
      if (effective === 'hide') hidden++;
      else if (effective === 'dim') dimmed++;
      else shown++;
      const st = statusFor(item.dataset.osfTid);
      if (st.kind === 'unknown' || st.kind === 'error') unknown++;
      else if (st.kind === 'pending') pending++;
    }
    const filtering = settings.enabled && pageActive() && settings.selected.length > 0;
    const parts = [];
    if (!settings.selected.length) parts.push('Pick an OS to filter');
    else {
      parts.push(`<b>${shown}</b> shown`);
      if (hidden) parts.push(`<b>${hidden}</b> hidden`);
      if (dimmed) parts.push(`<b>${dimmed}</b> dimmed`);
    }
    if (unknown) parts.push(`${unknown} unknown`);
    if (pending) parts.push(`checking ${pending}…`);
    if (Date.now() < pausedUntil) parts.push('site busy, paused');
    const html = parts.join(' · ');
    for (const s of ui.statEls) if (s.innerHTML !== html) s.innerHTML = html; // numbers only, no user data

    const n = hidden + dimmed;
    for (const b of ui.bubbles) {
      b.hidden = !filtering || n === 0;
      b.textContent = String(n);
    }
    if (ui.toolbarBtn) ui.toolbarBtn.firstChild.classList.toggle('is-active', filtering);
    if (ui.cacheBtn) ui.cacheBtn.textContent = `Clear cache (${Object.keys(cache).length})`;
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function hookNavigation() {
    const fire = () => window.dispatchEvent(new Event('osf:navigate'));
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      if (typeof orig !== 'function') continue;
      history[fn] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    }
    const onNav = () => scanSoon(50);
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    window.addEventListener('osf:navigate', onNav);
  }

  const isOurs = (n) => n.nodeType === 1 && (n.classList.contains('osf-tag') || n.classList.contains('osf-ui') || !!n.closest?.('.osf-ui, .osf-tag'));

  function boot() {
    if (!document.body) return setTimeout(boot, 50);
    const style = document.createElement('style');
    style.id = 'osf-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
    hookNavigation();

    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target.nodeType === 1 && m.target.closest('.osf-ui, .osf-tag')) continue; // our own updates
        for (const n of m.addedNodes) if (n.nodeType === 1 && !isOurs(n)) return scanSoon();
        for (const n of m.removedNodes) if (n.nodeType === 1 && !isOurs(n)) return scanSoon();
        // Our controls or tags were removed by a site re-render: put them back.
        for (const n of m.removedNodes) if (n.nodeType === 1 && isOurs(n)) return scanSoon();
      }
    }).observe(document.body, { childList: true, subtree: true });

    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyO') {
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        e.preventDefault();
        togglePanel();
      }
    });

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Show OS filter', () => togglePanel(true));
      GM_registerMenuCommand('Clear OS cache', clearCache);
    }

    // Pick up OS info checked in other tabs.
    window.addEventListener('focus', () => {
      const stored = load(CACHE_KEY, {}) || {};
      for (const [k, v] of Object.entries(stored)) {
        if (!cache[k] || cache[k].t < v.t) cache[k] = v;
      }
      scanSoon(0);
    });

    scan();
    // Latest Updates renders asynchronously; a few early rescans help before mutations settle.
    [500, 1500, 3500].forEach((d) => setTimeout(scan, d));
  }

  // Exposed for debugging in the console: window.__osfParse(text)
  try { window.__osfParse = parseFirstPost; } catch (e) {}

  boot();
})();
