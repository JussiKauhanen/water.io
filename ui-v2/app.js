/* water.io — UI v2.
   Chat-app style shell over the exact same data as the v1 app:
   same localStorage key, same post schema, same ?d= share payload.
   Unread state lives in its own key and never touches the URL. */
(() => {
'use strict';

/* ---------- shared with v1 ---------- */
const KEY        = 'water.io.v3';   // same store as the original UI
const SHARE_KEY  = 'd';             // same share param
const EMOJI      = ['🏊', '🌊', '❄️', '🔥', '👏'];
const COLORS     = ['#ffd84d','#f78fc2','#3b5bfd','#3ed598','#b28dff','#ff8a5c','#2fd4e8','#ff5f8d'];
const MAX_LENGTH = 50;

/* ---------- v2 only — deliberately NOT in the share URL ---------- */
const SEEN_KEY   = 'water.io.v2.seen';   // { [postId]: commentsSeenCount }

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

/* ---------- storage ---------- */
const store = (() => {
  try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return localStorage; }
  catch { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k,v) => { m[k] = v; }, removeItem: k => { delete m[k]; } }; }
})();

let db = null;
let openPostId = null;
let searchTerm = '';

/* ---------- ids & time ---------- */
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2,5);

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function clockTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

/* WhatsApp-ish stamp for the list rows */
function listStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return 'Today, ' + clockTime(ts);

  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';

  const days = Math.floor((now - d) / 864e5);
  if (days < 7) return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0,3);
  return MONTHS[d.getMonth()] + ', ' + d.getFullYear();
}

function daySep(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
}

/* ---------- avatars: colored initials ---------- */
const colorFor = (name = '?') =>
  COLORS[[...String(name)].reduce((a,c) => a + c.charCodeAt(0), 0) % COLORS.length];

/* "Martti" -> M ; "Laura P." -> LP ; "jussi kauhanen" -> JK */
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function avatar(name, size = 'md') {
  const n = el('span', 'av av-' + size, initials(name));
  n.style.background = name ? colorFor(name) : '#d4d9de';
  n.title = name || '';
  return n;
}

/* everyone who has touched a spot: author first, then commenters, then reactors */
function participants(p) {
  const out = [];
  const push = n => { if (n && !out.includes(n)) out.push(n); };
  push(p.user);
  (p.comments || []).forEach(c => push(c.user));
  Object.values(p.reacts || {}).forEach(list => (list || []).forEach(push));
  return out;
}

/* ---------- unread bookkeeping (localStorage only) ---------- */
function readSeen() {
  try { return JSON.parse(store.getItem(SEEN_KEY)) || {}; } catch { return {}; }
}
function writeSeen(map) {
  try { store.setItem(SEEN_KEY, JSON.stringify(map)); } catch {}
}
function unreadCount(p) {
  const seen = readSeen();
  const total = (p.comments || []).length;
  // A spot you have never opened counts as 1 unread (the spot itself) plus its comments.
  if (!(p.id in seen)) return total + 1;
  return Math.max(0, total - seen[p.id]);
}
function markRead(p) {
  const seen = readSeen();
  seen[p.id] = (p.comments || []).length;
  writeSeen(seen);
}
function markAllRead() {
  const seen = {};
  (db.posts || []).forEach(p => { seen[p.id] = (p.comments || []).length; });
  writeSeen(seen);
}

/* ---------- load / save (v1-compatible) ---------- */
function load() {
  try {
    const shared = loadShared();
    if (shared) return merge(shared);
    const stored = store.getItem(KEY);
    if (stored) {
      const d = JSON.parse(stored);
      if (d && Array.isArray(d.posts)) return clean(d);
    }
  } catch (e) { console.warn('load failed', e); }
  return { user: null, posts: seed() };
}

function clean(d) {
  if (!d || typeof d !== 'object') return { user: null, posts: [] };
  d.posts = (d.posts || []).filter(p => p && p.user).map(p => ({
    ...p,
    id: p.id || genId(),
    img: p.img || null,
    reacts: p.reacts || {},
    comments: (p.comments || []).filter(c => c && c.user).map(c => ({ ...c, id: c.id || genId(), reacts: c.reacts || {} }))
  }));
  return d;
}

function save() {
  try {
    store.setItem(KEY, JSON.stringify({ user: db.user, posts: db.posts }));
  } catch (e) { console.warn('save failed', e); }
}

function loadShared() {
  try {
    const raw = new URLSearchParams(location.search).get(SHARE_KEY);
    if (!raw) return null;
    const json = window.LZString
      ? LZString.decompressFromEncodedURIComponent(raw)
      : decodeURIComponent(raw);
    if (!json) return null;
    const parsed = JSON.parse(json);
    return Array.isArray(parsed.posts) ? clean(parsed) : null;
  } catch (e) { console.warn('share parse failed', e); return null; }
}

/* merge shared posts into whatever is already stored, newest comment set wins */
function merge(shared) {
  let mine = null;
  try {
    const stored = store.getItem(KEY);
    if (stored) { const d = JSON.parse(stored); if (d && Array.isArray(d.posts)) mine = clean(d); }
  } catch {}
  if (!mine) return shared;

  const byId = new Map(mine.posts.map(p => [p.id, p]));
  shared.posts.forEach(sp => {
    const cur = byId.get(sp.id);
    if (!cur) { byId.set(sp.id, sp); return; }
    const seenC = new Set((cur.comments || []).map(c => c.id));
    (sp.comments || []).forEach(c => { if (!seenC.has(c.id)) cur.comments.push(c); });
    cur.comments.sort((a,b) => (a.ts||0) - (b.ts||0));
    Object.entries(sp.reacts || {}).forEach(([e, users]) => {
      cur.reacts[e] = [...new Set([...(cur.reacts[e] || []), ...users])];
    });
  });
  return { user: mine.user || shared.user, posts: [...byId.values()] };
}

/* share URL stays lean: strip images out of the payload */
function shareUrl() {
  const payload = {
    user: db.user || null,
    posts: (db.posts || []).map(p => ({ ...p, img: null }))
  };
  const json = JSON.stringify(payload);
  const packed = window.LZString
    ? LZString.compressToEncodedURIComponent(json)
    : encodeURIComponent(json);
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set(SHARE_KEY, packed);
  return url.toString();
}

/* ---------- misc helpers ---------- */
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div','toast'); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2000);
}

function openModal(sel) {
  const s = $(sel);
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add('open'));
}
function closeModal(sel) {
  const s = $(sel);
  s.classList.remove('open');
  setTimeout(() => { s.hidden = true; }, 250);
}

const greetingFor = h => h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

const MAPS = 'https://www.google.com/maps/search/?api=1&query=';
function mapLink(p) {
  if (!p) return null;
  if (p.lat != null && p.lng != null) {
    return { label: p.place || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`, url: MAPS + `${p.lat},${p.lng}` };
  }
  if (p.place) return { label: p.place, url: MAPS + encodeURIComponent(p.place) };
  return null;
}

/* last activity on a spot = newest comment, else the spot itself */
const lastTs = p => (p.comments || []).reduce((m,c) => Math.max(m, c.ts || 0), p.ts || 0);

/* ================= HOME RENDER ================= */
function render() {
  renderHeader();
  renderStories();
  renderRows();
}

function renderHeader() {
  const av = $('#meAv');
  av.textContent = db.user ? initials(db.user) : '?';
  av.style.background = db.user ? colorFor(db.user) : '#c9cede';
  $('#greeting').textContent = greetingFor(new Date().getHours());
  $('#meName').textContent = db.user || 'Swimmer';
}

function renderStories() {
  const wrap = $('#stories');
  wrap.innerHTML = '';

  // First card: post a spot of your own
  const mine = el('button', 'story');
  const mineAv = el('span','story-av');
  mineAv.append(avatar(db.user || '?', 'xl'));
  const plus = el('span','story-plus','+');
  mineAv.append(plus);
  mine.append(mineAv, el('span','story-name','Your spot'));
  mine.onclick = openComposer;
  wrap.append(mine);

  // Then one card per contributor, most recently active first
  const people = new Map();
  (db.posts || []).forEach(p => {
    const t = lastTs(p);
    const cur = people.get(p.user);
    if (!cur || t > cur.ts) people.set(p.user, { ts: t, unread: 0 });
  });
  (db.posts || []).forEach(p => {
    const rec = people.get(p.user);
    if (rec) rec.unread += unreadCount(p);
  });

  [...people.entries()]
    .filter(([name]) => name !== db.user)
    .sort((a,b) => b[1].ts - a[1].ts)
    .forEach(([name, rec]) => {
      const c = el('button', 'story' + (rec.unread ? ' has-new' : ''));
      const holder = el('span','story-av');
      holder.append(avatar(name, 'xl'));
      c.append(holder, el('span','story-name', name));
      c.onclick = () => {
        searchTerm = name.toLowerCase();
        $('#searchWrap').hidden = false;
        $('#searchInput').value = name;
        renderRows();
      };
      wrap.append(c);
    });
}

function matchesSearch(p) {
  if (!searchTerm) return true;
  const hay = [p.desc, p.place, p.user, ...(p.comments || []).map(c => c.text)]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(searchTerm);
}

function renderRows() {
  const wrap = $('#rows');
  wrap.innerHTML = '';

  const posts = (db.posts || []).filter(matchesSearch).sort((a,b) => lastTs(b) - lastTs(a));

  if (!posts.length) {
    const e = el('div','empty');
    e.append(el('b', null, searchTerm ? 'No spots match' : 'No spots yet'));
    e.append(el('span', null, searchTerm ? 'Try a different search.' : 'Tap + to add the first one.'));
    wrap.append(e);
    return;
  }

  posts.forEach(p => {
    const row = el('button','row');

    const avWrap = el('div','row-av');
    avWrap.append(avatar(p.user, 'xl'));
    row.append(avWrap);

    const main = el('div','row-main');
    main.append(el('div','row-title', p.place || p.desc));

    // preview line: who said what, most recent first
    const comments = p.comments || [];
    const last = comments[comments.length - 1];
    const sub = el('div','row-sub');
    if (last) {
      sub.append(avatar(last.user, 'xs'));
      const t = el('span','row-sub-text');
      t.append(el('b', null, last.user + ': '));
      t.append(document.createTextNode(last.text));
      sub.append(t);
    } else {
      sub.append(el('span','row-sub-text', p.desc));
    }
    main.append(sub);

    // who else is in this thread
    const people = participants(p);
    if (people.length > 1) {
      const faces = el('div','row-faces');
      const pile = el('div','facepile');
      people.slice(0, 4).forEach(n => pile.append(avatar(n, 'xs')));
      faces.append(pile);
      const extra = people.length - 4;
      const label = comments.length
        ? `${people.length} people · ${comments.length} comment${comments.length === 1 ? '' : 's'}`
        : `${people.length} people`;
      faces.append(el('span','row-faces-label', extra > 0 ? `+${extra} · ${label}` : label));
      main.append(faces);
    }

    row.append(main);

    const side = el('div','row-side');
    const n = unreadCount(p);
    const pill = el('span','pill' + (n ? '' : ' zero'), n > 99 ? '99+' : String(n));
    side.append(pill);
    side.append(el('span','row-time', listStamp(lastTs(p))));
    row.append(side);

    row.onclick = () => openThread(p.id);
    wrap.append(row);
  });
}

/* ================= THREAD ================= */
function openThread(id) {
  const p = (db.posts || []).find(x => x.id === id);
  if (!p) return;
  openPostId = id;
  markRead(p);
  renderThread();
  $('#viewHome').hidden = true;
  $('#viewThread').hidden = false;
  setTimeout(() => { const b = $('#threadBody'); b.scrollTop = b.scrollHeight; }, 30);
}

function closeThread() {
  openPostId = null;
  $('#viewThread').hidden = true;
  $('#viewHome').hidden = false;
  render();
}

function renderThread() {
  const p = (db.posts || []).find(x => x.id === openPostId);
  if (!p) return closeThread();

  const av = $('#threadAv');
  av.textContent = initials(p.user);
  av.style.background = colorFor(p.user);
  $('#threadTitle').textContent = p.place || p.desc;
  const people = participants(p);
  const n = (p.comments || []).length;
  $('#threadSub').textContent =
    people.join(', ') + ' · ' + n + ' comment' + (n === 1 ? '' : 's');

  const body = $('#threadBody');
  body.innerHTML = '';
  body.append(spotCard(p));

  let lastDay = '';
  (p.comments || []).slice().sort((a,b) => (a.ts||0) - (b.ts||0)).forEach(c => {
    const d = daySep(c.ts);
    if (d !== lastDay) { body.append(el('div','day-sep', d)); lastDay = d; }
    body.append(bubble(p, c));
  });
}

function spotCard(p) {
  const card = el('div','spot-card');

  const top = el('div','spot-card-top');
  top.append(avatar(p.user, 'md'));
  const who = el('div','spot-card-who');
  who.append(el('b', null, p.user));
  who.append(el('em', null, listStamp(p.ts)));
  top.append(who);
  card.append(top);

  card.append(el('p','spot-desc', p.desc));

  if (p.img) {
    const img = el('img','spot-img');
    img.src = p.img; img.alt = '';
    card.append(img);
  }

  const link = mapLink(p);
  if (link) {
    const a = el('a','geo','📍 ' + link.label);
    a.href = link.url; a.target = '_blank'; a.rel = 'noopener';
    card.append(a);
  }

  card.append(reactBar(p.reacts, (emoji) => toggleReact(p.reacts, emoji)));
  return card;
}

function reactBar(reacts, onPick) {
  const bar = el('div','reacts');
  Object.entries(reacts || {}).forEach(([emoji, users]) => {
    if (!users || !users.length) return;
    const c = el('button','chip' + (users.includes(db.user) ? ' on' : ''), `${emoji} ${users.length}`);
    c.onclick = () => onPick(emoji);
    bar.append(c);
  });
  const add = el('button','chip chip-add','＋');
  add.onclick = () => {
    const used = Object.keys(reacts || {});
    const next = EMOJI.find(e => !used.includes(e)) || EMOJI[0];
    onPick(next);
  };
  bar.append(add);
  return bar;
}

function bubble(p, c) {
  const own = c.user === db.user;
  const m = el('div','msg ' + (own ? 'msg-out' : 'msg-in'));
  m.append(avatar(c.user, 'md'));

  const body = el('div','msg-body');
  const name = el('div','msg-name');
  name.append(el('b', null, own ? 'You' : c.user));
  name.append(document.createTextNode(' · ' + clockTime(c.ts)));
  body.append(name);
  body.append(el('div','bubble', c.text));

  const rr = el('div','msg-reacts');
  Object.entries(c.reacts || {}).forEach(([emoji, users]) => {
    if (!users || !users.length) return;
    const chip = el('button','mini-chip' + (users.includes(db.user) ? ' on' : ''), `${emoji} ${users.length}`);
    chip.onclick = () => toggleReact(c.reacts, emoji);
    rr.append(chip);
  });
  const add = el('button','mini-chip','＋');
  add.onclick = () => {
    const used = Object.keys(c.reacts || {});
    toggleReact(c.reacts, EMOJI.find(e => !used.includes(e)) || EMOJI[0]);
  };
  rr.append(add);
  body.append(rr);

  m.append(body);
  return m;
}

function toggleReact(bucket, emoji) {
  if (!requireName()) return;
  if (!bucket[emoji]) bucket[emoji] = [];
  const i = bucket[emoji].indexOf(db.user);
  if (i < 0) bucket[emoji].push(db.user); else bucket[emoji].splice(i, 1);
  if (!bucket[emoji].length) delete bucket[emoji];
  save();
  renderThread();
}

/* need a name before reacting or commenting */
function requireName() {
  if (db.user && db.user.trim()) return true;
  openManage();
  toast('Add your name first');
  return false;
}

/* ---------- composer (comments) ---------- */
$('#cmInput').oninput = e => {
  $('#cmCount').textContent = e.target.value.length + '/' + MAX_LENGTH;
  $('#cmSend').disabled = !e.target.value.trim();
};
$('#cmInput').onkeydown = e => { if (e.key === 'Enter') sendComment(); };
$('#cmSend').onclick = sendComment;
$('#cmSend').disabled = true;

function sendComment() {
  const input = $('#cmInput');
  const text = input.value.trim().slice(0, MAX_LENGTH);
  if (!text) return;
  if (!requireName()) return;

  const p = (db.posts || []).find(x => x.id === openPostId);
  if (!p) return;
  p.comments = p.comments || [];
  p.comments.push({ id: genId(), user: db.user, text, ts: Date.now(), reacts: {} });
  save();
  markRead(p);

  input.value = '';
  $('#cmCount').textContent = '0/' + MAX_LENGTH;
  $('#cmSend').disabled = true;

  renderThread();
  const b = $('#threadBody');
  b.scrollTop = b.scrollHeight;
}

$('#btnBack').onclick = closeThread;
$('#btnThreadShare').onclick = () => openShare();

/* ================= NEW SPOT ================= */
let draft = { img: null, lat: null, lng: null, place: '' };

function openComposer() {
  draft = { img: null, lat: null, lng: null, place: '' };
  $('#pDesc').value = '';
  $('#pPlace').value = '';
  $('#descCount').textContent = '0/' + MAX_LENGTH;
  clearPhoto();
  showLocPicker();

  const needsName = !db.user || !db.user.trim();
  $('#namePicker').hidden = !needsName;
  $('#pName').value = needsName ? '' : db.user;

  validatePost();
  openModal('#postSheet');
  setTimeout(() => (needsName ? $('#pName') : $('#pDesc')).focus(), 320);
}

$('#btnNew').onclick = openComposer;
$('#postCancel').onclick = () => closeModal('#postSheet');

$('#pDesc').oninput = e => {
  $('#descCount').textContent = e.target.value.length + '/' + MAX_LENGTH;
  validatePost();
};
$('#pPlace').oninput = e => { draft.place = e.target.value.trim(); validatePost(); };
$('#pName').oninput = validatePost;

function validatePost() {
  const hasDesc  = $('#pDesc').value.trim().length > 0;
  const hasLoc   = draft.lat != null || $('#pPlace').value.trim().length > 0;
  const needsName = !db.user || !db.user.trim();
  const hasName  = !needsName || $('#pName').value.trim().length > 0;

  const required = needsName ? 3 : 2;
  const filled   = (hasDesc ? 1 : 0) + (hasLoc ? 1 : 0) + (needsName ? (hasName ? 1 : 0) : 0);

  const btn = $('#postSave');
  btn.disabled = filled < required;
  btn.classList.toggle('full', filled === required);
  btn.style.backgroundPosition = filled === required ? '' : (100 - (filled / required) * 100) + '% 50%';
}

function showLocPicker() {
  $('#locationPicker').hidden = false;
  $('#geoBar').hidden = true;
}
function confirmGeo(text) {
  $('#locationPicker').hidden = true;
  $('#geoBar').hidden = false;
  $('#geoText').textContent = text;
}
function useCoords(lat, lng, from) {
  draft.lat = lat; draft.lng = lng;
  confirmGeo(`${lat.toFixed(4)}, ${lng.toFixed(4)} · from ${from}`);
  validatePost();
}

$('#geoChange').onclick = () => { draft.lat = null; draft.lng = null; showLocPicker(); validatePost(); };

$('#geoDetect').onclick = () => {
  if (!navigator.geolocation) return toast('Location not available');
  const btn = $('#geoDetect');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    pos => { btn.disabled = false; useCoords(+pos.coords.latitude.toFixed(6), +pos.coords.longitude.toFixed(6), 'your device'); },
    () => { btn.disabled = false; toast('Location denied or unavailable'); },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
  );
};

function clearPhoto() {
  draft.img = null;
  $('#pImg').value = '';
  $('#photoChosen').hidden = true;
  $('#photoCta').hidden = false;
}
$('#photoRemove').onclick = e => { e.preventDefault(); e.stopPropagation(); clearPhoto(); };

$('#pImg').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  draft.img = await shrink(f);
  $('#pPrev').src = draft.img || '';
  $('#photoChosen').hidden = false;
  $('#photoCta').hidden = true;
  let gps = null;
  try { gps = exifGPS(await f.arrayBuffer()); } catch {}
  if (gps) useCoords(gps.lat, gps.lng, 'the photo');
};

$('#postSave').onclick = () => {
  if (!db.user || !db.user.trim()) {
    const name = $('#pName').value.trim();
    if (!name) { toast('Add your name first'); $('#pName').focus(); return; }
    db.user = name;
  }
  const desc = $('#pDesc').value.trim().slice(0, MAX_LENGTH);
  if (!desc) return;

  const post = {
    id: genId(),
    user: db.user,
    desc,
    img: draft.img,
    lat: draft.lat,
    lng: draft.lng,
    place: draft.place || $('#pPlace').value.trim(),
    ts: Date.now(),
    reacts: {},
    comments: []
  };
  db.posts = db.posts || [];
  db.posts.push(post);
  save();
  markRead(post);

  closeModal('#postSheet');
  render();
  toast('Spot posted');
};

/* ================= SHARE =================
   The whole point of the app: no backend, so state travels in the link.
   Everyone who opens the link merges your spots into theirs. */
function openShare() {
  const url = shareUrl();
  const posts = (db.posts || []).length;
  const comments = (db.posts || []).reduce((n, p) => n + (p.comments || []).length, 0);

  $('#shareUrl').value = url;
  $('#shareCount').textContent =
    `${posts} spot${posts === 1 ? '' : 's'} · ${comments} comment${comments === 1 ? '' : 's'}`;
  $('#shareTime').textContent = 'Snapshot taken just now';
  $('#shareNote').textContent =
    `${url.length} characters. Everything travels in the link — whoever opens it merges these spots into their own. Photos and unread badges stay on this device.`;
  $('#shareQr').hidden = true;
  $('#shareQr').innerHTML = '';
  openModal('#shareSheet');
}

$('#btnShare').onclick = () => openShare();
$('#shareClose').onclick = () => closeModal('#shareSheet');

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied 📋');
    return true;
  } catch {
    const input = $('#shareUrl');
    input.select();
    try { document.execCommand('copy'); toast('Link copied 📋'); return true; }
    catch { toast('Press ⌘C to copy'); return false; }
  }
}
$('#shareCopy').onclick = () => copyLink($('#shareUrl').value);

$$('.share-option').forEach(btn => {
  btn.onclick = () => {
    const url = $('#shareUrl').value;
    const posts = (db.posts || []).length;
    const title = `water.io — ${posts} open water spot${posts === 1 ? '' : 's'}`;
    const text = `${title}. Open the link to add them to yours:`;

    switch (btn.dataset.share) {
      case 'copy':
        copyLink(url);
        break;
      case 'whatsapp':
        window.open(`https://wa.me/?text=${encodeURIComponent(text + '\n' + url)}`, '_blank', 'noopener');
        break;
      case 'telegram':
        window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`, '_blank', 'noopener');
        break;
      case 'facebook':
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(title)}`, '_blank', 'noopener');
        break;
      case 'email':
        window.location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text + '\n\n' + url)}`;
        break;
      case 'sms':
        window.location.href = `sms:?&body=${encodeURIComponent(text + ' ' + url)}`;
        break;
      case 'qr':
        showQr(url);
        break;
      case 'native':
        if (navigator.share) navigator.share({ title, text, url }).catch(() => {});
        else copyLink(url);
        break;
    }
  };
});

/* QR is handy for handing spots to the person standing next to you */
function showQr(url) {
  const box = $('#shareQr');
  box.hidden = false;
  box.innerHTML = '';
  const img = document.createElement('img');
  img.width = 180; img.height = 180; img.alt = 'QR code for this link';
  img.style.cssText = 'border-radius:12px;border:1px solid var(--line);padding:8px;background:#fff';
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=' + encodeURIComponent(url);
  img.onerror = () => { box.textContent = 'QR needs a connection — copy the link instead.'; };
  box.append(img);
  box.append(el('p','share-note','Point a camera at this to open the same spots.'));
}

/* ================= MANAGE ================= */
function openManage() {
  $('#mgName').value = db.user || '';
  openModal('#manageSheet');
}
$('#btnManage').onclick = openManage;
$('#btnMe').onclick = openManage;
$('#manageClose').onclick = () => closeModal('#manageSheet');

$('#mgSave').onclick = () => {
  const name = $('#mgName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  db.user = name;
  save();
  closeModal('#manageSheet');
  render();
  toast('Saved');
};

$('#mgShare').onclick = () => { closeModal('#manageSheet'); setTimeout(openShare, 260); };
$('#mgReadAll').onclick = () => { markAllRead(); render(); toast('All caught up'); };

$('#mgClear').onclick = () => {
  Object.keys(localStorage).filter(k => k.startsWith('water.')).forEach(k => localStorage.removeItem(k));
  location.href = location.pathname;
};

/* ================= SEARCH ================= */
$('#btnSearch').onclick = () => {
  const w = $('#searchWrap');
  w.hidden = !w.hidden;
  if (!w.hidden) $('#searchInput').focus();
  else { searchTerm = ''; $('#searchInput').value = ''; renderRows(); }
};
$('#searchInput').oninput = e => { searchTerm = e.target.value.trim().toLowerCase(); renderRows(); };
$('#searchClear').onclick = () => {
  $('#searchInput').value = ''; searchTerm = '';
  $('#searchWrap').hidden = true;
  renderRows();
};

/* close modals on scrim click / escape */
$$('.scrim').forEach(s => {
  s.addEventListener('click', e => { if (e.target === s) closeModal('#' + s.id); });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = $$('.scrim').find(s => !s.hidden);
  if (open) return closeModal('#' + open.id);
  if (openPostId) closeThread();
});

/* ================= image helpers (ported from v1) ================= */
function shrink(file, max = 900) {
  return new Promise(res => {
    try {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = img.width * s; c.height = img.height * s;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => res(null);
      img.src = URL.createObjectURL(file);
    } catch { res(null); }
  });
}

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
      const ifd = tiff + u32(tiff + 4);
      let gps = 0;
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
  } catch {}
  return null;
}

/* ================= seed (same content as v1) ================= */
function seed() {
  const now = Date.now(), h = 3600e3;
  return [
    {
      id: '_seed01', user: 'Jussi',
      desc: 'Calm bay at Seurasaari, sandy bottom, easy entry.',
      img: null, lat: 60.1789, lng: 24.8836, place: 'Seurasaari, Helsinki',
      ts: now - 26 * h,
      reacts: { '🌊': ['Martti','Laura P.'], '🏊': ['Laura P.'] },
      comments: [
        { id: '_seedc01', user: 'Martti',   text: 'Went yesterday — 17°C, perfect.', ts: now - 20 * h, reacts: { '👏': ['Jussi'] } },
        { id: '_seedc02', user: 'Laura P.', text: 'Parking fills up before 9.',      ts: now - 5 * h,  reacts: {} }
      ]
    },
    {
      id: '_seed02', user: 'Laura P.',
      desc: 'Deep off the Vuosaari pier. Ladder stays in winter.',
      img: null, lat: 60.2093, lng: 25.1442, place: 'Vuosaari pier, Helsinki',
      ts: now - 9 * h,
      reacts: { '❄️': ['Jussi','Martti'] },
      comments: [
        { id: '_seedc03', user: 'Jussi', text: 'Ice hole kept open all January.', ts: now - 2 * h, reacts: { '🔥': ['Laura P.'] } }
      ]
    },
    {
      id: '_seed03', user: 'Martti',
      desc: 'Pikku Kallahti — shallow, warm, good for a long swim.',
      img: null, lat: null, lng: null, place: 'Pikku Kallahti, Helsinki',
      ts: now - 40 * 60e3,
      reacts: { '🏊': ['Laura P.'] },
      comments: []
    }
  ];
}

/* ================= boot ================= */
const arrivedShared = !!new URLSearchParams(location.search).get(SHARE_KEY);
const beforeCount = (() => {
  try { const d = JSON.parse(store.getItem(KEY)); return d && d.posts ? d.posts.length : 0; }
  catch { return 0; }
})();

db = load();
if (!db.posts) db.posts = [];
save();
render();

if (arrivedShared) {
  const gained = db.posts.length - beforeCount;
  // drop the payload from the address bar once it's merged in — reloads stay clean
  if (window.history && history.replaceState) {
    history.replaceState({}, '', location.pathname);
  }
  setTimeout(() => {
    toast(gained > 0
      ? `${gained} new spot${gained === 1 ? '' : 's'} merged in`
      : 'Already up to date');
  }, 500);
}

window._v2 = { db, shareUrl, readSeen, participants };
})();
