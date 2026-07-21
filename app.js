/* water.io — open water spots. POC: localStorage + JSON + URL sharing. */
(() => {
'use strict';

const KEY = 'water.io.v3';
const SHARE_KEY = 'd';
const MERGE_KEY = 'merge';
const IMAGE_PREFIX = 'water.img.';
const LAST_MODIFIED_KEY = 'water.io.modified';
const SYNC_KEY = 'water.io.sync';
const MERGE_HISTORY_KEY = 'water.io.merges';
const SEEN_KEY = 'water.io.seen';   // { [postId]: commentsSeenCount }
const EMOJI = ['🏊', '🌊', '❄️', '🔥', '👏'];
const COLORS = ['#ffd84d','#f78fc2','#3b5bfd','#3ed598','#b28dff','#ff8a5c','#2fd4e8','#ff5f8d'];
const MAX_LENGTH = 50;
const VERSION = '1.0';

const $ = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

/* ---------- storage ---------- */
const store = (() => {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; }
  catch { let m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => m[k] = v }; }
})();
const persists = store === localStorage;

let db = null;
let lastModified = parseInt(store.getItem(LAST_MODIFIED_KEY)) || Date.now();
let openPostId = null;
let importedIds = new Set();      // post IDs that arrived via the current share URL
let importBannerDismissed = false;
let flashPostId = null;           // ID of the just-posted spot (gets the flash animation)
let flashCommentId = null;        // ID of the just-sent comment (gets the flash animation)
let searchQuery = '';             // current search filter string

/* ---------- ID Generation ---------- */
function genId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 5);
  return ts + rand;
}

function getIdTimestamp(id) {
  if (!id) return 0;
  const tsPart = id.slice(0, -3);
  return parseInt(tsPart, 36) || 0;
}

/* ---------- Database functions ---------- */
function initializeDB() {
  if (!db) {
    db = load();
  }
  if (!db.posts) db.posts = [];
  if (!db.user) db.user = null;
  return db;
}

function load() {
  try {
    // Check for shared state in URL first
    const shared = loadSharedState();
    if (shared) {
      console.log('Loaded shared state from URL');
      const merged = mergeStates(shared);
      if (merged) return merged;
      return shared;
    }
    
    // Try loading from localStorage
    const stored = store.getItem(KEY);
    if (stored) {
      const d = JSON.parse(stored);
      if (d && d.posts && Array.isArray(d.posts)) {
        console.log('Loaded from localStorage:', d);
        return clean(d);
      }
    }
  } catch (e) {
    console.warn('Failed to load data:', e);
  }
  
  // Return default structure with seed data
  console.log('Creating new database with seed data');
  return { user: null, posts: seed() };
}

function save() { 
  try { 
    if (!db || db._shared) return;
    
    // Make sure we're saving the current state
    const dataToSave = {
      user: db.user,
      posts: db.posts
    };
    
    console.log('Saving to localStorage:', dataToSave);
    store.setItem(KEY, JSON.stringify(dataToSave));
    
    const now = Date.now();
    store.setItem(LAST_MODIFIED_KEY, String(now));
    lastModified = now;

    console.log('Save successful. user saved as:', db.user);
  } catch (e) {
    console.warn('Failed to save:', e);
  } 
}

function clean(d) {
  if (!d || typeof d !== 'object') return { user: null, posts: [] };
  
  d.posts = (d.posts || []).filter(p => p && p.user).map(p => ({
    ...p, 
    img: p.img || null,
    reacts: p.reacts || {},
    comments: (p.comments || []).filter(c => c && c.user).map(c => ({ 
      ...c, 
      reacts: c.reacts || {} 
    }))
  }));
  
  return d;
}

/* ---------- SIMPLIFIED MERGE ---------- */
function mergeStates(sharedData) {
  if (!sharedData || !sharedData.posts) return sharedData;
  
  let existing = null;
  try {
    const stored = store.getItem(KEY);
    if (stored) {
      const d = JSON.parse(stored);
      if (d && d.posts && Array.isArray(d.posts)) {
        existing = clean(d);
      }
    }
  } catch (e) {
    console.warn('Failed to load existing data for merge:', e);
  }
  
  if (!existing || !existing.posts || existing.posts.length === 0) {
    if (sharedData._timestamp) {
      store.setItem(SYNC_KEY, String(sharedData._timestamp));
    }
    // Mark all incoming posts as imported so the banner + NEW tags show
    (sharedData.posts || []).forEach(p => { if (p && p.id) importedIds.add(p.id); });
    // Don't carry the sharer's username over — recipient starts with no username
    return { ...sharedData, user: null };
  }
  
  console.log('Merging shared state with existing data...');

  const postMap = new Map();
  existing.posts.forEach(p => {
    if (p && p.id) postMap.set(p.id, p);
  });

  let mergedCount = 0;
  let newComments = 0;
  let newReactions = 0;
  let newPostsAdded = 0;

  sharedData.posts.forEach(p => {
    if (!p || !p.id) return;

    if (postMap.has(p.id)) {
      const existingPost = postMap.get(p.id);

      // Count new reaction users before merging
      Object.entries(p.reacts || {}).forEach(([emoji, users]) => {
        const existing_ = existingPost.reacts[emoji] || [];
        (users || []).forEach(u => { if (!existing_.includes(u)) newReactions++; });
      });
      existingPost.reacts = { ...existingPost.reacts, ...p.reacts };

      const commentMap = new Map();
      (existingPost.comments || []).forEach(c => {
        if (c && c.id) commentMap.set(c.id, c);
      });

      (p.comments || []).forEach(c => {
        if (!c || !c.id) return;
        if (commentMap.has(c.id)) {
          const existingComment = commentMap.get(c.id);
          // Count new reaction users on comments
          Object.entries(c.reacts || {}).forEach(([emoji, users]) => {
            const existing_ = existingComment.reacts[emoji] || [];
            (users || []).forEach(u => { if (!existing_.includes(u)) newReactions++; });
          });
          existingComment.reacts = { ...existingComment.reacts, ...c.reacts };
          if (c.text) existingComment.text = c.text;
        } else {
          commentMap.set(c.id, c);
          newComments++;
        }
      });

      existingPost.comments = Array.from(commentMap.values())
        .sort((a, b) => (a.id || 0) - (b.id || 0));

      if (p.desc) existingPost.desc = p.desc;
      if (p.img) existingPost.img = p.img;
      if (p.lat != null) existingPost.lat = p.lat;
      if (p.lng != null) existingPost.lng = p.lng;
      if (p.place) existingPost.place = p.place;

      mergedCount++;
    } else {
      postMap.set(p.id, p);
      newPostsAdded++;
      importedIds.add(p.id);   // track for WhatsApp-style unread badge
    }
  });

  // Nothing actually changed — silently return existing data, no toast, no history entry
  if (newPostsAdded === 0 && newComments === 0 && newReactions === 0) {
    console.log('No actual changes in shared URL, skipping merge');
    return existing;
  }
  
  const mergedPosts = Array.from(postMap.values())
    .sort((a, b) => {
      const tsA = getIdTimestamp(a.id) || a.ts || 0;
      const tsB = getIdTimestamp(b.id) || b.ts || 0;
      return tsB - tsA;
    });

  const merged = {
    user: existing.user || null,  // never override recipient's username from shared link
    posts: mergedPosts,
    _merged: true,
    _timestamp: Date.now(),
    _sharedTimestamp: sharedData._timestamp || Date.now()
  };

  store.setItem(SYNC_KEY, String(merged._timestamp));

  // Record merge event for sync history
  try {
    const event = {
      ts: Date.now(),
      from: sharedData.user || null,
      newPosts: newPostsAdded,
      newComments,
      newReactions,
      postsMerged: mergedCount,
      totalPosts: mergedPosts.length
    };
    const raw = store.getItem(MERGE_HISTORY_KEY);
    const hist = raw ? JSON.parse(raw) : [];
    hist.unshift(event);
    store.setItem(MERGE_HISTORY_KEY, JSON.stringify(hist.slice(0, 20)));
  } catch(e) {}

  try {
    store.setItem(KEY, JSON.stringify(merged));
  } catch(e) {
    console.warn('Failed to save merged data:', e);
  }

  // Toast suppressed — import banner in renderList() handles the notification
  
  return merged;
}

/* ---------- URL sharing ---------- */
function shareState() {
  try {
    if (!db || !db.posts) return null;
    
    const cleanData = {
      user: db.user || null,
      posts: db.posts.map(p => {
        if (!p) return null;
        const isDataUrl = p.img && p.img.startsWith('data:');
        return {
          ...p,
          img: isDataUrl ? storeImage(p.img) : p.img,
          _imgData: undefined
        };
      }).filter(p => p !== null),
      _timestamp: Date.now(),
      _version: '2.0'
    };
    
    const json = JSON.stringify(cleanData);
    let compressed;
    
    if (window.LZString) {
      compressed = LZString.compressToEncodedURIComponent(json);
    } else {
      compressed = encodeURIComponent(json);
    }
    
    const url = new URL(window.location);
    url.searchParams.set(SHARE_KEY, compressed);
    url.searchParams.delete('img');
    url.searchParams.delete(MERGE_KEY);
    
    return url.toString();
  } catch(e) {
    console.warn('Share failed:', e);
    return null;
  }
}

function loadSharedState() {
  try {
    const params = new URLSearchParams(window.location.search);
    const data = params.get(SHARE_KEY);
    if (!data) return null;
    
    let json;
    if (window.LZString) {
      json = LZString.decompressFromEncodedURIComponent(data);
    } else {
      json = decodeURIComponent(data);
    }
    
    if (!json) return null;
    const parsed = JSON.parse(json);
    
    if (!parsed.posts || !Array.isArray(parsed.posts)) return null;
    
    parsed.posts = parsed.posts.map(p => {
      if (!p) return null;
      if (p.img && typeof p.img === 'string' && !p.img.startsWith('data:')) {
        const stored = loadImage(p.img);
        if (stored) {
          return { ...p, img: stored };
        }
      }
      return p;
    }).filter(p => p !== null);
    
    return parsed;
  } catch(e) {
    console.warn('Failed to load shared state:', e);
    return null;
  }
}

/* ---------- Image storage helpers ---------- */
function storeImage(dataUrl) {
  if (!dataUrl) return null;
  const id = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  try {
    store.setItem(IMAGE_PREFIX + id, dataUrl);
    return id;
  } catch(e) {
    console.warn('Failed to store image:', e);
    return null;
  }
}

function loadImage(id) {
  if (!id) return null;
  try {
    const data = store.getItem(IMAGE_PREFIX + id);
    if (data && data.startsWith('data:')) {
      return data;
    }
  } catch(e) {
    console.warn('Failed to load image:', e);
  }
  return null;
}

/* ---------- helpers ---------- */
const colorFor = (name = '?') => COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

function ago(ts) {
  if (!ts) return 'just now';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hour' + (h > 1 ? 's' : '') + ' ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + ' day' + (d > 1 ? 's' : '') + ' ago';
  const w = Math.floor(d / 7);
  return w + ' week' + (w > 1 ? 's' : '') + ' ago';
}

function avatar(name, small) {
  name = name || 'Anon';
  const b = el('button', 'avatar' + (small ? ' sm' : ''), name.charAt(0).toUpperCase());
  b.style.background = colorFor(name);
  return b;
}

const PLANE = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M2 20.5c2.6.7 4.6-.3 4.6-1.9 0-1-1.2-1.5-1.9-.8-.8.8-.1 2.3 1.5 2.9 1.6.6 3.4.2 4.6-.9"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M21.4 2.6 9.9 13.2m11.5-10.6-6.6 18.2-3.6-7.6-7.6-3.6 17.8-7z"
        stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="currentColor" fill-opacity=".15"/>
</svg>`;

/* ---------- EXIF GPS ---------- */
function exifGPS(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let p = 2;
    while (p < v.byteLength - 4) {
      if (v.getUint16(p) !== 0xFFE1) { p += 2 + v.getUint16(p + 2); continue; }
      const tiff = p + 10;
      const le = v.getUint16(tiff) === 0x4949;
      const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
      let ifd = tiff + u32(tiff + 4), gps = 0;
      for (let i = 0, n = u16(ifd); i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x8825) gps = tiff + u32(e + 8);
      }
      if (!gps) return null;

      const tags = {};
      for (let i = 0, n = u16(gps); i < n; i++) {
        const e = gps + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        const off = cnt * (type === 5 ? 8 : 1) > 4 ? tiff + u32(e + 8) : e + 8;
        if (type === 2) tags[tag] = String.fromCharCode(v.getUint8(off));
        if (type === 5) tags[tag] = [...Array(cnt)].map((_, k) => u32(off + k * 8) / u32(off + k * 8 + 4));
      }
      const dms = a => a && a.length === 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null;
      const lat = dms(tags[2]), lng = dms(tags[4]);
      if (lat == null || lng == null) return null;
      return {
        lat: +((tags[1] === 'S' ? -lat : lat).toFixed(6)),
        lng: +((tags[3] === 'W' ? -lng : lng).toFixed(6))
      };
    }
    return null;
  } catch(e) {
    console.warn('EXIF parsing failed:', e);
    return null;
  }
}

function shrink(file, max = 900) {
  return new Promise(res => {
    try {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = el('canvas');
        c.width = img.width * s; c.height = img.height * s;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => res(null);
      img.src = URL.createObjectURL(file);
    } catch(e) {
      res(null);
    }
  });
}

/* ---------- unread / seen tracking ---------- */
const lastTs = p => (p.comments||[]).reduce(
  (m, c) => Math.max(m, c.ts || getIdTimestamp(c.id) || 0),
  p.ts || getIdTimestamp(p.id) || 0
);

function clockTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

const STAMP_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function listStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return clockTime(ts);
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  const diff = Math.floor((now - d) / 864e5);
  if (diff < 7) return STAMP_DAYS[d.getDay()];
  return d.getDate() + '/' + (d.getMonth() + 1);
}

function readSeen() {
  try { return JSON.parse(store.getItem(SEEN_KEY)) || {}; } catch { return {}; }
}
function writeSeen(map) {
  try { store.setItem(SEEN_KEY, JSON.stringify(map)); } catch {}
}
function unreadCount(p) {
  const seen = readSeen();
  const total = (p.comments || []).length;
  if (!(p.id in seen)) return total + 1;   // never opened: spot itself = 1 unread
  return Math.max(0, total - seen[p.id]);
}
function markRead(p) {
  const seen = readSeen();
  seen[p.id] = (p.comments || []).length;
  writeSeen(seen);
}

/* ---------- render (WhatsApp-style list) ---------- */
function render() { renderList(); }

function renderList() {
  initializeDB();
  const feed = $('#feed');
  if (!feed) return;
  feed.innerHTML = '';

  const me = $('#btnMe');
  if (me) {
    me.textContent = db.user ? db.user.charAt(0).toUpperCase() : '?';
    me.style.background = db.user ? colorFor(db.user) : '#c9d1d9';
  }
  const shareBtn = $('#btnShare');
  if (shareBtn) shareBtn.style.display = db.posts && db.posts.length > 0 ? 'flex' : 'none';
  updateSyncPill();
  updateSharePreview();

  if (!db.posts || db.posts.length === 0) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = `<span style="font-size:48px;display:block;margin-bottom:12px;">🏊</span><h3 style="margin:0 0 8px;">No spots yet</h3><p style="color:var(--mut);margin:0;font-size:14px;">Tap + to add your first water spot</p>`;
    empty.style.cssText = 'text-align:center;padding:60px 20px;color:var(--mut);';
    feed.append(empty);
    return;
  }

  // Import banner (shown once after URL-share merge)
  if (importedIds.size > 0 && !importBannerDismissed) {
    const fromUsers = [...new Set(
      [...importedIds].map(id => (db.posts.find(p => p.id === id)||{}).user).filter(Boolean)
    )];
    const names = fromUsers.length <= 2 ? fromUsers.join(' & ') : `${fromUsers[0]} & ${fromUsers.length - 1} others`;
    const count = importedIds.size;
    const banner = el('div', 'import-banner');
    const avs = el('div', 'import-banner-avs');
    fromUsers.slice(0, 3).forEach(u => avs.append(avatar(u, true)));
    const msg = el('div', 'import-banner-msg');
    msg.innerHTML = `<b>${count} new spot${count !== 1 ? 's' : ''}</b> from ${names}`;
    const x = el('button', 'import-banner-x', '×');
    x.onclick = e => { e.stopPropagation(); importBannerDismissed = true; banner.remove(); };
    banner.append(avs, msg, x);
    feed.append(banner);
  }

  // Search filter
  const matchesSearch = p => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (p.place||'').toLowerCase().includes(q) ||
           (p.desc||'').toLowerCase().includes(q) ||
           (p.user||'').toLowerCase().includes(q) ||
           (p.comments||[]).some(c => (c.text||'').toLowerCase().includes(q) || (c.user||'').toLowerCase().includes(q));
  };

  // WhatsApp sort: unread first (newest → oldest), then read (newest → oldest)
  const byTs = (a, b) => lastTs(b) - lastTs(a);
  const unread = db.posts.filter(p => p && unreadCount(p) > 0 && matchesSearch(p)).sort(byTs);
  const read   = db.posts.filter(p => p && unreadCount(p) === 0 && matchesSearch(p)).sort(byTs);

  // No-results state when searching
  if (searchQuery && unread.length === 0 && read.length === 0) {
    const empty = el('div', '');
    empty.style.cssText = 'text-align:center;padding:40px 20px;';
    empty.innerHTML = `<span style="font-size:32px;display:block;margin-bottom:8px;">🔍</span><p style="color:var(--mut);font-size:14px;margin:0">No spots match "<b>${searchQuery}</b>"</p>`;
    feed.append(empty);
    flashPostId = null;
    return;
  }

  // Flat list when searching (no section dividers)
  if (searchQuery) {
    [...unread, ...read].forEach(p => feed.append(waRow(p, unreadCount(p))));
    flashPostId = null;
    return;
  }

  let shownReadDiv = false;
  [...unread, ...read].forEach((p, i) => {
    const n = unreadCount(p);
    if (i === 0 && unread.length > 0) {
      feed.append(sectionHead(`${unread.length} unread`));
    }
    if (n === 0 && !shownReadDiv && unread.length > 0) {
      feed.append(sectionHead('Earlier', true));
      shownReadDiv = true;
    }
    feed.append(waRow(p, n));
  });
  flashPostId = null;   // only flash on the render immediately after posting
}

function sectionHead(text, muted) {
  return el('div', 'wa-section-head' + (muted ? ' wa-section-muted' : ''), text);
}

function waRow(p, n) {
  const isImported = importedIds.has(p.id);
  const isNew = p.id === flashPostId;
  const row = el('div', 'wa-row' + (n > 0 ? ' wa-row-unread' : '') + (isImported ? ' wa-row-imported' : '') + (isNew ? ' flash-new' : ''));

  // Avatar
  const av = avatar(p.user || 'Anon');
  row.append(av);

  // Body
  const body = el('div', 'wa-row-body');
  const titleRow = el('div', 'wa-row-titlerow');
  titleRow.append(el('span', 'wa-row-title', p.place || p.desc || 'Spot'));
  if (isImported) titleRow.append(el('span', 'wa-new-tag', 'NEW'));
  body.append(titleRow);

  const cmts = p.comments || [];
  const last = cmts[cmts.length - 1];
  const preview = el('div', 'wa-row-preview');
  if (last) {
    const name = el('b', null, (db.user && last.user === db.user ? 'You' : last.user) + ': ');
    preview.append(name, document.createTextNode(last.text));
  } else {
    preview.textContent = p.desc || '';
  }
  body.append(preview);
  row.append(body);

  // Side: time + badge
  const side = el('div', 'wa-row-side');
  side.append(el('span', 'wa-row-time', listStamp(lastTs(p))));
  if (n > 0) side.append(el('span', 'wa-badge', n > 99 ? '99+' : String(n)));
  row.append(side);

  row.onclick = () => openThread(p.id);
  return row;
}



function card(p) {
  if (!p) return el('div');

  const c = el('div', 'card');

  const head = el('div', 'card-head');
  head.append(avatar(p.user || 'Anon', true));
  const meta = el('div');
  const postTime = getIdTimestamp(p.id);
  meta.append(el('div', 'who', p.user || 'Anon'), el('div', 'when', ago(postTime || p.ts)));
  head.append(meta);
  c.append(head, el('p', 'desc', p.desc || ''));

  if (p.img) {
    const imgContainer = el('div', 'img-container');
    
    if (p.img.startsWith('data:')) {
      const i = el('img', 'shot');
      i.src = p.img;
      i.alt = p.desc || 'Spot photo';
      imgContainer.append(i);
    } else {
      const loaded = loadImage(p.img);
      if (loaded) {
        const i = el('img', 'shot');
        i.src = loaded;
        i.alt = p.desc || 'Spot photo';
        imgContainer.append(i);
      } else {
        const placeholder = el('div', 'img-placeholder');
        placeholder.innerHTML = `
          <span>📷</span>
          <span>Photo not available</span>
        `;
        imgContainer.append(placeholder);
        imgContainer.dataset.imgId = p.img;
      }
    }
    c.append(imgContainer);
  }

  const link = mapLink(p);
  if (link) {
    const a = el('a', 'geo', '📍 ' + link.label);
    a.href = link.url; a.target = '_blank'; a.rel = 'noopener';
    c.append(a);
  }

  c.append(reacts(p.reacts || {}, refresh, p), comments(p));
  return c;
}

const refresh = () => { save(); render(); };

/* ========== THREAD VIEW ========== */
function openThread(id) {
  const p = db.posts.find(x => x.id === id);
  if (!p) return;
  openPostId = id;
  markRead(p);
  importedIds.delete(id);
  renderThread();

  const tv  = $('#threadView');
  const fab = $('#btnNew');
  const sb  = $('#searchBar');
  if (tv)  { tv.hidden = false; requestAnimationFrame(() => tv.classList.add('thread-open')); }
  if (fab) fab.style.display = 'none';
  if (sb)  sb.style.display = 'none';

  // Push a history entry so the back gesture closes the thread
  window.history.pushState({ waterThread: id }, '');

  setTimeout(() => { const b = $('#threadBody'); if (b) b.scrollTop = b.scrollHeight; }, 60);
}

function closeThread(fromPopstate) {
  const tv  = $('#threadView');
  const fab = $('#btnNew');
  if (tv)  { tv.classList.remove('thread-open'); setTimeout(() => { tv.hidden = true; }, 300); }
  if (fab) fab.style.display = '';
  const sb  = $('#searchBar');
  if (sb)  sb.style.display = '';
  openPostId = null;
  // If closed by the back button/gesture the history entry is already gone;
  // if closed by the in-app back arrow we need to pop it ourselves.
  if (!fromPopstate) window.history.back();
  renderList();
}

function renderThread() {
  const p = db.posts.find(x => x.id === openPostId);
  if (!p) { closeThread(); return; }

  // Header
  const av = $('#threadAv');
  if (av) { av.textContent = (p.user||'?').charAt(0).toUpperCase(); av.style.background = colorFor(p.user||'?'); }
  const titleEl = $('#threadTitle');
  if (titleEl) titleEl.textContent = p.place || p.desc || 'Spot';
  const subEl = $('#threadSub');
  if (subEl) {
    const n = (p.comments||[]).length;
    subEl.textContent = p.user + (n > 0 ? ` · ${n} comment${n === 1 ? '' : 's'}` : '');
  }

  // Body
  const body = $('#threadBody');
  if (!body) return;
  body.innerHTML = '';
  body.append(spotBody(p));
  (p.comments||[])
    .slice()
    .sort((a,b) => (a.ts||getIdTimestamp(a.id)||0) - (b.ts||getIdTimestamp(b.id)||0))
    .forEach(c => body.append(commentBubble(p, c)));
  flashCommentId = null;  // only flash on the render immediately after sending
}

/* Spot card for thread view — same look as card() but no inline comment form */
function spotBody(p) {
  const c = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(avatar(p.user || 'Anon', true));
  const meta = el('div');
  const postTime = getIdTimestamp(p.id);
  meta.append(el('div', 'who', p.user || 'Anon'), el('div', 'when', ago(postTime || p.ts)));
  head.append(meta);
  c.append(head, el('p', 'desc', p.desc || ''));

  if (p.img) {
    const imgContainer = el('div', 'img-container');
    if (p.img.startsWith('data:')) {
      const i = el('img', 'shot'); i.src = p.img; i.alt = p.desc||''; imgContainer.append(i);
    } else {
      const loaded = loadImage(p.img);
      if (loaded) { const i = el('img', 'shot'); i.src = loaded; i.alt = p.desc||''; imgContainer.append(i); }
    }
    c.append(imgContainer);
  }

  const link = mapLink(p);
  if (link) {
    const a = el('a', 'geo', '📍 ' + link.label);
    a.href = link.url; a.target = '_blank'; a.rel = 'noopener';
    c.append(a);
  }

  // Static map preview — only rendered when spot is opened, uses user's saved map style
  if (p.lat != null && p.lng != null) {
    const previewId = 'smp_' + p.id + '_' + Date.now();
    const mapDiv = el('div', 'spot-map-preview');
    mapDiv.id = previewId;
    c.append(mapDiv);

    setTimeout(() => {
      const container = document.getElementById(previewId);
      if (!container || !window.L) return;

      const style = store.getItem('water.io.mapStyle') || 'voyager';
      const tiles = MAP_TILES[style] || MAP_TILES.voyager;

      const miniMap = L.map(container, {
        dragging: false, zoomControl: false, scrollWheelZoom: false,
        doubleClickZoom: false, touchZoom: false, keyboard: false,
        tap: false, attributionControl: false,
      }).setView([p.lat, p.lng], 14);

      L.tileLayer(tiles.url, { maxZoom: 19 }).addTo(miniMap);

      const pin = L.divIcon({
        className: '',
        html: `<svg width="20" height="26" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
          <path d="M14 0C6.27 0 0 6.27 0 14c0 9.625 14 22 14 22S28 23.625 28 14C28 6.27 21.73 0 14 0z" fill="#ff7322"/>
          <circle cx="14" cy="14" r="6" fill="#fff"/>
        </svg>`,
        iconSize: [20, 26], iconAnchor: [10, 26],
      });
      L.marker([p.lat, p.lng], { icon: pin }).addTo(miniMap);
    }, 60);
  }

  c.append(reacts(p.reacts||{}, () => { save(); renderThread(); }, p));
  return c;
}

/* Individual comment row for thread view */
function commentBubble(p, cm) {
  const row = el('div', cm.id === flashCommentId ? 'cm flash-new' : 'cm');
  row.append(avatar(cm.user || 'Anon', true));
  const body = el('div', 'cm-body');
  const m = el('div', 'cm-meta');
  const commentTime = getIdTimestamp(cm.id);
  m.append(el('b', null, cm.user||'Anon'), document.createTextNode(' · ' + ago(commentTime||cm.ts)));
  body.append(m, el('p', 'cm-text', cm.text||''));
  body.append(reacts(cm.reacts||{}, () => { save(); renderThread(); }, p));
  row.append(body);
  return row;
}

/* Thread composer wiring */
const threadInput = $('#threadInput');
const threadCount = $('#threadCount');
if (threadInput && threadCount) {
  threadInput.oninput = () => {
    const len = threadInput.value.length;
    threadCount.textContent = len + '/' + MAX_LENGTH;
    threadCount.style.color = len >= MAX_LENGTH ? 'var(--orange)' : '#b6bcc4';
  };
}

const threadComposer = $('#threadComposer');
if (threadComposer) {
  threadComposer.onsubmit = e => {
    e.preventDefault();
    const text = (threadInput ? threadInput.value.trim() : '').slice(0, MAX_LENGTH);
    if (!text) return;
    const submit = () => {
      const p = db.posts.find(x => x.id === openPostId);
      if (!p) return;
      const newComment = { id: genId(), user: db.user, text, ts: Date.now(), reacts: {} };
      flashCommentId = newComment.id;   // flash this bubble when thread re-renders
      (p.comments = p.comments || []).push(newComment);
      save();
      markRead(p);
      if (threadInput) threadInput.value = '';
      if (threadCount) threadCount.textContent = '0/' + MAX_LENGTH;
      renderThread();
      setTimeout(() => { const b = $('#threadBody'); if (b) b.scrollTop = b.scrollHeight; }, 30);
    };
    if (!requireUser(submit)) return;
    submit();
  };
}

if ($('#threadBack')) $('#threadBack').onclick = () => closeThread(false);

// Back gesture / hardware back button closes the thread
window.addEventListener('popstate', (e) => {
  if (openPostId) closeThread(true);
});

/* ---------- search ---------- */
if ($('#searchInput')) {
  $('#searchInput').oninput = e => {
    searchQuery = e.target.value; // keep raw spacing; matchesSearch trims internally
    const clear = $('#searchClear');
    if (clear) clear.hidden = !searchQuery;
    renderList();
  };
}
if ($('#searchClear')) {
  $('#searchClear').onclick = () => {
    searchQuery = '';
    const inp = $('#searchInput');
    if (inp) inp.value = '';
    $('#searchClear').hidden = true;
    renderList();
  };
}

const MAPS = 'https://www.google.com/maps/search/?api=1&query=';
function mapLink(p) {
  if (!p) return null;
  if (p.lat != null && p.lng != null) {
    return { label: p.place || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`, url: MAPS + `${p.lat},${p.lng}` };
  }
  if (p.place) return { label: p.place, url: MAPS + encodeURIComponent(p.place) };
  return null;
}

/* ---------- REACTIONS ---------- */
function reacts(map, done, parent) {
  const wrap = el('div', 'reacts');
  
  if (!map) map = {};
  
  const entries = Object.entries(map).filter(([, u]) => u && u.length);
  entries.sort((a, b) => b[1].length - a[1].length);
  
  entries.forEach(([e, users]) => {
    const b = el('button', 'chip' + (users.includes(db.user) ? ' on' : ''), `${e} ${users.length}`);
    b.onclick = (ev) => {
      ev.stopPropagation();
      const doToggle = () => {
        toggle(map, e);
        done();
        const hasReactions = Object.values(map).some(u => u && u.length > 0);
        if (hasReactions) showReactionBottomSheet(map);
      };
      if (!requireUser(doToggle)) return;
      doToggle();
    };
    wrap.append(b);
  });

  const add = el('button', 'chip add', '☺');
  add.onclick = () => {
    const showPicker = () => {
      const picker = el('div', 'reacts');
      EMOJI.forEach(e => {
        const b = el('button', 'chip', e);
        b.onclick = () => { toggle(map, e); done(); };
        picker.append(b);
      });
      add.replaceWith(picker);
    };
    if (!requireUser(showPicker)) return;
    showPicker();
  };
  wrap.append(add);
  return wrap;
}

function toggle(map, e) {
  if (!requireUser()) {
    console.warn('Cannot toggle reaction: No user set');
    return;
  }
  // One reaction per user: remove from all other emojis first
  Object.keys(map).forEach(k => {
    if (k !== e) map[k] = (map[k] || []).filter(u => u !== db.user);
  });
  if (!map[e]) map[e] = [];
  const u = map[e];
  const i = u.indexOf(db.user);
  i < 0 ? u.push(db.user) : u.splice(i, 1);
}

/* ---------- Reaction Bottom Sheet ---------- */
let currentReactionContext = null;

function showReactionBottomSheet(map) {
  const sheet = $('#reactionSheet');
  const title = $('#reactionTitle');
  const userList = $('#reactionUsers');
  const picker = $('#reactionPicker');

  if (!sheet || !title || !userList) return;

  title.textContent = 'Reactions';

  userList.innerHTML = '';
  const entries = Object.entries(map).filter(([, u]) => u && u.length);
  entries.sort((a, b) => b[1].length - a[1].length);

  if (entries.length === 0) {
    const empty = el('p', null, 'No reactions yet');
    empty.style.cssText = 'color:var(--mut);font-size:14px;margin:8px 0';
    userList.append(empty);
  } else {
    entries.forEach(([e, users]) => {
      const item = el('div', 'reaction-user');
      const emojiEl = el('span', null, e);
      emojiEl.style.fontSize = '18px';
      const namesEl = el('span', null, users.map(u => u === db.user ? 'You' : u).join(', '));
      namesEl.style.cssText = 'font-size:13px;color:var(--mut);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      item.append(emojiEl, namesEl);
      userList.append(item);
    });
  }

  if (picker) picker.innerHTML = '';

  sheet.hidden = false;
  sheet.style.display = 'flex';
  sheet.style.opacity = '1';
  sheet.style.pointerEvents = 'auto';
  setTimeout(() => sheet.classList.add('visible'), 10);
}

function hideReactionSheet() {
  const sheet = $('#reactionSheet');
  if (!sheet) return;
  sheet.classList.remove('visible');
  setTimeout(() => {
    sheet.hidden = true;
    sheet.style.display = '';
    sheet.style.opacity = '';
    sheet.style.pointerEvents = '';
  }, 300);
  currentReactionContext = null;
}

/* ---------- COMMENTS ---------- */
function comments(p) {
  const box = el('div', 'comments');
  
  if (!p.comments) p.comments = [];
  
  p.comments.forEach(cm => {
    if (!cm) return;
    const row = el('div', 'cm');
    row.append(avatar(cm.user || 'Anon', true));
    const body = el('div', 'cm-body');
    const m = el('div', 'cm-meta');
    const commentTime = getIdTimestamp(cm.id);
    m.append(el('b', null, cm.user || 'Anon'), document.createTextNode(' · ' + ago(commentTime || cm.ts)));
    body.append(m, el('p', 'cm-text', cm.text || ''), reacts(cm.reacts || {}, refresh, p));
    row.append(body);
    box.append(row);
  });

  const form = el('form', 'cm-form');
  const input = el('input');
  input.placeholder = 'Your reply (max ' + MAX_LENGTH + ')';
  input.maxLength = MAX_LENGTH;
  
  const counter = el('span', 'cm-counter', '0/' + MAX_LENGTH);
  counter.style.cssText = 'font-size:10px;color:#b6bcc4;white-space:nowrap;flex:0 0 auto;';
  
  input.oninput = () => {
    const len = input.value.length;
    counter.textContent = len + '/' + MAX_LENGTH;
    counter.style.color = len >= MAX_LENGTH ? 'var(--orange)' : '#b6bcc4';
  };
  
  const btn = el('button', 'send');
  btn.type = 'submit';
  btn.setAttribute('aria-label', 'Send reply');
  btn.innerHTML = PLANE;
  
  const inputWrap = el('div', 'cm-input-wrap');
  inputWrap.style.cssText = 'display:flex;gap:7px;align-items:center;flex:1;';
  inputWrap.append(input, counter);
  
  form.append(inputWrap, btn);
  form.onsubmit = ev => {
    ev.preventDefault();
    const t = input.value.trim();
    if (!t) { showToast('Please enter a comment'); return; }
    if (t.length > MAX_LENGTH) { showToast('Comment too long! Max ' + MAX_LENGTH + ' characters'); return; }

    const submitComment = () => {
      if (!p.comments) p.comments = [];
      p.comments.push({ id: genId(), user: db.user, text: t, ts: Date.now(), reacts: {} });
      refresh();
    };

    if (!requireUser(submitComment)) return;
    submitComment();
  };
  box.append(form);
  return box;
}

/* ---------- sheets ---------- */
const show = s => {
  const el = $(s);
  if (el) {
    el.hidden = false;
    el.style.display = 'flex';
    el.style.opacity = '1';
    el.style.pointerEvents = 'auto';
    if (el.classList.contains('bottom-sheet')) {
      setTimeout(() => el.classList.add('visible'), 10);
    }
  }
};

const hide = s => {
  const el = $(s);
  if (el) {
    if (el.classList.contains('bottom-sheet')) {
      el.classList.remove('visible');
      setTimeout(() => { 
        el.hidden = true;
        el.style.display = 'none';
      }, 300);
    } else {
      el.hidden = true;
      el.style.display = 'none';
    }
  }
};

function requireUser(pendingFn) {
  console.log('requireUser called, db.user:', db.user);

  if (db.user && db.user.trim() !== '') {
    console.log('User exists:', db.user);
    return true;
  }

  pendingAction = pendingFn || null;
  console.log('No user found, showing name sheet');
  
  const sheet = $('#nameSheet');
  if (sheet) {
    sheet.hidden = false;
    sheet.style.display = 'flex';
    sheet.style.opacity = '1';
    sheet.style.pointerEvents = 'auto';
    setTimeout(() => {
      sheet.classList.add('visible');
    }, 10);
    console.log('Name sheet should now be visible');
  } else {
    console.error('Name sheet element not found!');
  }
  
  const input = $('#nameInput');
  if (input) {
    input.value = '';
    setTimeout(() => {
      input.focus();
      input.select();
    }, 100);
  }
  
  return false;
}

/* ---------- Name Sheet ---------- */
$('#nameSave').onclick = () => {
  const input = $('#nameInput');
  if (!input) return;
  
  const name = input.value.trim();
  console.log('Name input value:', name);
  
  if (!name || name === '') {
    showToast('Please enter a username');
    input.focus();
    return;
  }
  
  // Save the username
  db.user = name;
  console.log('User set to:', db.user);
  
  // Save to localStorage immediately
  save();
  
  // Hide the sheet properly
  const sheet = $('#nameSheet');
  if (sheet) {
    sheet.classList.remove('visible');
    sheet.style.display = 'none';
    sheet.hidden = true;
  }
  
  // Refresh the UI
  showToast('Welcome, ' + name + '!');

  if (pendingPost) {
    pendingPost = false;
    doPost(); // calls refresh() internally
  } else if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    action(); // calls refresh() internally (or will after emoji pick)
  } else {
    render(); // no pending action — just update the avatar etc.
  }
};

$('#nameCancel').onclick = () => {
  pendingPost = false;
  pendingAction = null;
  const sheet = $('#nameSheet');
  if (sheet) {
    sheet.classList.remove('visible');
    sheet.style.display = 'none';
    sheet.hidden = true;
  }
};

$('#btnMe').onclick = () => { 
  const input = $('#nameInput');
  if (input) {
    input.value = db.user || ''; 
  }
  
  const sheet = $('#nameSheet');
  if (sheet) {
    sheet.hidden = false;
    sheet.style.display = 'flex';
    sheet.style.opacity = '1';
    sheet.style.pointerEvents = 'auto';
    setTimeout(() => {
      sheet.classList.add('visible');
    }, 10);
  }
  
  if (input) {
    setTimeout(() => {
      input.focus();
      input.select();
    }, 100);
  }
};

$('#nameInput').addEventListener('keydown', (e) => { 
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#nameSave').click();
  }
});

// Close name sheet on backdrop click - but only if user wants to
document.querySelectorAll('.sheet-wrap').forEach(w => {
  if (!w) return;
  w.onclick = e => { 
    if (e.target === w) {
      if (w.id === 'shareModal') {
        hideShareModal();
      } else if (w.id === 'reactionSheet') {
        hideReactionSheet();
      } else if (w.id === 'syncSheet') {
        hideSyncSheet();
      } else if (w.id === 'nameSheet') {
        // Don't close on backdrop click for name sheet
        return;
      } else {
        w.hidden = true;
        w.style.display = 'none';
      }
    }
  };
});

// Close reaction sheet function
function closeReactionSheet() {
  hideReactionSheet();
}

// Close on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeReactionSheet();
    hideShareModal();
    hideSyncSheet();
  }
});

/* ---------- new post ---------- */
let draft = { img: null, lat: null, lng: null, place: '' };
let pendingPost = false;
let pendingAction = null; // reaction or comment waiting for username

function validatePost() {
  const descVal = (($('#pDesc') || {}).value || '').trim();
  const hasDesc = descVal.length > 0;
  const placeVal = (($('#pPlace') || {}).value || '').trim();
  const hasLoc = draft.lat != null || placeVal.length > 0;

  const needsName = !db.user || !db.user.trim();
  const nameVal = (($('#pName') || {}).value || '').trim();
  const hasName = !needsName || nameVal.length > 0;

  const required = needsName ? 3 : 2;
  const fillCount = (hasDesc ? 1 : 0) + (hasLoc ? 1 : 0) + (needsName ? (hasName ? 1 : 0) : 0);

  const btn = $('#postSave');
  if (!btn) return;
  btn.disabled = fillCount < required;
  btn.classList.toggle('fill-half', fillCount > 0 && fillCount < required);
  btn.classList.toggle('fill-full', fillCount === required);
  btn.style.backgroundPosition = fillCount === required
    ? ''
    : (100 - (fillCount / required) * 100) + '% 50%';
}

function doPost() {
  const descInput = $('#pDesc');
  if (!descInput) return;
  const desc = descInput.value.trim().slice(0, MAX_LENGTH);
  if (!db.posts) db.posts = [];
  const newId = genId();
  flashPostId = newId;   // flash this row when list re-renders
  db.posts.push({
    id: newId,
    user: db.user,
    desc,
    img: draft.img,
    lat: draft.lat,
    lng: draft.lng,
    place: draft.place,
    ts: Date.now(),
    reacts: {},
    comments: []
  });
  hide('#postSheet');
  refresh();
  showToast('Spot added!');
}

const GEO_DETECT_SVG = '<svg viewBox="0 0 20 20" width="30" height="30" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8.5" fill="none" stroke="#8b939d" stroke-width="1.5"/><polygon points="10,2.5 13,10 7,10" fill="#e63946"/><polygon points="10,17.5 13,10 7,10" fill="#8b939d" opacity="0.45"/><circle cx="10" cy="10" r="2.2" fill="#ffffff" stroke="#8b939d" stroke-width="1.2"/></svg>';

function showLocationPicker() {
  const picker = $('#locationPicker');
  const bar = $('#geoBar');
  const detectBtn = $('#geoDetect');
  if (picker) { picker.hidden = false; picker.style.display = 'flex'; }
  if (bar) { bar.hidden = true; bar.style.display = 'none'; }
  if (detectBtn) { detectBtn.innerHTML = GEO_DETECT_SVG; detectBtn.disabled = false; }
}

function confirmGeo(text) {
  const picker = $('#locationPicker');
  const bar = $('#geoBar');
  if (picker) { picker.hidden = true; picker.style.display = 'none'; }
  if (bar) { bar.hidden = false; bar.style.display = 'flex'; bar.className = 'geobar ok'; }
  const textEl = $('#geoText');
  if (textEl) textEl.textContent = text;
}

function useCoords(lat, lng, from) {
  draft.lat = lat; draft.lng = lng;
  confirmGeo(`${lat.toFixed(4)}, ${lng.toFixed(4)} · from ${from}`);
  validatePost();
}

$('#btnNew').onclick = () => {
  draft = { img: null, lat: null, lng: null, place: '' };
  const desc = $('#pDesc');
  const place = $('#pPlace');
  const fileInput = $('#pImg');
  if (desc) desc.value = '';
  if (place) place.value = '';
  if (fileInput) fileInput.value = '';
  updateDescCounter();
  clearPhoto();

  // Ask for a username inline when we don't have one yet
  const namePicker = $('#namePicker');
  const nameField = $('#pName');
  const needsName = !db.user || !db.user.trim();
  if (namePicker) {
    namePicker.hidden = !needsName;
    namePicker.style.display = needsName ? 'flex' : 'none';
  }
  if (nameField) nameField.value = needsName ? '' : db.user;

  showLocationPicker();
  validatePost();
  show('#postSheet');
  setTimeout(() => {
    const first = (!db.user || !db.user.trim()) ? $('#pName') : $('#pDesc');
    if (first) first.focus();
  }, 350);
};

$('#postCancel').onclick = () => hide('#postSheet');

function updateDescCounter() {
  const input = $('#pDesc');
  const counter = $('#descCount');
  if (input && counter) {
    const len = input.value.length;
    counter.textContent = len + '/' + MAX_LENGTH;
    counter.style.color = len >= MAX_LENGTH ? 'var(--orange)' : '#b6bcc4';
  }
}

if ($('#pDesc')) {
  $('#pDesc').oninput = () => { updateDescCounter(); validatePost(); };
}

if ($('#pPlace')) {
  $('#pPlace').oninput = e => { draft.place = e.target.value.trim(); validatePost(); };
}

if ($('#pName')) {
  $('#pName').oninput = () => validatePost();
}

if ($('#geoDetect')) {
  $('#geoDetect').onclick = () => {
    const btn = $('#geoDetect');
    if (!navigator.geolocation) {
      showToast('Location not available on this device');
      return;
    }
    if (btn) { btn.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8.5" fill="none" stroke="#ff7322" stroke-width="1.5"/><polygon points="10,2.5 13,10 7,10" fill="#ff7322"/><polygon points="10,17.5 13,10 7,10" fill="#ff7322" opacity="0.45"/><circle cx="10" cy="10" r="2.2" fill="#ffffff" stroke="#ff7322" stroke-width="1.2"/></svg>'; btn.disabled = true; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (btn) btn.disabled = false;
        useCoords(+pos.coords.latitude.toFixed(6), +pos.coords.longitude.toFixed(6), 'your device');
      },
      () => {
        if (btn) { btn.innerHTML = GEO_DETECT_SVG; btn.disabled = false; }
        showToast('Location access denied or unavailable');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  };
}

if ($('#geoChange')) {
  $('#geoChange').onclick = () => {
    draft.lat = null; draft.lng = null;
    showLocationPicker();
    validatePost();
  };
}

/* ---------- MAP PICKER ---------- */
const MAP_TILES = {
  voyager: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>'
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>'
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>'
  }
};

let mapInstance = null;
let mapTileLayer = null;
let mapMarker = null;
let mapPickedLat = null;
let mapPickedLng = null;
let mapPickedPlace = null;
let mapCurrentStyle = store.getItem('water.io.mapStyle') || 'voyager';

const PIN_ICON = () => L.divIcon({
  className: '',
  html: `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 9.625 14 22 14 22S28 23.625 28 14C28 6.27 21.73 0 14 0z" fill="#ff7322"/>
    <circle cx="14" cy="14" r="6" fill="#fff"/>
  </svg>`,
  iconSize: [28, 36],
  iconAnchor: [14, 36],
});

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await res.json();
    if (!data || !data.display_name) return null;
    const a = data.address || {};
    const parts = [
      a.leisure || a.amenity || a.natural || a.neighbourhood || a.suburb || a.village || a.town,
      a.city || a.municipality || a.county
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : data.display_name.split(',').slice(0, 2).join(',').trim();
  } catch(e) { return null; }
}

function setMapStyle(style) {
  if (!MAP_TILES[style]) return;
  mapCurrentStyle = style;
  store.setItem('water.io.mapStyle', style);
  document.querySelectorAll('.map-style-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.style === style);
  });
  if (!mapInstance) return;
  if (mapTileLayer) mapInstance.removeLayer(mapTileLayer);
  const t = MAP_TILES[style];
  mapTileLayer = L.tileLayer(t.url, { attribution: t.attribution, maxZoom: 19 });
  mapTileLayer.addTo(mapInstance);
}

function openMapPicker() {
  const sheet = $('#mapSheet');
  if (!sheet) return;

  // Reset
  mapPickedLat = null; mapPickedLng = null; mapPickedPlace = null;
  const preview = $('#mapPlacePreview');
  const confirmBtn = $('#mapConfirm');
  if (preview) preview.hidden = true;
  if (confirmBtn) confirmBtn.disabled = true;

  // Hide the post sheet behind the map while picker is open
  const postSheet = $('#postSheet');
  if (postSheet) { postSheet.style.opacity = '0'; postSheet.style.pointerEvents = 'none'; }

  sheet.hidden = false;
  setTimeout(() => sheet.classList.add('visible'), 10);

  setTimeout(() => {
    const container = $('#mapContainer');
    if (!container) return;

    if (mapInstance) { mapInstance.remove(); mapInstance = null; mapTileLayer = null; mapMarker = null; }

    // Start at draft coords, else Helsinki — we'll fly to geolocation below
    const startLat = draft.lat ?? 60.1699;
    const startLng = draft.lng ?? 24.9384;
    const startZoom = draft.lat != null ? 15 : 11;

    mapInstance = L.map(container, { zoomControl: true, attributionControl: true })
      .setView([startLat, startLng], startZoom);

    setMapStyle(mapCurrentStyle);

    // Drop existing marker if draft has coords
    if (draft.lat != null) {
      mapMarker = L.marker([draft.lat, draft.lng], { icon: PIN_ICON() }).addTo(mapInstance);
      mapPickedLat = draft.lat; mapPickedLng = draft.lng;
      if (confirmBtn) confirmBtn.disabled = false;
    }

    // Try to center on user's real location
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        if (!mapInstance) return;
        // Only fly if we don't already have a draft pin placed
        if (draft.lat == null) {
          mapInstance.flyTo([pos.coords.latitude, pos.coords.longitude], 14, { duration: 1 });
        }
      }, () => {}, { enableHighAccuracy: false, timeout: 5000, maximumAge: 120000 });
    }

    mapInstance.on('click', async (e) => {
      const { lat, lng } = e.latlng;
      mapPickedLat = +lat.toFixed(6);
      mapPickedLng = +lng.toFixed(6);
      mapPickedPlace = null;

      if (mapMarker) mapMarker.remove();
      mapMarker = L.marker([lat, lng], { icon: PIN_ICON() }).addTo(mapInstance);

      if (confirmBtn) confirmBtn.disabled = false;

      const preview = $('#mapPlacePreview');
      const nameEl = $('#mapPlaceName');
      if (preview) preview.hidden = false;
      if (nameEl) nameEl.textContent = `${mapPickedLat}, ${mapPickedLng} — looking up…`;

      const place = await reverseGeocode(mapPickedLat, mapPickedLng);
      mapPickedPlace = place;
      if (nameEl) nameEl.textContent = place || `${mapPickedLat}, ${mapPickedLng}`;
    });
  }, 220);
}

function closeMapSheet() {
  const sheet = $('#mapSheet');
  if (!sheet) return;
  sheet.classList.remove('visible');
  setTimeout(() => { sheet.hidden = true; }, 250);
  // Restore the post sheet
  const postSheet = $('#postSheet');
  if (postSheet) { postSheet.style.opacity = ''; postSheet.style.pointerEvents = ''; }
}

if ($('#mapPick')) $('#mapPick').onclick = openMapPicker;
if ($('#mapClose')) $('#mapClose').onclick = closeMapSheet;

if ($('#mapConfirm')) {
  $('#mapConfirm').onclick = () => {
    if (mapPickedLat == null) return;
    draft.lat = mapPickedLat;
    draft.lng = mapPickedLng;
    const placeInput = $('#pPlace');
    if (placeInput && mapPickedPlace) {
      placeInput.value = mapPickedPlace;
      draft.place = mapPickedPlace;
    }
    confirmGeo(
      mapPickedPlace
        ? `${mapPickedPlace} (${mapPickedLat.toFixed(4)}, ${mapPickedLng.toFixed(4)})`
        : `${mapPickedLat.toFixed(4)}, ${mapPickedLng.toFixed(4)}`
    );
    validatePost();
    closeMapSheet();
  };
}

// Style switcher — wire up buttons and reflect saved selection
document.querySelectorAll('.map-style-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.style === mapCurrentStyle);
  btn.onclick = () => setMapStyle(btn.dataset.style);
});

function clearPhoto() {
  draft.img = null;
  const fileInput = $('#pImg');
  const chosen = $('#photoChosen');
  const cta = $('#dropCta');
  if (fileInput) fileInput.value = '';
  if (chosen) chosen.hidden = true;
  if (cta) cta.hidden = false;
}

if ($('#photoRemove')) {
  $('#photoRemove').onclick = e => {
    e.preventDefault();
    e.stopPropagation();
    clearPhoto();
  };
}

if ($('#pImg')) {
  $('#pImg').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    draft.img = await shrink(f);
    const prev = $('#pPrev');
    const chosen = $('#photoChosen');
    const cta = $('#dropCta');
    if (prev) prev.src = draft.img;
    if (chosen) chosen.hidden = false;
    if (cta) cta.hidden = true;

    let gps = null;
    try { gps = exifGPS(await f.arrayBuffer()); } catch {}
    if (gps) useCoords(gps.lat, gps.lng, 'the photo');
    // No GPS in photo — locationPicker stays visible for manual/detect
  };
}

$('#postSave').onclick = () => {
  if (!db.user || !db.user.trim()) {
    const nameField = $('#pName');
    const name = nameField ? nameField.value.trim() : '';
    if (!name) {
      showToast('Add your name first');
      if (nameField) nameField.focus();
      return;
    }
    db.user = name;
    save();
  }
  doPost();
};

/* ---------- SHARING ---------- */
function getShareUrl() {
  return shareState();
}

function updateSharePreview() {
  const count = $('#shareCount');
  const time = $('#shareTime');
  if (count) {
    const postCount = db.posts ? db.posts.length : 0;
    count.textContent = postCount + ' spot' + (postCount !== 1 ? 's' : '');
  }
  if (time) {
    const ts = db._sharedTimestamp || lastModified || Date.now();
    time.textContent = 'Last updated ' + ago(ts);
  }
  
  const urlInput = $('#shareUrl');
  if (urlInput) {
    const url = getShareUrl();
    if (url) urlInput.value = url;
  }
}

function showShareModal() {
  const modal = $('#shareModal');
  if (!modal) return;
  modal.hidden = false;
  modal.style.display = 'flex';
  modal.style.opacity = '1';
  modal.style.pointerEvents = 'auto';
  updateSharePreview();
  
  setTimeout(() => {
    const input = $('#shareUrl');
    if (input) {
      input.focus();
      input.select();
    }
    modal.classList.add('visible');
  }, 100);
}

function hideShareModal() {
  const modal = $('#shareModal');
  if (!modal) return;
  modal.classList.remove('visible');
  setTimeout(() => {
    modal.hidden = true;
    modal.style.display = 'none';
  }, 300);
}

// Sync pill
if ($('#syncPill')) {
  $('#syncPill').onclick = showSyncSheet;
}
if ($('#syncClose')) {
  $('#syncClose').onclick = hideSyncSheet;
}

// Share buttons
if ($('#btnShare')) {
  $('#btnShare').onclick = showShareModal;
}
if ($('#shareClose')) {
  $('#shareClose').onclick = hideShareModal;
}
if ($('#reactionClose')) {
  $('#reactionClose').onclick = hideReactionSheet;
}

// Copy link
if ($('#shareCopy')) {
  $('#shareCopy').onclick = () => {
    const input = $('#shareUrl');
    if (!input) return;
    
    input.select();
    try {
      document.execCommand('copy');
      showToast('Link copied!');
    } catch(e) {
      navigator.clipboard?.writeText(input.value)
        .then(() => showToast('Link copied!'))
        .catch(() => showToast('Select and copy the link'));
    }
  };
}

// Share options
document.querySelectorAll('.share-option').forEach(btn => {
  btn.onclick = () => {
    const type = btn.dataset.share;
    const url = getShareUrl();
    if (!url) {
      showToast('Failed to generate share link');
      return;
    }
    
    const title = 'Check out these water spots! 🏊';
    const text = 'Found some great swimming spots on water.io';
    
    let shareUrl = '';
    
    switch(type) {
      case 'copy':
        copyLink(url);
        break;
      case 'whatsapp':
        shareUrl = `https://wa.me/?text=${encodeURIComponent(title + '\n' + url)}`;
        window.open(shareUrl, '_blank');
        break;
      case 'facebook':
        shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(title)}`;
        window.open(shareUrl, '_blank');
        break;
      case 'instagram':
        copyLink(url);
        showToast('Copy link to share on Instagram');
        break;
      case 'share':
        if (navigator.share) {
          navigator.share({
            title: title,
            text: text,
            url: url
          }).catch(() => {});
        } else {
          copyLink(url);
        }
        break;
    }
  };
});

function copyLink(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => showToast('Link copied! 📋'))
      .catch(() => fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(url) {
  const input = $('#shareUrl');
  if (input) {
    input.value = url;
    input.select();
    try {
      document.execCommand('copy');
      showToast('Link copied! 📋');
    } catch(e) {
      showToast('Select and copy the link');
    }
  }
}

function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = el('div', 'toast');
    document.body.append(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

/* ---------- SYNC PILL & SHEET ---------- */
function updateSyncPill() {
  const pill = $('#syncPill');
  if (!pill) return;
  try {
    const raw = store.getItem(MERGE_HISTORY_KEY);
    if (!raw) { pill.style.display = 'none'; return; }
    const hist = JSON.parse(raw);
    if (!hist || hist.length === 0) { pill.style.display = 'none'; return; }
    pill.textContent = '⟳ ' + ago(hist[0].ts);
    pill.style.display = 'flex';
  } catch(e) {
    pill.style.display = 'none';
  }
}

function buildMergeGraph(hist) {
  if (!hist || hist.length === 0) return '<p style="color:var(--mut);font-size:13px;padding:12px 0">No syncs yet</p>';

  const ROW_H    = 64;
  const PAD_V    = 20;
  const PAD_B    = 16;   // extra bottom padding
  const MAIN_X   = 76;
  const NODE_R   = 7;
  const USER_R   = 13;
  const MAIN_COLOR = '#2fa87c';

  // --- Version numbering (oldest-first) ---
  const histOldFirst = [...hist].reverse();
  let major = 1, minor = 0;
  const versionsOldFirst = histOldFirst.map((m, i) => {
    if (i > 0) {
      if (m.newPosts > 0) { major++; minor = 0; }
      else { minor++; }
    }
    return `v${major}.${minor}`;
  });
  const versions = versionsOldFirst.reverse();

  // --- Senders → right-side x positions ---
  const senders = [];
  hist.forEach(m => { if (m.from && !senders.includes(m.from)) senders.push(m.from); });
  const BRANCH_GAP = 58;
  const BRANCH_START = MAIN_X + 58;
  const senderX = {};
  senders.forEach((u, i) => { senderX[u] = BRANCH_START + i * BRANCH_GAP; });

  // --- Change label builder ---
  function changeLabel(m) {
    const parts = [];
    if (m.newPosts > 0) parts.push(`${m.newPosts} post${m.newPosts > 1 ? 's' : ''} added`);
    if (m.newComments > 0) parts.push(`${m.newComments} comment${m.newComments > 1 ? 's' : ''} updated`);
    if (m.newReactions > 0) parts.push(`${m.newReactions} reaction${m.newReactions > 1 ? 's' : ''} updated`);
    if (parts.length === 0 && m.postsMerged > 0) parts.push(`${m.postsMerged} post${m.postsMerged > 1 ? 's' : ''} updated`);
    return parts.join(', ');
  }

  // Estimate max label width to set SVG W
  const maxLabelChars = hist.reduce((mx, m) => Math.max(mx, changeLabel(m).length), 0);
  const labelW = maxLabelChars * 6.2 + 10;
  const lastSenderX = senders.length > 0 ? BRANCH_START + (senders.length - 1) * BRANCH_GAP : MAIN_X;
  const W = Math.max(310, lastSenderX + USER_R + labelW + 10);
  const H = PAD_V + (hist.length + 1) * ROW_H + PAD_B;
  const youY  = PAD_V;
  const rowY  = i => PAD_V + (i + 1) * ROW_H;
  const lastY = rowY(hist.length - 1);

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">`;

  // Main trunk line
  s += `<line x1="${MAIN_X}" y1="${youY + USER_R}" x2="${MAIN_X}" y2="${lastY + NODE_R}" stroke="${MAIN_COLOR}" stroke-width="2.5"/>`;

  // Per-sender branch lines (repeat senders only)
  senders.forEach(u => {
    const ys = hist.map((m, i) => m.from === u ? rowY(i) : null).filter(y => y !== null);
    if (ys.length < 2) return;
    s += `<line x1="${senderX[u]}" y1="${ys[0]}" x2="${senderX[u]}" y2="${ys[ys.length - 1]}" stroke="${colorFor(u)}" stroke-width="2"/>`;
  });

  // --- Merge rows (hist[0] = newest = top) ---
  hist.forEach((m, i) => {
    const y   = rowY(i);
    const ver = versions[i];
    const isMajor = ver.split('.')[1] === '0';
    const col = m.from ? colorFor(m.from) : '#8b939d';
    const fx  = m.from ? senderX[m.from] : null;

    // Connector: trunk node → user circle
    if (fx !== null) {
      s += `<line x1="${MAIN_X + NODE_R}" y1="${y}" x2="${fx - USER_R}" y2="${y}" stroke="${col}" stroke-width="2"/>`;
    }

    // Version pill (no border — just soft fill)
    const verColor = isMajor ? '#1a6642' : '#8f5c00';
    const verFill  = isMajor ? '#d8f0e4' : '#fdefd0';
    const verText  = ver;
    const pillW = verText.length * 7 + 12;
    const pillH = 18;
    const px = MAIN_X - NODE_R - 6 - pillW;
    const py = y - pillH / 2;
    s += `<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="5" fill="${verFill}"/>`;
    s += `<text x="${px + pillW / 2}" y="${y + 5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${verColor}">${verText}</text>`;

    // Main trunk node (open circle, white fill)
    s += `<circle cx="${MAIN_X}" cy="${y}" r="${NODE_R}" fill="#fff" stroke="${MAIN_COLOR}" stroke-width="2.5"/>`;

    // User avatar + branch label
    if (fx !== null) {
      s += `<circle cx="${fx}" cy="${y}" r="${USER_R}" fill="${col}"/>`;
      s += `<text x="${fx}" y="${y + 4.5}" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">${m.from.charAt(0).toUpperCase()}</text>`;

      const lx = fx + USER_R + 7;
      const lbl = changeLabel(m);
      if (lbl) {
        s += `<text x="${lx}" y="${y - 1}" font-size="10" font-weight="600" fill="#3d4347">${lbl}</text>`;
      }
      s += `<text x="${lx}" y="${y + 12}" font-size="8.5" fill="#aab0b9">${m.from} · ${ago(m.ts)}</text>`;
    } else {
      // Unknown sender — time to right of trunk
      s += `<text x="${MAIN_X + NODE_R + 8}" y="${y + 4.5}" font-size="8.5" fill="#aab0b9">${ago(m.ts)}</text>`;
    }
  });

  // "You · now" at top
  const meCol = db.user ? colorFor(db.user) : '#8b939d';
  const meInit = (db.user || '?').charAt(0).toUpperCase();
  s += `<circle cx="${MAIN_X}" cy="${youY}" r="${USER_R}" fill="${meCol}"/>`;
  s += `<text x="${MAIN_X}" y="${youY + 4.5}" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">${meInit}</text>`;
  s += `<text x="${MAIN_X + USER_R + 7}" y="${youY - 1}" font-size="10" font-weight="600" fill="${meCol}">${db.user || 'You'}</text>`;
  s += `<text x="${MAIN_X + USER_R + 7}" y="${youY + 12}" font-size="8.5" fill="#aab0b9">now</text>`;

  s += '</svg>';
  return s;
}

function showSyncSheet() {
  const sheet = $('#syncSheet');
  if (!sheet) return;
  try {
    const raw = store.getItem(MERGE_HISTORY_KEY);
    const hist = raw ? JSON.parse(raw) : [];
    const graphEl = $('#syncGraph');
    if (graphEl) graphEl.innerHTML = buildMergeGraph(hist);
  } catch(e) {
    console.warn('syncSheet render failed:', e);
  }
  sheet.hidden = false;
  sheet.style.display = 'flex';
  sheet.style.opacity = '1';
  sheet.style.pointerEvents = 'auto';
  setTimeout(() => sheet.classList.add('visible'), 10);
}

function hideSyncSheet() {
  const sheet = $('#syncSheet');
  if (!sheet) return;
  sheet.classList.remove('visible');
  setTimeout(() => { sheet.hidden = true; sheet.style.display = 'none'; }, 300);
}

/* ---------- MERGE HANDLING ---------- */
function checkForMerge() {
  try {
    const params = new URLSearchParams(window.location.search);
    const mergeParam = params.get(MERGE_KEY);
    
    if (mergeParam === 'true') {
      const shared = loadSharedState();
      if (shared) {
        const merged = mergeStates(shared);
        if (merged) {
          db = merged;
          save();
          render();
          showToast('Merged successfully!');
          params.delete(MERGE_KEY);
          const newUrl = window.location.pathname + '?' + params.toString();
          window.history.replaceState({}, '', newUrl);
        }
      }
    }
    
  } catch(e) {
    console.warn('Merge check failed:', e);
  }
}



/* ---------- seed ---------- */
function seed() {
  const now = Date.now();
  const h = 3600e3;
  return [
    { 
      id: '_seed01',
      user: 'Jussi', 
      desc: 'Calm bay at Seurasaari, sandy bottom, easy entry.',
      img: null, 
      lat: 60.1789, 
      lng: 24.8836, 
      place: 'Seurasaari, Helsinki', 
      ts: now - 26 * h,
      reacts: { '🌊': ['Martti', 'Laura P.'], '🏊': ['Laura P.'] },
      comments: [
        { 
          id: '_seedc01',
          user: 'Martti', 
          text: 'Went yesterday — 17°C, perfect.', 
          ts: now - 20 * h, 
          reacts: { '👏': ['Jussi'] } 
        },
        { 
          id: '_seedc02',
          user: 'Laura P.', 
          text: 'Parking fills up before 9.', 
          ts: now - 5 * h, 
          reacts: {} 
        }
      ] 
    },
    { 
      id: '_seed02',
      user: 'Laura P.', 
      desc: 'Deep off the Vuosaari pier. Ladder stays in winter.',
      img: null, 
      lat: 60.2093, 
      lng: 25.1442, 
      place: 'Vuosaari pier, Helsinki', 
      ts: now - 9 * h,
      reacts: { '❄️': ['Jussi', 'Martti'] },
      comments: [{ 
        id: '_seedc03',
        user: 'Jussi', 
        text: 'Ice hole kept open all January.', 
        ts: now - 2 * h, 
        reacts: { '🔥': ['Laura P.'] } 
      }] 
    },
    { 
      id: '_seed03',
      user: 'Martti', 
      desc: 'Pikku Kallahti — shallow, warm, good for a long swim.',
      img: null, 
      lat: null, 
      lng: null, 
      place: 'Pikku Kallahti, Helsinki', 
      ts: now - 40 * 60e3,
      reacts: { '🏊': ['Laura P.'] }, 
      comments: [] 
    }
  ];
}

/* ---------- Debug function ---------- */
function debugStorage() {
  console.log('=== DEBUG STORAGE ===');
  console.log('Current db:', db);
  console.log('db.user:', db ? db.user : 'db is null');
  console.log('LocalStorage data:', store.getItem(KEY));
  try {
    const parsed = JSON.parse(store.getItem(KEY));
    console.log('Parsed from localStorage:', parsed);
    console.log('user from localStorage:', parsed ? parsed.user : 'null');
  } catch(e) {
    console.log('Error parsing localStorage:', e);
  }
  console.log('=== END DEBUG ===');
}

/* ---------- Clear data ---------- */
function clearAppData() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('water.'))
      .forEach(k => localStorage.removeItem(k));
  } catch(e) {}
  window.location.href = window.location.pathname;
}

function showClearConfirm() {
  const wrap = $('#clearDataWrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <p class="danger-confirm">This will delete all your spots and settings.</p>
    <div class="row end" style="margin-top:8px">
      <button class="ghost" id="clearCancel">Cancel</button>
      <button class="danger-btn" id="clearConfirm">Delete everything</button>
    </div>`;
  if ($('#clearCancel')) $('#clearCancel').onclick = resetClearBtn;
  if ($('#clearConfirm')) $('#clearConfirm').onclick = clearAppData;
}

function resetClearBtn() {
  const wrap = $('#clearDataWrap');
  if (!wrap) return;
  wrap.innerHTML = '<button class="ghost-danger" id="clearDataBtn">Clear all data</button>';
  if ($('#clearDataBtn')) $('#clearDataBtn').onclick = showClearConfirm;
}

if ($('#clearDataBtn')) $('#clearDataBtn').onclick = showClearConfirm;
if ($('#appVersion')) $('#appVersion').textContent = 'v' + VERSION;

/* ---------- go ---------- */
console.log('Initializing water.io...');

// Initialize database
initializeDB();
console.log('DB initialized:', db);

// Render the feed
render();

// Check for persistence
if (!persists) {
  console.info('water.io: browser storage unavailable on file:// — data lasts this session only.');
}

// Check for merge opportunities
checkForMerge();

// Show shared indicator if needed
if (db._shared) {
  console.info('water.io: Loaded shared state from URL');
  const indicator = el('div', 'shared-indicator');
  indicator.textContent = '📋 Shared view';
  const top = document.querySelector('.top');
  if (top) top.append(indicator);
}

// Debug after load
setTimeout(debugStorage, 500);

// Make debug functions available globally
window.debugStorage = debugStorage;
window.requireUser = requireUser;

console.log('water.io ready!');

})();