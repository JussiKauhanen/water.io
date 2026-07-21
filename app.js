/* water.io — open water spots. POC: localStorage + JSON + URL sharing. */
(() => {
'use strict';

const KEY = 'water.io.v3';
const SHARE_KEY = 'd';  // URL parameter for shared data
const IMAGE_PREFIX = 'water.img.';
const EMOJI = ['🏊', '🌊', '❄️', '🔥', '👏'];
const COLORS = ['#ffd84d','#f78fc2','#3b5bfd','#3ed598','#b28dff','#ff8a5c','#2fd4e8','#ff5f8d'];

const $ = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

/* ---------- storage ---------- */
const store = (() => {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; }
  catch { let m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => m[k] = v }; }
})();
const persists = store === localStorage;

let db = load();

function load() {
  // First check for shared state in URL
  const shared = loadSharedState();
  if (shared) {
    console.log('Loaded shared state from URL');
    return shared;
  }
  
  try { 
    const d = JSON.parse(store.getItem(KEY)); 
    if (d && d.posts) return clean(d); 
  } catch {}
  return { user: null, posts: seed() };
}

const save = () => { 
  try { 
    // Don't save shared state to localStorage (it's ephemeral)
    if (!db._shared) {
      store.setItem(KEY, JSON.stringify(db)); 
    }
  } catch {} 
};

function clean(d) {
  d.posts = (d.posts || []).filter(p => p && p.user).map(p => ({
    ...p, 
    img: p.img || null,  // Keep image as data URL or ID
    reacts: p.reacts || {},
    comments: (p.comments || []).filter(c => c && c.user).map(c => ({ 
      ...c, 
      reacts: c.reacts || {} 
    }))
  }));
  return d;
}

/* ---------- URL sharing ---------- */
function shareState() {
  try {
    // Create a copy without image data (too big for URL)
    const shareData = {
      user: db.user,
      posts: db.posts.map(p => {
        // Check if img is a data URL (starts with data:)
        const isDataUrl = p.img && p.img.startsWith('data:');
        return {
          ...p,
          // If it's a data URL, store it in localStorage and use ID
          img: isDataUrl ? storeImage(p.img) : p.img,
          // Keep other data intact
          _imgData: undefined
        };
      }),
      _shared: true
    };
    
    const json = JSON.stringify(shareData);
    let compressed;
    
    // Use LZString if available
    if (window.LZString) {
      compressed = LZString.compressToEncodedURIComponent(json);
    } else {
      // Fallback: just encode
      compressed = encodeURIComponent(json);
    }
    
    const url = new URL(window.location);
    url.searchParams.set(SHARE_KEY, compressed);
    url.searchParams.delete('img'); // Clean up any old img params
    
    return url.toString();
  } catch(e) {
    console.warn('Share failed:', e);
    return null;
  }
}

function loadSharedState() {
  const params = new URLSearchParams(window.location.search);
  const data = params.get(SHARE_KEY);
  if (!data) return null;
  
  try {
    let json;
    if (window.LZString) {
      json = LZString.decompressFromEncodedURIComponent(data);
    } else {
      json = decodeURIComponent(data);
    }
    
    if (!json) return null;
    const parsed = JSON.parse(json);
    
    // Restore images from localStorage
    if (parsed.posts) {
      parsed.posts = parsed.posts.map(p => {
        // If img is an ID, try to restore it
        if (p.img && typeof p.img === 'string' && !p.img.startsWith('data:')) {
          const stored = loadImage(p.img);
          if (stored) {
            return { ...p, img: stored };
          }
          // If image not found, keep the ID so users know an image exists
        }
        return p;
      });
    }
    
    return parsed;
  } catch(e) {
    console.warn('Failed to load shared state:', e);
    return null;
  }
}

/* ---------- Image storage helpers ---------- */
function storeImage(dataUrl) {
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

function hasImage(id) {
  return !!loadImage(id);
}

/* ---------- helpers ---------- */
const colorFor = (name = '?') => COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const uid = () => Math.random().toString(36).slice(2, 9);

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hour' + (h > 1 ? 's' : '') + ' ago';
  const d = Math.floor(h / 24);
  return d + ' day' + (d > 1 ? 's' : '') + ' ago';
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
}

function shrink(file, max = 900) {
  return new Promise(res => {
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
  });
}

/* ---------- render ---------- */
function render() {
  const feed = $('#feed');
  feed.innerHTML = '';
  db.posts.slice().sort((a, b) => b.ts - a.ts).forEach(p => feed.appendChild(card(p)));
  const me = $('#btnMe');
  me.textContent = db.user ? db.user.charAt(0).toUpperCase() : '?';
  me.style.background = db.user ? colorFor(db.user) : '#c9d1d9';
  
  // Update share button visibility
  const shareBtn = $('#btnShare');
  if (shareBtn) {
    shareBtn.style.display = db.posts.length > 0 ? 'block' : 'none';
  }
}

function card(p) {
  const c = el('div', 'card');

  const head = el('div', 'card-head');
  head.append(avatar(p.user, true));
  const meta = el('div');
  meta.append(el('div', 'who', p.user), el('div', 'when', ago(p.ts)));
  head.append(meta);
  c.append(head, el('p', 'desc', p.desc));

  // Handle images - check if we have actual image data
  if (p.img) {
    const imgContainer = el('div', 'img-container');
    
    // Check if it's a data URL or we can load it
    if (p.img.startsWith('data:')) {
      // We have the image data
      const i = el('img', 'shot');
      i.src = p.img;
      i.alt = p.desc || 'Spot photo';
      imgContainer.append(i);
    } else {
      // It's an image ID - try to load it
      const loaded = loadImage(p.img);
      if (loaded) {
        const i = el('img', 'shot');
        i.src = loaded;
        i.alt = p.desc || 'Spot photo';
        imgContainer.append(i);
      } else {
        // Image not available - show placeholder
        const placeholder = el('div', 'img-placeholder');
        placeholder.innerHTML = `
          <span>📷</span>
          <span>Photo not available</span>
        `;
        imgContainer.append(placeholder);
        
        // Store the image ID as data attribute so we know one exists
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

  c.append(reacts(p.reacts, refresh), comments(p));
  return c;
}

const refresh = () => { save(); render(); };

const MAPS = 'https://www.google.com/maps/search/?api=1&query=';
function mapLink(p) {
  if (p.lat != null) return { label: p.place || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`, url: MAPS + `${p.lat},${p.lng}` };
  if (p.place) return { label: p.place, url: MAPS + encodeURIComponent(p.place) };
  return null;
}

function reacts(map, done) {
  const wrap = el('div', 'reacts');
  Object.entries(map).filter(([, u]) => u.length).forEach(([e, users]) => {
    const b = el('button', 'chip' + (users.includes(db.user) ? ' on' : ''), `${e} ${users.length}`);
    b.onclick = () => { toggle(map, e); done(); };
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
  const u = map[e] || (map[e] = []);
  const i = u.indexOf(db.user);
  i < 0 ? u.push(db.user) : u.splice(i, 1);
}

function comments(p) {
  const box = el('div', 'comments');
  p.comments.forEach(cm => {
    const row = el('div', 'cm');
    row.append(avatar(cm.user, true));
    const body = el('div', 'cm-body');
    const m = el('div', 'cm-meta');
    m.append(el('b', null, cm.user), document.createTextNode(' · ' + ago(cm.ts)));
    body.append(m, el('p', 'cm-text', cm.text), reacts(cm.reacts, refresh));
    row.append(body);
    box.append(row);
  });

  const form = el('form', 'cm-form');
  const input = el('input');
  input.placeholder = 'Your reply';
  const btn = el('button', 'send');
  btn.type = 'submit';
  btn.setAttribute('aria-label', 'Send reply');
  btn.innerHTML = PLANE;
  form.append(input, btn);
  form.onsubmit = ev => {
    ev.preventDefault();
    const t = input.value.trim();
    if (!t || !requireUser()) return;
    p.comments.push({ id: uid(), user: db.user, text: t, ts: Date.now(), reacts: {} });
    refresh();
  };
  box.append(form);
  return box;
}

/* ---------- sheets ---------- */
const show = s => $(s).hidden = false;
const hide = s => $(s).hidden = true;

function requireUser() {
  if (db.user) return true;
  show('#nameSheet'); $('#nameInput').focus();
  return false;
}

$('#nameSave').onclick = () => {
  const n = $('#nameInput').value.trim();
  if (!n) return $('#nameInput').focus();
  db.user = n; hide('#nameSheet'); refresh();
};
$('#nameCancel').onclick = () => hide('#nameSheet');
$('#btnMe').onclick = () => { $('#nameInput').value = db.user || ''; show('#nameSheet'); $('#nameInput').focus(); };
$('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#nameSave').click(); });

document.querySelectorAll('.sheet-wrap').forEach(w => {
  w.onclick = e => { if (e.target === w) w.hidden = true; };
});

/* ---------- new post ---------- */
let draft = { img: null, lat: null, lng: null, place: '' };

function setGeo(state, text) {
  $('#geoBar').className = 'geobar ' + state;
  $('#geoText').textContent = text;
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
  $('#pDesc').value = ''; $('#pPlace').value = '';
  $('#descCount').textContent = '0 / 60';
  $('#pPrev').hidden = true; $('#dropCta').hidden = false;
  $('#manualRow').hidden = true;
  show('#postSheet');
  askDevice();
};
$('#postCancel').onclick = () => hide('#postSheet');
$('#geoManual').onclick = () => { $('#manualRow').hidden = false; $('#pPlace').focus(); };
$('#pDesc').oninput = e => $('#descCount').textContent = `${e.target.value.length} / 60`;
$('#pPlace').oninput = e => {
  draft.place = e.target.value.trim();
  if (draft.lat == null) setGeo(draft.place ? 'ok' : 'warn', draft.place || 'Location off — add a photo or the address.');
};

$('#pImg').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  draft.img = await shrink(f);
  const prev = $('#pPrev');
  prev.src = draft.img; prev.hidden = false; $('#dropCta').hidden = true;

  let gps = null;
  try { gps = exifGPS(await f.arrayBuffer()); } catch {}
  if (gps) useCoords(gps.lat, gps.lng, 'the photo');
  else if (draft.lat == null) setGeo('warn', 'No GPS in that photo — enter it manually.');
};

$('#postSave').onclick = () => {
  const desc = $('#pDesc').value.trim().slice(0, 60);
  if (!desc) return $('#pDesc').focus();
  
  // If we have a data URL image, it will be stored when sharing
  db.posts.push({
    id: uid(), user: db.user, desc, img: draft.img,
    lat: draft.lat, lng: draft.lng, place: draft.place,
    ts: Date.now(), reacts: {}, comments: []
  });
  hide('#postSheet'); refresh();
};

/* ---------- sharing ---------- */
$('#btnShare').onclick = () => {
  const url = shareState();
  if (url) {
    // Try to copy to clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url)
        .then(() => {
          showShareNotification('Link copied to clipboard! 📋');
        })
        .catch(() => {
          showShareModal(url);
        });
    } else {
      showShareModal(url);
    }
  } else {
    alert('Failed to create share link. Please try again.');
  }
};

function showShareNotification(msg) {
  // Simple toast notification
  const toast = el('div', 'toast');
  toast.textContent = msg;
  document.body.append(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function showShareModal(url) {
  // Show modal with the URL
  const modal = el('div', 'sheet-wrap');
  modal.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h2>Share</h2>
        <button class="x" onclick="this.closest('.sheet-wrap').remove()">×</button>
      </div>
      <p class="hint">Copy this link to share your water spots:</p>
      <div class="share-url">
        <input type="text" value="${url}" readonly onclick="this.select()">
      </div>
      <button class="primary block" onclick="
        const input = this.closest('.sheet').querySelector('.share-url input');
        input.select();
        document.execCommand('copy');
        this.textContent = 'Copied! ✓';
        setTimeout(() => this.closest('.sheet-wrap').remove(), 1000);
      ">Copy Link</button>
    </div>
  `;
  document.body.append(modal);
  
  // Close on backdrop click
  modal.onclick = e => {
    if (e.target === modal) modal.remove();
  };
  
  // Focus and select the URL
  setTimeout(() => {
    const input = modal.querySelector('.share-url input');
    if (input) {
      input.focus();
      input.select();
    }
  }, 100);
}

/* ---------- import / export ---------- */
$('#btnExport').onclick = () => {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
  a.download = 'water-io-export.json';
  a.click();
};
$('#btnImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d.posts) throw 0;
    db.posts = clean(d).posts;
    if (d.user && !db.user) db.user = d.user;
    db._shared = false;
    refresh();
  } catch { alert('Not a valid water.io export.'); }
  e.target.value = '';
};

/* ---------- seed ---------- */
function seed() {
  const h = 3600e3, now = Date.now();
  return [
    { id: 'a1', user: 'Lenni-Kalle', desc: 'Calm bay at Seurasaari, sandy bottom, easy entry.',
      img: null, lat: 60.1789, lng: 24.8836, place: 'Seurasaari, Helsinki', ts: now - 26 * h,
      reacts: { '🌊': ['Jussi', 'Martti'], '🏊': ['Martti'] },
      comments: [
        { id: 'c1', user: 'Jussi', text: 'Went yesterday — 17°C, perfect.', ts: now - 20 * h, reacts: { '👏': ['Lenni-Kalle'] } },
        { id: 'c2', user: 'Martti', text: 'Parking fills up before 9.', ts: now - 5 * h, reacts: {} }
      ] },
    { id: 'a2', user: 'Martti', desc: 'Deep off the Vuosaari pier. Ladder stays in winter.',
      img: null, lat: 60.2093, lng: 25.1442, place: 'Vuosaari pier, Helsinki', ts: now - 9 * h,
      reacts: { '❄️': ['Lenni-Kalle', 'Jussi'] },
      comments: [{ id: 'c3', user: 'Lenni-Kalle', text: 'Ice hole kept open all January.', ts: now - 2 * h, reacts: { '🔥': ['Martti'] } }] },
    { id: 'a3', user: 'Jussi', desc: 'Pikku Kallahti — shallow, warm, good for a long swim.',
      img: null, lat: null, lng: null, place: 'Pikku Kallahti, Helsinki', ts: now - 40 * 60e3,
      reacts: { '🏊': ['Martti'] }, comments: [] }
  ];
}

/* ---------- go ---------- */
render();
if (!persists) console.info('water.io: browser storage unavailable on file:// — data lasts this session only.');
if (db._shared) {
  console.info('water.io: Loaded shared state from URL');
  // Show a small indicator
  const indicator = el('div', 'shared-indicator');
  indicator.textContent = '📋 Shared view';
  document.querySelector('.top').append(indicator);
}

})();