/* water.io — open water spots. POC: localStorage + JSON + URL sharing. */
(() => {
'use strict';

const KEY = 'water.io.v3';
const SHARE_KEY = 'd';
const MERGE_KEY = 'merge';
const IMAGE_PREFIX = 'water.img.';
const DONT_ASK_KEY = 'water.io.dontAsk';
const LAST_MODIFIED_KEY = 'water.io.modified';
const SYNC_KEY = 'water.io.sync';
const EMOJI = ['🏊', '🌊', '❄️', '🔥', '👏'];
const COLORS = ['#ffd84d','#f78fc2','#3b5bfd','#3ed598','#b28dff','#ff8a5c','#2fd4e8','#ff5f8d'];
const MAX_LENGTH = 50; // Reduced to 50 chars

const $ = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

/* ---------- storage ---------- */
const store = (() => {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; }
  catch { let m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => m[k] = v }; }
})();
const persists = store === localStorage;

let db = null;
let hasChanges = false;
let lastModified = parseInt(store.getItem(LAST_MODIFIED_KEY)) || Date.now();

/* ---------- ID Generation (Timestamp-based) ---------- */
function genId() {
  // Base36 timestamp + random suffix for same-ms conflicts
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 5);
  return ts + rand; // e.g., "k3m8x2a" - sortable AND unique
}

function getIdTimestamp(id) {
  // Extract timestamp from ID (first part before random suffix)
  if (!id) return 0;
  // IDs are like "k3m8x2a" - timestamp is first part
  // We can parse base36 back to number
  const tsPart = id.slice(0, -3); // Remove random suffix
  return parseInt(tsPart, 36) || 0;
}

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
        return clean(d);
      }
    }
  } catch (e) {
    console.warn('Failed to load data:', e);
  }
  
  // Return default structure with seed data
  return { user: null, posts: seed() };
}

function save() { 
  try { 
    if (!db || db._shared) return;
    store.setItem(KEY, JSON.stringify(db));
    const now = Date.now();
    store.setItem(LAST_MODIFIED_KEY, String(now));
    lastModified = now;
    hasChanges = true;
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

/* ---------- SIMPLIFIED MERGE (Timestamp-based IDs) ---------- */
function mergeStates(sharedData) {
  if (!sharedData || !sharedData.posts) return sharedData;
  
  // Get existing data
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
  
  // If no existing posts, use shared data
  if (!existing || !existing.posts || existing.posts.length === 0) {
    if (sharedData._timestamp) {
      store.setItem(SYNC_KEY, String(sharedData._timestamp));
    }
    return sharedData;
  }
  
  console.log('Merging shared state with existing data...');
  
  // Use Map for O(1) lookups by ID (timestamp-based)
  const postMap = new Map();
  
  // Add all existing posts
  existing.posts.forEach(p => {
    if (p && p.id) postMap.set(p.id, p);
  });
  
  // Merge shared posts
  let mergedCount = 0;
  sharedData.posts.forEach(p => {
    if (!p || !p.id) return;
    
    if (postMap.has(p.id)) {
      // Same post (same timestamp) - merge reactions and comments
      const existingPost = postMap.get(p.id);
      
      // Merge reactions (combine both sets)
      existingPost.reacts = { ...existingPost.reacts, ...p.reacts };
      
      // Merge comments (by ID)
      const commentMap = new Map();
      (existingPost.comments || []).forEach(c => {
        if (c && c.id) commentMap.set(c.id, c);
      });
      
      (p.comments || []).forEach(c => {
        if (!c || !c.id) return;
        if (commentMap.has(c.id)) {
          // Merge comment reactions
          const existingComment = commentMap.get(c.id);
          existingComment.reacts = { ...existingComment.reacts, ...c.reacts };
          // Keep most recent text
          if (c.text) existingComment.text = c.text;
        } else {
          commentMap.set(c.id, c);
        }
      });
      
      existingPost.comments = Array.from(commentMap.values())
        .sort((a, b) => (a.id || 0) - (b.id || 0));
      
      // Keep most recent version of post fields
      if (p.desc) existingPost.desc = p.desc;
      if (p.img) existingPost.img = p.img;
      if (p.lat != null) existingPost.lat = p.lat;
      if (p.lng != null) existingPost.lng = p.lng;
      if (p.place) existingPost.place = p.place;
      
      mergedCount++;
    } else {
      // New post - just add it
      postMap.set(p.id, p);
    }
  });
  
  // Sort by timestamp (newest first) - IDs are timestamp-based!
  const mergedPosts = Array.from(postMap.values())
    .sort((a, b) => {
      const tsA = getIdTimestamp(a.id);
      const tsB = getIdTimestamp(b.id);
      return tsB - tsA;
    });
  
  // Build merged database
  const merged = {
    user: sharedData.user || existing.user || null,
    posts: mergedPosts,
    _merged: true,
    _timestamp: Date.now(),
    _sharedTimestamp: sharedData._timestamp || Date.now()
  };
  
  // Store last sync timestamp
  store.setItem(SYNC_KEY, String(merged._timestamp));
  
  // Save merged data
  try {
    store.setItem(KEY, JSON.stringify(merged));
  } catch(e) {
    console.warn('Failed to save merged data:', e);
  }
  
  // Show merge notification
  const newCount = mergedPosts.length - existing.posts.length;
  setTimeout(() => {
    if (newCount > 0) {
      showToast(`Added ${newCount} new spot${newCount > 1 ? 's' : ''} from shared link`);
    } else {
      showToast(`Merged reactions from ${mergedCount} spot${mergedCount > 1 ? 's' : ''}`);
    }
  }, 500);
  
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
      _version: '2.0' // Version bump for timestamp IDs
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
    
    // Restore images from localStorage if available
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

/* ---------- render ---------- */
function render() {
  initializeDB();
  
  const feed = $('#feed');
  if (!feed) return;
  
  feed.innerHTML = '';
  
  if (!db.posts || db.posts.length === 0) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = `
      <span style="font-size:48px;display:block;margin-bottom:12px;">🏊</span>
      <h3 style="margin:0 0 8px;">No spots yet</h3>
      <p style="color:var(--mut);margin:0;font-size:14px;">Tap the + button to add your first water spot</p>
    `;
    empty.style.cssText = 'text-align:center;padding:60px 20px;color:var(--mut);';
    feed.append(empty);
  } else {
    // Sort by timestamp (newest first) - IDs are timestamp-based!
    db.posts.slice().sort((a, b) => {
      const tsA = getIdTimestamp(a.id);
      const tsB = getIdTimestamp(b.id);
      return tsB - tsA;
    }).forEach(p => {
      if (p) feed.appendChild(card(p));
    });
  }
  
  const me = $('#btnMe');
  if (me) {
    me.textContent = db.user ? db.user.charAt(0).toUpperCase() : '?';
    me.style.background = db.user ? colorFor(db.user) : '#c9d1d9';
  }
  
  const shareBtn = $('#btnShare');
  if (shareBtn) {
    shareBtn.style.display = db.posts && db.posts.length > 0 ? 'flex' : 'none';
  }
  
  const mergeBtn = $('#btnMerge');
  if (mergeBtn) {
    mergeBtn.style.display = 'none';
  }
  
  updateSharePreview();
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

const MAPS = 'https://www.google.com/maps/search/?api=1&query=';
function mapLink(p) {
  if (!p) return null;
  if (p.lat != null && p.lng != null) {
    return { label: p.place || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`, url: MAPS + `${p.lat},${p.lng}` };
  }
  if (p.place) return { label: p.place, url: MAPS + encodeURIComponent(p.place) };
  return null;
}

/* ---------- REACTIONS with bottom sheet ---------- */
function reacts(map, done, parent) {
  const wrap = el('div', 'reacts');
  
  if (!map) map = {};
  
  const entries = Object.entries(map).filter(([, u]) => u && u.length);
  entries.sort((a, b) => b[1].length - a[1].length);
  
  entries.forEach(([e, users]) => {
    const b = el('button', 'chip' + (users.includes(db.user) ? ' on' : ''), `${e} ${users.length}`);
    b.onclick = (ev) => {
      ev.stopPropagation();
      showReactionBottomSheet(e, users, map, done);
    };
    wrap.append(b);
  });
  
  const add = el('button', 'chip add', '☺');
  add.onclick = () => {
    const picker = el('div', 'reacts');
    EMOJI.forEach(e => {
      const b = el('button', 'chip', e);
      b.onclick = () => { toggle(map, e); done(); };
      picker.append(b);
    });
    add.replaceWith(picker);
  };
  wrap.append(add);
  return wrap;
}

function toggle(map, e) {
  if (!requireUser()) return;
  if (!map[e]) map[e] = [];
  const u = map[e];
  const i = u.indexOf(db.user);
  i < 0 ? u.push(db.user) : u.splice(i, 1);
  hideReactionSheet();
}

/* ---------- Reaction Bottom Sheet ---------- */
let currentReactionContext = null;

function showReactionBottomSheet(emoji, users, map, done) {
  const sheet = $('#reactionSheet');
  const title = $('#reactionTitle');
  const userList = $('#reactionUsers');
  const picker = $('#reactionPicker');
  
  if (!sheet || !title || !userList || !picker) return;
  
  currentReactionContext = { emoji, users, map, done };
  
  title.textContent = `${emoji} ${users.length} person${users.length > 1 ? 's' : ''}`;
  
  userList.innerHTML = '';
  users.forEach(name => {
    const item = el('div', 'reaction-user');
    item.append(avatar(name, true));
    const label = el('span', null, name);
    if (name === db.user) {
      label.style.fontWeight = '600';
      label.style.color = 'var(--orange)';
      label.textContent += ' (you)';
    }
    item.append(label);
    userList.append(item);
  });
  
  picker.innerHTML = '';
  EMOJI.forEach(e => {
    const btn = el('button', 'reaction-emoji-btn');
    btn.textContent = e;
    btn.dataset.emoji = e;
    if (map[e] && map[e].includes(db.user)) {
      btn.classList.add('active');
    }
    btn.onclick = () => {
      if (!requireUser()) return;
      toggle(map, e);
      if (done) done();
      const newUsers = map[e] || [];
      showReactionBottomSheet(e, newUsers, map, done);
    };
    picker.append(btn);
  });
  
  sheet.hidden = false;
  setTimeout(() => {
    sheet.classList.add('visible');
  }, 10);
}

function hideReactionSheet() {
  const sheet = $('#reactionSheet');
  if (!sheet) return;
  sheet.classList.remove('visible');
  setTimeout(() => {
    sheet.hidden = true;
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
  input.placeholder = 'Your reply';
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
    if (!t || !requireUser()) return;
    if (t.length > MAX_LENGTH) {
      showToast('Comment too long! Max ' + MAX_LENGTH + ' characters');
      return;
    }
    if (!p.comments) p.comments = [];
    p.comments.push({ 
      id: genId(), // Timestamp-based ID!
      user: db.user, 
      text: t, 
      ts: Date.now(), 
      reacts: {} 
    });
    refresh();
  };
  box.append(form);
  return box;
}

/* ---------- sheets ---------- */
const show = s => {
  const el = $(s);
  if (el) el.hidden = false;
};
const hide = s => {
  const el = $(s);
  if (el) el.hidden = true;
};

function requireUser() {
  if (db.user) return true;
  show('#nameSheet'); 
  const input = $('#nameInput');
  if (input) input.focus();
  return false;
}

// Name sheet handlers
$('#nameSave').onclick = () => {
  const n = $('#nameInput');
  if (!n) return;
  const name = n.value.trim();
  if (!name) return n.focus();
  db.user = name; 
  hide('#nameSheet'); 
  refresh();
};
$('#nameCancel').onclick = () => hide('#nameSheet');
$('#btnMe').onclick = () => { 
  const input = $('#nameInput');
  if (input) input.value = db.user || ''; 
  show('#nameSheet'); 
  if (input) input.focus(); 
};
$('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#nameSave').click(); });

document.querySelectorAll('.sheet-wrap').forEach(w => {
  if (!w) return;
  w.onclick = e => { 
    if (e.target === w) {
      if (w.id === 'leaveModal') {
        handleLeaveClose();
      } else if (w.id === 'shareModal') {
        hideShareModal();
      } else if (w.id === 'reactionSheet') {
        hideReactionSheet();
      } else {
        w.hidden = true;
      }
    }
  };
});

/* ---------- new post ---------- */
let draft = { img: null, lat: null, lng: null, place: '' };

function setGeo(state, text) {
  const bar = $('#geoBar');
  if (bar) bar.className = 'geobar ' + state;
  const textEl = $('#geoText');
  if (textEl) textEl.textContent = text;
}
function useCoords(lat, lng, from) {
  draft.lat = lat; draft.lng = lng;
  setGeo('ok', `${lat.toFixed(4)}, ${lng.toFixed(4)} · from ${from}`);
}

function askDevice() {
  if (!navigator.geolocation) return setGeo('warn', 'No location support — add the address instead.');
  setGeo('', 'Locating…');
  navigator.geolocation.getCurrentPosition(
    pos => { if (draft.lat == null) useCoords(+pos.coords.latitude.toFixed(6), +pos.coords.longitude.toFixed(6), 'your device'); },
    () => { if (draft.lat == null) setGeo('warn', 'Location off — add a photo or the address.'); },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
}

$('#btnNew').onclick = () => {
  if (!requireUser()) return;
  draft = { img: null, lat: null, lng: null, place: '' };
  const desc = $('#pDesc');
  const place = $('#pPlace');
  if (desc) desc.value = '';
  if (place) place.value = '';
  updateDescCounter();
  const prev = $('#pPrev');
  const cta = $('#dropCta');
  if (prev) prev.hidden = true;
  if (cta) cta.hidden = false;
  const manual = $('#manualRow');
  if (manual) manual.hidden = true;
  show('#postSheet');
  askDevice();
};
$('#postCancel').onclick = () => hide('#postSheet');
$('#geoManual').onclick = () => { 
  const manual = $('#manualRow');
  if (manual) manual.hidden = false; 
  const place = $('#pPlace');
  if (place) place.focus(); 
};

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
  $('#pDesc').oninput = updateDescCounter;
}

if ($('#pPlace')) {
  $('#pPlace').oninput = e => {
    draft.place = e.target.value.trim();
    if (draft.lat == null) setGeo(draft.place ? 'ok' : 'warn', draft.place || 'Location off — add a photo or the address.');
  };
}

if ($('#pImg')) {
  $('#pImg').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    draft.img = await shrink(f);
    const prev = $('#pPrev');
    const cta = $('#dropCta');
    if (prev) { prev.src = draft.img; prev.hidden = false; }
    if (cta) cta.hidden = true;

    let gps = null;
    try { gps = exifGPS(await f.arrayBuffer()); } catch {}
    if (gps) useCoords(gps.lat, gps.lng, 'the photo');
    else if (draft.lat == null) setGeo('warn', 'No GPS in that photo — enter it manually.');
  };
}

$('#postSave').onclick = () => {
  const descInput = $('#pDesc');
  if (!descInput) return;
  const desc = descInput.value.trim().slice(0, MAX_LENGTH);
  if (!desc) return descInput.focus();
  if (desc.length > MAX_LENGTH) {
    showToast('Description too long! Max ' + MAX_LENGTH + ' characters');
    return;
  }
  
  if (!db.posts) db.posts = [];
  db.posts.push({
    id: genId(), // Timestamp-based ID!
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
  }, 300);
}

// Share buttons
if ($('#btnShare')) {
  $('#btnShare').onclick = showShareModal;
}
if ($('#shareClose')) {
  $('#shareClose').onclick = hideShareModal;
}

// Copy link
if ($('#shareCopy')) {
  $('#shareCopy').onclick = () => {
    const input = $('#shareUrl');
    if (!input) return;
    
    input.select();
    try {
      document.execCommand('copy');
      showToast('Link copied! 📋');
    } catch(e) {
      navigator.clipboard?.writeText(input.value)
        .then(() => showToast('Link copied! 📋'))
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
    
    const sharedData = loadSharedState();
    if (sharedData && db && db.posts && db.posts.length > 0) {
      showMergePrompt();
    }
  } catch(e) {
    console.warn('Merge check failed:', e);
  }
}

function showMergePrompt() {
  let existing = false;
  try {
    const stored = store.getItem(KEY);
    if (stored) {
      const d = JSON.parse(stored);
      if (d && d.posts && d.posts.length > 0) existing = true;
    }
  } catch(e) {}
  
  if (!existing) return;
  
  const mergeBtn = $('#btnMerge');
  if (mergeBtn) {
    mergeBtn.style.display = 'flex';
    mergeBtn.innerHTML = '🔄 Merge';
    mergeBtn.title = 'Merge shared data with your existing spots';
    mergeBtn.onclick = () => {
      const shared = loadSharedState();
      if (shared) {
        const merged = mergeStates(shared);
        if (merged) {
          db = merged;
          save();
          render();
          mergeBtn.style.display = 'none';
          showToast('Merged successfully!');
        }
      }
    };
  }
}

/* ---------- Leave detection ---------- */
let leaveWarningEnabled = true;

try {
  const dontAsk = store.getItem(DONT_ASK_KEY);
  if (dontAsk === 'true') {
    leaveWarningEnabled = false;
  }
} catch(e) {}

window.addEventListener('beforeunload', (e) => {
  if (!leaveWarningEnabled) return;
  if (!hasChanges) return;
  if (!db || db._shared) return;
  if (!db.posts || db.posts.length === 0) return;
  
  e.preventDefault();
  e.returnValue = '';
  showLeaveModal();
  return '';
});

function showLeaveModal() {
  const modal = $('#leaveModal');
  if (!modal) return;
  modal.hidden = false;
  const checkbox = $('#leaveDontAsk');
  if (checkbox) checkbox.checked = false;
  setTimeout(() => modal.classList.add('visible'), 10);
}

function hideLeaveModal() {
  const modal = $('#leaveModal');
  if (!modal) return;
  modal.classList.remove('visible');
  setTimeout(() => modal.hidden = true, 300);
}

function handleLeaveClose() {
  const checkbox = $('#leaveDontAsk');
  if (checkbox && checkbox.checked) {
    leaveWarningEnabled = false;
    try {
      store.setItem(DONT_ASK_KEY, 'true');
    } catch(e) {}
  }
  hideLeaveModal();
}

if ($('#leaveCancel')) $('#leaveCancel').onclick = handleLeaveClose;
if ($('#leaveClose')) $('#leaveClose').onclick = handleLeaveClose;

if ($('#leaveShare')) {
  $('#leaveShare').onclick = () => {
    const checkbox = $('#leaveDontAsk');
    if (checkbox && checkbox.checked) {
      leaveWarningEnabled = false;
      try {
        store.setItem(DONT_ASK_KEY, 'true');
      } catch(e) {}
    }
    hideLeaveModal();
    showShareModal();
  };
}

if ($('#shareDontAsk')) {
  $('#shareDontAsk').onchange = function() {
    leaveWarningEnabled = !this.checked;
    try {
      store.setItem(DONT_ASK_KEY, String(!this.checked));
    } catch(e) {}
  };
}

setTimeout(() => {
  hasChanges = false;
}, 100);

/* ---------- seed ---------- */
function seed() {
  const now = Date.now();
  const h = 3600e3;
  return [
    { 
      id: (now - 26 * h).toString(36) + 'a1', 
      user: 'Lenni-Kalle', 
      desc: 'Calm bay at Seurasaari, sandy bottom, easy entry.',
      img: null, 
      lat: 60.1789, 
      lng: 24.8836, 
      place: 'Seurasaari, Helsinki', 
      ts: now - 26 * h,
      reacts: { '🌊': ['Jussi', 'Laura P.'], '🏊': ['Laura P.'] },
      comments: [
        { 
          id: (now - 20 * h).toString(36) + 'c1',
          user: 'Jussi', 
          text: 'Went yesterday — 17°C, perfect.', 
          ts: now - 20 * h, 
          reacts: { '👏': ['Lenni-Kalle'] } 
        },
        { 
          id: (now - 5 * h).toString(36) + 'c2',
          user: 'Laura P.', 
          text: 'Parking fills up before 9.', 
          ts: now - 5 * h, 
          reacts: {} 
        }
      ] 
    },
    { 
      id: (now - 9 * h).toString(36) + 'a2',
      user: 'Laura P.', 
      desc: 'Deep off the Vuosaari pier. Ladder stays in winter.',
      img: null, 
      lat: 60.2093, 
      lng: 25.1442, 
      place: 'Vuosaari pier, Helsinki', 
      ts: now - 9 * h,
      reacts: { '❄️': ['Lenni-Kalle', 'Jussi'] },
      comments: [{ 
        id: (now - 2 * h).toString(36) + 'c3',
        user: 'Lenni-Kalle', 
        text: 'Ice hole kept open all January.', 
        ts: now - 2 * h, 
        reacts: { '🔥': ['Laura P.'] } 
      }] 
    },
    { 
      id: (now - 40 * 60e3).toString(36) + 'a3',
      user: 'Jussi', 
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

/* ---------- go ---------- */
initializeDB();
render();
if (!persists) console.info('water.io: browser storage unavailable on file:// — data lasts this session only.');

checkForMerge();

if (db._shared) {
  console.info('water.io: Loaded shared state from URL');
  const indicator = el('div', 'shared-indicator');
  indicator.textContent = '📋 Shared view';
  const top = document.querySelector('.top');
  if (top) top.append(indicator);
}

setTimeout(() => {
  hasChanges = false;
}, 200);

})();