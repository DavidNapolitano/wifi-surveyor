'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'X-Requested-With': 'surveyor', ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const del = (p) => api(p, { method: 'DELETE' });

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

// In-page replacement for window.prompt(); resolves to the trimmed text or null.
function askName(title, placeholder, value = '', hint = '') {
  return new Promise((resolve) => {
    const dlg = $('#ask'), input = $('#askinput');
    $('#asktitle').textContent = title;
    $('#askhint').textContent = hint;
    input.placeholder = placeholder;
    input.value = value;
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null);
    dlg.returnValue = '';
    dlg.showModal();
    input.select();
  });
}

// History selection per group: null = let the server pick the strongest 8.
function loadSel() {
  try {
    const s = JSON.parse(localStorage.getItem('hsel'));
    const ok = (v) => v === null || Array.isArray(v);
    if (s && ok(s.ssid) && ok(s.bssid)) return s;
  } catch { /* fall through */ }
  return { ssid: null, bssid: null };
}

const S = {
  target: localStorage.getItem('target') ?? '',
  dead: Number(localStorage.getItem('dead') ?? -80),
  duration: Number(localStorage.getItem('segment') ?? 0),
  sel: loadSel(),
  tab: 'live',
  status: null, ts: null, rooms: [], histWin: null, live: null, chan: null, rules: [], apNames: {},
  nsort: (() => { try { return JSON.parse(localStorage.getItem('nsort')) || { key: 'avg', dir: -1 }; } catch { return { key: 'avg', dir: -1 }; } })(),
  open: new Set(),
};
const save = () => {
  localStorage.setItem('target', S.target);
  localStorage.setItem('dead', S.dead);
  localStorage.setItem('segment', S.duration);
  localStorage.setItem('hsel', JSON.stringify(S.sel));
};

// ---------- formatting & colour ----------
const YMIN = -100, YMAX = -20;
const dbm = (v) => (v == null ? '–' : `${Math.round(v)} dBm`);
const pct = (v) => `${Math.round((v || 0) * 100)}%`;
const fmtDateTime = (t) => new Date(t * 1000).toLocaleString();
function fmtAxis(t, span) {
  const d = new Date(t * 1000);
  if (span > 2 * 86400) return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (span > 1800) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
function fmtClockDur(s) {
  s = Math.max(0, Math.floor(s));
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}
const phyLabel = (phy, band) => ({
  be: 'Wi-Fi 7', ax: band === '6' ? 'Wi-Fi 6E' : 'Wi-Fi 6', ac: 'Wi-Fi 5', n: 'Wi-Fi 4', g: '802.11g', a: '802.11a', b: '802.11b',
}[phy] || '–');

function quality(v, seen = 1) {
  if (v == null || seen < 0.5 || v < S.dead) return 'dead';
  if (v >= -60) return 'excellent';
  if (v >= -67) return 'good';
  if (v >= -75) return 'fair';
  return 'weak';
}
// Red at (dead - 10) dBm through to green at -50 dBm.
const hue = (v) => Math.max(0, Math.min(1, (v - (S.dead - 10)) / (-50 - (S.dead - 10)))) * 120;
const rssiColor = (v, a = 1) => `hsla(${hue(v)}, 80%, 42%, ${a})`;

const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf',
  '#bcbd22', '#7f7f7f', '#393b79', '#ad494a', '#637939', '#843c39', '#5254a3', '#6b6ecf'];
// Canvas colours come from the CSS variables so charts follow light/dark mode.
const TH = {};
function loadTheme() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['grid', 'axis', 'text', 'ink', 'muted']) TH[k] = cs.getPropertyValue(`--${k}`).trim();
}
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  loadTheme();
}
applyTheme(localStorage.getItem('theme') || '');
const colorMap = new Map();
function seriesColor(key) {
  if (key === '(connected)') return TH.ink;
  if (!colorMap.has(key)) colorMap.set(key, PALETTE[colorMap.size % PALETTE.length]);
  return colorMap.get(key);
}
const seriesLabel = (s) => (s.key === '(connected)' ? 'Connected link'
  : $('#group').value === 'bssid' ? `${S.apNames[s.key] ? `${S.apNames[s.key]} · ` : ''}${s.label ?? '(unknown)'} · ${s.key}` : s.key);

const cell = (v) => el('td', {}, el('span', { class: 'val', style: v == null ? null : `color:${rssiColor(v)}` }, dbm(v)));
const badge = (q) => el('span', { class: `badge q-${q}` }, q);
const swatch = (color) => el('span', { class: 'sw', style: `background:${color}` });

function setupCanvas(c, w, h) {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  return ctx;
}

// Signal value for the chosen target: '' = network the Mac is connected to, '*' = strongest network in each room.
function targetValue(stats) {
  if (!S.target) {
    return {
      avg: stats.conn_avg, min: stats.conn_min,
      seen: stats.samples ? stats.conn_n / stats.samples : 0,
      best: stats.bssids.find((b) => b.ssid === stats.conn_ssid) || null, name: stats.conn_ssid,
    };
  }
  const s = S.target === '*' ? stats.ssids[0] : stats.ssids.find((x) => x.ssid === S.target);
  if (!s) return { avg: null, min: null, seen: 0, best: null, name: null };
  return { avg: s.avg, min: s.min, seen: s.seen, best: stats.bssids.find((b) => b.ssid === s.ssid) || null, name: s.ssid };
}
const targetName = () => (S.target === '*' ? 'strongest network in each room' : S.target ? `"${S.target}"` : 'connected network');
const apName = (b) => S.apNames[b.bssid] || (b.ssid === '(hidden)' && b.alias ? `${b.alias} (hidden radio)` : b.ssid);
// Label for a per-AP stats row: nickname, or "SSID · BSSID" when the AP has no name yet.
const apRowLabel = (x) => (x.named ? x.ap : `${x.ssid} · ${x.ap}`);

async function refreshApNames() {
  S.apNames = await api('/api/apnames');
}

// BSSIDs that are probably radios of the same physical AP.
function relatedBssid(a, b) {
  if (a === b) return true;
  const x = a.split(':'), y = b.split(':');
  if (x.length !== 6 || y.length !== 6) return false;
  if (x.slice(1).join(':') === y.slice(1).join(':')) return true;
  return x.slice(0, 5).join(':') === y.slice(0, 5).join(':') && x[5][0] === y[5][0];
}

async function nameAp(bssid) {
  const data = await api('/api/live?since=3600&all=1&points=0');
  const cur = S.apNames[bssid] || '';
  const rel = (b) => relatedBssid(bssid, b) || (cur && S.apNames[b] === cur);
  const list = data.aps.filter((a) => a.bssid !== '(redacted)')
    .sort((a, b) => rel(b.bssid) - rel(a.bssid) || (b.avg ?? -999) - (a.avg ?? -999));
  $('#apbssids').replaceChildren(...list.map((a) => {
    const cb = el('input', { type: 'checkbox', value: a.bssid });
    cb.checked = !!rel(a.bssid);
    const other = S.apNames[a.bssid] && S.apNames[a.bssid] !== cur ? S.apNames[a.bssid] : null;
    return el('label', { class: 'apopt' }, cb, el('span', { class: 'mono' }, a.bssid),
      el('span', {}, `${a.ssid} · ch ${a.channel ?? '?'} · ${a.band ?? '?'} GHz`),
      el('span', { class: 'val', style: `color:${rssiColor(a.now ?? a.avg)}` }, dbm(a.now ?? a.avg)),
      other ? el('span', { class: 'tag' }, other) : null);
  }));
  $('#apname').value = cur;
  $('#apclear').hidden = !cur;
  const dlg = $('#apdlg');
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok' && dlg.returnValue !== 'clear') return;
    const picked = [...$$('#apbssids input:checked')].map((i) => i.value);
    if (!picked.includes(bssid)) picked.push(bssid);
    const name = dlg.returnValue === 'clear' ? '' : $('#apname').value.trim();
    // BSSIDs that had the old name but were unticked lose it.
    const dropped = cur ? Object.keys(S.apNames).filter((b) => S.apNames[b] === cur && !picked.includes(b)) : [];
    try {
      await post('/api/apnames', { name, bssids: picked });
      if (dropped.length) await post('/api/apnames', { name: '', bssids: dropped });
      await refreshApNames();
      toast(name ? `Named ${picked.length} BSSID${picked.length > 1 ? 's' : ''} "${name}"` : 'Name removed');
      TABS[S.tab]();
    } catch (e) { toast(e.message); }
  };
  dlg.showModal();
  $('#apname').focus();
}

// ---------- status, recording, rooms bar ----------
async function refreshStatus() {
  const prev = S.status?.capture?.id;
  const st = (S.status = await api('/api/status'));
  const sc = st.scanner, l = st.last, rec = st.recording;

  const pill = $('#scanner');
  if (!sc.feed) { pill.textContent = 'review mode (no scanner)'; pill.className = 'pill'; }
  else if (sc.alive) {
    pill.textContent = sc.rate ? `scanning · every ${sc.rate.toFixed(1)}s` : 'scanning';
    pill.title = `Requested every ${sc.interval}s; macOS scans can take longer.`;
    pill.className = 'pill ok';
  }
  else { pill.textContent = 'waiting for scanner…'; pill.className = 'pill bad'; }

  const btn = $('#record');
  btn.disabled = !sc.feed;
  btn.classList.toggle('on', !!rec);
  btn.textContent = rec ? `■ ${fmtClockDur(st.now - rec.start_ts)}` : '● Record';
  btn.title = rec ? 'Stop recording' : `Record into "${st.session?.name ?? ''}"`;
  $('#recinfo').textContent = rec ? `${rec.samples} scans` : '';
  $('#session').disabled = $('#newsession').disabled = !!rec;
  $('#session').title = rec ? 'Stop recording to switch sessions' : '';

  const conn = $('#conn');
  if (l && l.rssi != null) {
    const details = [`BSSID ${l.bssid ?? 'hidden'}`];
    if (l.noise) details.push(`noise ${l.noise} dBm, SNR ${l.rssi - l.noise} dB`);
    if (l.width) details.push(`${l.width} MHz wide`);
    if (l.tx_rate) details.push(`${Math.round(l.tx_rate)} Mbps link rate`);
    if (l.tx_power) details.push(`tx power ${l.tx_power} mW`);
    conn.title = details.join('\n');
    conn.replaceChildren(el('b', {}, l.ssid ?? '(name hidden)'), l.bssid && S.apNames[l.bssid] ? ` via ${S.apNames[l.bssid]}` : '', ' ',
      el('span', { class: 'val', style: `color:${rssiColor(l.rssi)}` }, dbm(l.rssi)),
      l.channel ? ` · ch ${l.channel}${l.band ? ` · ${l.band} GHz` : ''}` : '',
      l.phy ? ` · ${phyLabel(l.phy, l.band)}` : '');
  } else { conn.textContent = l ? 'Not connected to Wi-Fi' : ''; conn.title = ''; }

  const warn = [];
  if (sc.feed && sc.auth && !sc.auth.startsWith('authorized')) {
    warn.push(sc.auth === 'notDetermined'
      ? 'Waiting for Location permission: approve the "WiFi Surveyor" prompt so macOS reveals network names and BSSIDs.'
      : 'Location permission denied: SSIDs/BSSIDs are hidden. Enable "WiFi Surveyor" in System Settings → Privacy & Security → Location Services, then reopen the app.');
  }
  if (sc.scan_error) warn.push(`Last scan failed: ${sc.scan_error}`);
  $('#warn').hidden = !warn.length;
  $('#warn').textContent = warn.join(' ');

  renderRoomBar();
  if (S.walk) renderWalk();
  if (prev && prev !== st.capture?.id) {
    once('rooms', refreshRooms);
  }
}

let roomBarKey = '';
function renderRoomBar() {
  const cap = S.status?.capture, rec = S.status?.recording;
  const key = JSON.stringify([S.rooms.map((r) => [r.id, r.name]), cap?.room_id ?? null]);
  if (key !== roomBarKey) {
    roomBarKey = key;
    $('#roombtns').replaceChildren(
      ...S.rooms.map((r) => el('button', {
        class: cap?.room_id === r.id ? 'active' : null,
        onclick: () => (cap?.room_id === r.id ? stopCapture() : startCapture(r.id)),
      }, r.name)),
      ...(cap ? [el('button', { class: 'endroom', onclick: stopCapture }, '\u23f9 End room (keep recording)')] : []));
  }
  let hint;
  if (cap) {
    const v = targetValue(cap.stats);
    hint = `Attributing to "${cap.room}": ${cap.stats.samples} scans · ${targetName()} avg ${dbm(v.avg)}`
      + (cap.end_ts ? ` · ${fmtDur(cap.end_ts - S.status.now)} left` : '');
  } else if (rec) hint = 'Recording without a room. Tap a room when you walk into it.';
  else hint = 'Tap a room to start recording in it, or press Record to log while you walk without naming rooms.';
  $('#roomhint').textContent = hint;
}

async function toggleRecord() {
  try {
    await post(S.status?.recording ? '/api/record/stop' : '/api/record/start');
    await once('status', refreshStatus);
  } catch (e) { toast(e.message); }
}

async function quickRoom() {
  const name = await askName('New room', 'Room name, e.g. Kitchen');
  if (!name || !name.trim()) return;
  try {
    const r = await post('/api/rooms', { name: name.trim() });
    await refreshRooms();
    if (confirm(`Start recording in "${name.trim()}" now?`)) startCapture(r.id);
  } catch (e) { toast(e.message); }
}

async function quitApp() {
  if (!confirm('Quit WiFi Surveyor? Scanning stops and any recording is saved.')) return;
  S.quit = true;
  clearInterval(S.timer);
  try { await post('/api/quit'); } catch { /* the server is going away */ }
  document.body.replaceChildren(el('div', { class: 'quitmsg' }, el('h1', {}, 'WiFi Surveyor has quit'),
    el('p', {}, 'Your recording is saved. You can close this tab and reopen the app from the Dock or Finder.')));
}

// ---------- history (recorded data) ----------
async function refreshHistory() {
  const group = $('#group').value;
  const win = S.histWin ? `start=${S.histWin.start}&end=${S.histWin.end}` : `since=${$('#range').value}`;
  const keys = S.sel[group] == null ? '' : `&keys=${encodeURIComponent(JSON.stringify(S.sel[group]))}`;
  S.ts = await api(`/api/timeseries?${win}&group=${group}${keys}`);
  drawChart();
  renderChips();
  $('#rangeinfo').textContent = S.histWin ? `${fmtDateTime(S.histWin.start)} – ${fmtDateTime(S.histWin.end)}` : '';
  renderRecordings(await api('/api/recordings'));
  renderSessions(await api('/api/sessions'));
}

// ---------- sessions ----------
async function refreshSessions() {
  const list = await api('/api/sessions'), sel = $('#session');
  if (document.activeElement !== sel) {
    sel.replaceChildren(...list.map((s) => el('option', { value: s.id }, s.name)));
    const cur = list.find((s) => s.current);
    if (cur) sel.value = String(cur.id);
  }
  return list;
}

// Session data touches every tab, so a reload is the simplest way to switch cleanly.
async function switchSession(id) {
  try {
    await post(`/api/sessions/${id}/activate`);
    location.reload();
  } catch (e) { toast(e.message); refreshSessions(); }
}

async function newSession() {
  const name = await askName('New session', 'e.g. Home, Nov 11', '', 'Everything you record from now on goes into this session.');
  if (!name || !name.trim()) return;
  try {
    await post('/api/sessions', { name: name.trim() });
    location.reload();
  } catch (e) { toast(e.message); }
}

function renderSessions(list) {
  const recording = !!S.status?.recording;
  const span = (s) => (s.first_ts ? `${fmtDateTime(s.first_ts)} – ${fmtDateTime(s.last_ts)}` : '–');
  $('#sessions tbody').replaceChildren(...list.map((s) => el('tr', { class: s.current ? 'connected' : null },
    el('td', {}, el('b', {}, s.name), s.current ? el('span', { class: 'tag conn' }, 'current') : null),
    el('td', {}, s.recordings), el('td', {}, s.scans), el('td', {}, s.rooms), el('td', {}, span(s)),
    el('td', { class: 'actions' },
      s.current ? null : el('button', { disabled: recording, onclick: () => switchSession(s.id) }, 'Open'),
      el('button', { onclick: () => renameSession(s) }, 'Rename'),
      s.current ? null : el('button', { class: 'danger', onclick: () => deleteSession(s) }, 'Delete')))));
}

async function renameSession(s) {
  const name = await askName('Rename session', 'Session name', s.name);
  if (!name || !name.trim() || name.trim() === s.name) return;
  try {
    await post(`/api/sessions/${s.id}/rename`, { name: name.trim() });
    await refreshSessions();
    once('history', refreshHistory);
  } catch (e) { toast(e.message); }
}

async function deleteSession(s) {
  if (!confirm(`Delete session "${s.name}" with ${s.recordings} recordings, ${s.scans} scans and ${s.rooms} rooms? This cannot be undone.`)) return;
  try {
    await del(`/api/sessions/${s.id}`);
    await refreshSessions();
    once('history', refreshHistory);
  } catch (e) { toast(e.message); }
}

function renderChips() {
  const group = $('#group').value, sel = new Set(S.ts.keys || []);
  const chips = S.ts.available.map((a) => {
    const cb = el('input', { type: 'checkbox', onchange: (e) => toggleSel(group, a.k, e.target.checked) });
    cb.checked = sel.has(a.k);
    const label = group === 'bssid' ? `${a.label ?? '(unknown)'} · ${a.k}` : a.k;
    return el('label', { class: 'chip' }, cb, sel.has(a.k) ? swatch(seriesColor(a.k)) : null, label,
      el('span', { class: 'muted' }, ` ${dbm(a.avg)}`));
  });
  if (S.ts.series.some((s) => s.key === '(connected)')) chips.unshift(el('span', { class: 'chip' }, swatch(TH.ink), 'Connected link (dashed)'));
  const rooms = new Map((S.ts.segments || []).map((s) => [s.room_id, s.room]));
  for (const [id, name] of rooms) chips.push(el('span', { class: 'chip room' }, swatch(roomColor(id)), `Room: ${name}`));
  if (!S.ts.available.length) chips.push(el('span', { class: 'muted' }, 'Nothing recorded in this range. Press Record to log scans.'));
  $('#chips').replaceChildren(...chips);
}

function toggleSel(group, key, on) {
  const s = new Set(S.ts?.keys || []);
  on ? s.add(key) : s.delete(key);
  S.sel[group] = [...s].slice(0, 40);
  save();
  once('history', refreshHistory);
}

function renderRecordings(recs) {
  $('#recs tbody').replaceChildren(...recs.map((r) => el('tr', {},
    el('td', {}, fmtDateTime(r.start_ts)),
    el('td', {}, r.end_ts ? fmtDur(r.end_ts - r.start_ts) : 'recording…'),
    el('td', {}, r.samples), el('td', {}, r.rooms || '–'),
    el('td', { class: 'actions' },
      el('button', { onclick: () => showRecording(r) }, 'Show'),
      r.end_ts ? el('button', { class: 'danger', onclick: () => deleteRecording(r) }, 'Delete') : null))));
}

function showRecording(r) {
  S.histWin = { start: r.start_ts, end: r.end_ts || S.status.now };
  $('#range').value = 'custom';
  once('history', refreshHistory);
}

async function deleteRecording(r) {
  if (!confirm(`Delete the recording from ${fmtDateTime(r.start_ts)} (${r.samples} scans)? Room segments inside it are deleted too.`)) return;
  try { await del(`/api/recordings/${r.id}`); } catch (e) { toast(e.message); }
  once('history', refreshHistory);
  once('rooms', refreshRooms);
}

// Stable, well-separated colour per room id.
const roomColor = (id, a = 1) => `hsla(${(id * 137.508) % 360}, 55%, 50%, ${a})`;
const segmentAt = (t) => (S.ts?.segments || []).find((s) => t >= s.start_ts && t <= s.end_ts);

function drawChart(hoverT = null) {
  const c = $('#chart'), data = S.ts;
  if (!data) return;
  const segs = data.segments || [], lane = segs.length ? 24 : 0;
  const w = c.parentElement.clientWidth - 12, h = 360 + lane;
  const ctx = setupCanvas(c, w, h);
  const L = 50, R = 14, T = 10, B = 26 + lane, pw = w - L - R, ph = h - T - B;
  const { t0, t1 } = data, span = Math.max(1, t1 - t0);
  const X = (t) => L + ((t - t0) / span) * pw;
  const Y = (v) => T + ((YMAX - Math.max(YMIN, Math.min(YMAX, v))) / (YMAX - YMIN)) * ph;
  c._map = { L, pw, t0, span };

  const zones = [[YMAX, -67, 'rgba(46,160,67,.08)'], [-67, -75, 'rgba(210,180,0,.10)'],
    [-75, S.dead, 'rgba(240,120,0,.10)'], [S.dead, YMIN, 'rgba(220,40,40,.10)']];
  for (const [a, b, col] of zones) {
    if (a <= b) continue;
    ctx.fillStyle = col;
    ctx.fillRect(L, Y(a), pw, Y(b) - Y(a));
  }

  if (lane) {
    const ly = T + ph + 4, lh = 18;
    ctx.save();
    ctx.beginPath(); ctx.rect(L, 0, pw, h); ctx.clip();
    ctx.font = '11px -apple-system, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const s of segs) {
      const x0 = X(Math.max(s.start_ts, t0)), x1 = X(Math.min(s.end_ts, t1)), bw = Math.max(2, x1 - x0);
      ctx.fillStyle = roomColor(s.room_id, 0.07);
      ctx.fillRect(x0, T, bw, ph);
      ctx.fillStyle = roomColor(s.room_id, 0.85);
      ctx.fillRect(x0, ly, bw, lh);
      const tw = ctx.measureText(s.room).width;
      if (tw + 8 < bw) { ctx.fillStyle = '#fff'; ctx.fillText(s.room, x0 + 4, ly + lh / 2); }
    }
    ctx.restore();
    ctx.fillStyle = TH.axis; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.fillText('Room', L - 6, ly + lh / 2);
    ctx.font = '11px -apple-system, system-ui, sans-serif';
  }

  ctx.strokeStyle = TH.grid; ctx.fillStyle = TH.axis; ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = YMIN; v <= YMAX; v += 10) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
    ctx.fillText(`${v}`, L - 6, y);
  }
  ctx.save(); ctx.translate(12, T + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('dBm', 0, 0); ctx.restore();
  ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  for (let i = 0; i <= 6; i++) {
    const t = t0 + (span * i) / 6, label = fmtAxis(t, span), tw = ctx.measureText(label).width;
    const align = i === 0 ? 'left' : i === 6 ? 'right' : 'center';
    const left = align === 'left' ? X(t) : align === 'right' ? X(t) - tw : X(t) - tw / 2;
    if (left < lastRight + 8) continue;
    ctx.textAlign = align;
    ctx.fillText(label, X(t), T + ph + lane + 6);
    lastRight = left + tw;
  }

  const gap = Math.max(data.bucket * 3, (S.status?.scanner?.interval || 5) * 3);
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  for (const s of data.series) {
    const col = seriesColor(s.key), conn = s.key === '(connected)';
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = conn ? 2.5 : 1.6;
    ctx.setLineDash(conn ? [6, 4] : []);
    ctx.beginPath();
    let prev = null;
    for (const [t, v] of s.points) {
      if (prev === null || t - prev > gap) ctx.moveTo(X(t), Y(v)); else ctx.lineTo(X(t), Y(v));
      prev = t;
    }
    ctx.stroke();
    if (s.points.length < 200) {
      for (const [t, v] of s.points) { ctx.beginPath(); ctx.arc(X(t), Y(v), 1.8, 0, 2 * Math.PI); ctx.fill(); }
    }
  }
  ctx.restore();
  ctx.setLineDash([]);

  if (hoverT != null) {
    ctx.strokeStyle = TH.axis;
    ctx.beginPath(); ctx.moveTo(X(hoverT) + 0.5, T); ctx.lineTo(X(hoverT) + 0.5, T + ph + lane); ctx.stroke();
  }
}

function onChartMove(e) {
  const c = $('#chart'), m = c._map, data = S.ts;
  if (!m || !data) return;
  const x = e.clientX - c.getBoundingClientRect().left;
  if (x < m.L || x > m.L + m.pw) return onChartLeave();
  const t = m.t0 + ((x - m.L) / m.pw) * m.span;
  const rows = [];
  for (const s of data.series) {
    let best = null;
    for (const p of s.points) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    if (best && Math.abs(best[0] - t) <= data.bucket * 1.5 + 5) rows.push([s, best[1]]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  drawChart(t);
  const tip = $('#tip'), seg = segmentAt(t);
  tip.replaceChildren(el('b', {}, fmtDateTime(t)),
    el('div', {}, seg ? [swatch(roomColor(seg.room_id)), `Room: ${seg.room}`] : el('span', { class: 'muted' }, 'No room attributed')),
    ...rows.map(([s, v]) => el('div', {}, swatch(seriesColor(s.key)), `${seriesLabel(s)}: ${dbm(v)}`)));
  tip.hidden = false;
  const left = e.clientX + 16 + tip.offsetWidth > window.innerWidth ? e.clientX - tip.offsetWidth - 16 : e.clientX + 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${e.clientY + 12}px`;
}
function onChartLeave() {
  $('#tip').hidden = true;
  drawChart();
}

// ---------- rooms ----------
async function refreshRooms() {
  S.rooms = await api('/api/rooms');
  renderRooms();
  renderRoomBar();
}

async function startCapture(roomId) {
  try {
    const r = await post('/api/capture/start', { room_id: roomId, duration: S.duration || null });
    if (r.recording_started) toast('Recording started');
    await once('status', refreshStatus);
    if (S.tab === 'rooms') once('rooms', refreshRooms);
  } catch (e) { toast(e.message); }
}

async function stopCapture() {
  try {
    await post('/api/capture/stop');
    await once('status', refreshStatus);
  } catch (e) { toast(e.message); }
}

async function deleteRoom(r) {
  if (!confirm(`Delete room "${r.name}" and all ${r.captures.length} of its segments?`)) return;
  try { await del(`/api/rooms/${r.id}`); } catch (e) { toast(e.message); }
  once('rooms', refreshRooms);
}

async function deleteCapture(id) {
  if (!confirm('Delete this room segment? (The recorded scans stay in the recording.)')) return;
  try { await del(`/api/captures/${id}`); } catch (e) { toast(e.message); }
  once('rooms', refreshRooms);
}

// Horizontal strength meter from -100 to -30 dBm with the dead-spot threshold marked.
function meter(v, cls = '') {
  const span = -30 - YMIN, f = v == null ? 0 : Math.max(0.02, Math.min(1, (v - YMIN) / span));
  return el('div', { class: `meter ${cls}` },
    el('span', { class: 'fill', style: `width:${(f * 100).toFixed(1)}%;background:${v == null ? 'var(--line2)' : rssiColor(v)}` }),
    el('span', { class: 'deadmark', style: `left:${(((S.dead - YMIN) / span) * 100).toFixed(1)}%`, title: `Dead spot below ${S.dead} dBm` }));
}
const fact = (k, v) => el('div', { class: 'fact' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));

function renderRooms() {
  $('#roomtarget').textContent = targetName();
  const active = S.status?.capture, sort = $('#rsort').value;
  const score = (r) => (r.stats.samples ? targetValue(r.stats).avg ?? -998 : -999);
  const rooms = S.rooms.slice().sort((a, b) => {
    const nd = (score(a) === -999) - (score(b) === -999);
    if (nd) return nd;
    if (sort === 'name') return a.name.localeCompare(b.name);
    return sort === 'worst' ? score(a) - score(b) : score(b) - score(a);
  });
  $('#roomcards').replaceChildren(...(rooms.length ? rooms.map((r) => roomCard(r, active))
    : [el('div', { class: 'empty' }, el('b', {}, 'No rooms yet'), 'Add a room above, or tap "+ Room" in the room bar while you walk.')]));
  if ($('#compare').open) renderRoomMatrix();
}

function roomCard(r, active) {
  const st = r.stats, has = st.samples > 0, byAp = $('#rview').value === 'ap', ap0 = st.aps?.[0];
  const v = !byAp ? targetValue(st)
    : ap0 ? { avg: ap0.avg, min: ap0.min, seen: ap0.seen, best: null, name: apRowLabel(ap0) } : { avg: null, min: null, seen: 0, best: null, name: null };
  const q = has ? quality(v.avg, v.seen) : null;
  const here = active?.room_id === r.id, open = S.open.has(r.id), via = st.conn?.[0];
  const nseg = r.captures.length;
  const head = el('div', { class: 'rhead' },
    el('div', { class: 'rtitle' },
      el('div', { class: 'rname' }, r.name, here ? el('span', { class: 'tag live' }, '\u25cf recording here') : null),
      el('div', { class: 'muted' }, has ? `${st.samples} scans \u00b7 ${nseg} visit${nseg === 1 ? '' : 's'}` : 'Not recorded yet')),
    has ? el('div', { class: 'rbig' },
      el('span', { class: 'num', style: v.avg == null ? null : `color:${rssiColor(v.avg)}` }, v.avg == null ? '\u2013' : Math.round(v.avg)),
      el('span', { class: 'unit' }, 'dBm'), badge(q)) : null);
  const body = [];
  if (has) {
    body.push(meter(v.avg));
    body.push(el('div', { class: 'rfacts' },
      fact('Weakest', dbm(v.min)), fact('Heard', pct(v.seen)),
      !byAp && S.target === '*' && v.name ? fact('Best network', v.name) : null,
      byAp ? fact('Best access point', v.name ?? '\u2013')
        : fact('Strongest AP', v.best ? [apName(v.best), el('br'), el('span', { class: 'mono muted' }, `${v.best.bssid} \u00b7 ch ${v.best.channel ?? '?'}`)] : '\u2013'),
      fact('Mac connected to', via ? [S.apNames[via.bssid] ? el('b', {}, S.apNames[via.bssid]) : el('span', { class: 'mono' }, via.bssid), el('br'),
        el('span', { class: 'muted' }, `ch ${via.channel ?? '?'} \u00b7 ${pct(via.seen)} of the time`),
        st.conn.length > 1 ? el('span', { class: 'tag' }, `roamed \u00d7${st.conn.length}`) : null] : '\u2013')));
    const rows = byAp ? (st.aps || []).slice(0, 5).map((x) => [apRowLabel(x), x.avg, x.named || x.ap === '(redacted)' ? null : x.ap])
      : st.ssids.slice(0, 4).map((s) => [s.ssid, s.avg, null]);
    body.push(el('div', { class: 'rnets' }, el('div', { class: 'k' }, byAp ? 'Access points here' : 'Networks here'),
      ...rows.map(([label, avg, unnamed]) => el('div', { class: 'rnet' },
        unnamed ? el('a', { class: 'rnetname', href: '#', title: 'Name this access point',
          onclick: (e) => { e.preventDefault(); nameAp(unnamed); } }, label)
          : el('span', { class: 'rnetname', title: label }, label), meter(avg, 'thin'),
        el('span', { class: 'val', style: `color:${rssiColor(avg)}` }, Math.round(avg))))));
  }
  const actions = el('div', { class: 'ractions' },
    here ? el('button', { class: 'primary', onclick: stopCapture }, 'End room')
      : el('button', { class: 'primary', onclick: () => startCapture(r.id) }, 'Record here'),
    has ? el('button', { onclick: () => { open ? S.open.delete(r.id) : S.open.add(r.id); renderRooms(); } }, open ? 'Hide details' : 'Details') : null,
    el('span', { class: 'spacer' }),
    el('button', { class: 'icon', title: 'Delete room', onclick: () => deleteRoom(r) }, 'Delete'));
  return el('div', { class: `rcard ${here ? 'here' : ''} ${q === 'dead' ? 'dead' : ''} ${open ? 'open' : ''}` },
    head, ...body, actions, open ? roomDetails(r) : null);
}

function renderRoomMatrix() {
  const mode = $('#rmatrix').value, rooms = S.rooms.filter((r) => r.stats.samples);
  if (!rooms.length) return $('#matrix').replaceChildren(el('tr', {}, el('td', { class: 'muted' }, 'Record some rooms to compare them.')));
  const keyOf = (x) => (mode === 'ssid' ? x.ssid : mode === 'ap' ? x.ap : x.bssid);
  const listOf = (st) => (mode === 'ssid' ? st.ssids : mode === 'ap' ? st.aps || [] : st.bssids);
  const cols = new Map();
  for (const r of rooms) {
    for (const x of listOf(r.stats)) {
      const c = cols.get(keyOf(x));
      if (!c || x.avg > c.best) cols.set(keyOf(x), { x, best: Math.max(x.avg, c?.best ?? -999) });
    }
  }
  const shown = [...cols.entries()].sort((a, b) => b[1].best - a[1].best).slice(0, mode === 'ssid' ? 12 : 16);
  const head = el('tr', {}, el('th', {}, 'Room'), ...shown.map(([k, { x }]) => el('th', { title: k },
    mode === 'ssid' ? x.ssid
      : mode === 'ap' ? (x.named ? x.ap : [x.ssid, el('br'), el('span', { class: 'mono muted' }, x.ap)])
        : [apName(x), el('br'), el('span', { class: 'mono muted' }, x.bssid), el('br'),
          el('span', { class: 'muted' }, `ch ${x.channel ?? '?'}${x.band ? ` \u00b7 ${x.band} GHz` : ''}`)])));
  const body = rooms.map((r) => {
    const list = listOf(r.stats);
    const byKey = new Map(list.map((x) => [keyOf(x), x]));
    const best = Math.max(...shown.map(([k]) => byKey.get(k)?.avg ?? -999));
    return el('tr', {}, el('td', {}, el('b', {}, r.name)), ...shown.map(([k]) => {
      const x = byKey.get(k);
      if (!x) return el('td', { class: 'muted' }, '–');
      return el('td', { class: x.avg === best ? 'top' : null, style: `background:${rssiColor(x.avg, 0.22)}` },
        el('b', {}, Math.round(x.avg)), el('span', { class: 'muted' }, ` ${pct(x.seen)}`));
    }));
  });
  $('#matrix').replaceChildren(head, ...body);
}

function roomDetails(r) {
  const st = r.stats;
  const nets = el('table', {}, el('tr', {}, el('th', {}, 'Network'), el('th', {}, 'Avg'), el('th', {}, 'Min'), el('th', {}, 'Seen')),
    ...st.ssids.slice(0, 15).map((s) => el('tr', {}, el('td', {}, s.ssid), cell(s.avg), el('td', {}, dbm(s.min)), el('td', {}, pct(s.seen)))));
  const aps = el('table', {}, el('tr', {}, el('th', {}, 'BSSID'), el('th', {}, 'Network'), el('th', {}, 'Ch'), el('th', {}, 'Band'), el('th', {}, 'Avg'), el('th', {}, 'Seen')),
    ...st.bssids.slice(0, 15).map((b) => el('tr', {}, el('td', { class: 'mono' }, b.bssid), el('td', {}, apName(b)), el('td', {}, b.channel ?? '–'),
      el('td', {}, b.band ? `${b.band} GHz` : '–'), cell(b.avg), el('td', {}, pct(b.seen)))));
  const via = el('table', {}, el('tr', {}, el('th', {}, 'BSSID'), el('th', {}, 'Network'), el('th', {}, 'Ch'), el('th', {}, 'Link avg'), el('th', {}, 'Share')),
    ...(st.conn || []).map((c) => el('tr', {}, el('td', { class: 'mono' }, c.bssid), el('td', {}, c.ssid ?? '–'),
      el('td', {}, c.channel ?? '–'), cell(c.avg), el('td', {}, pct(c.seen)))));
  const caps = el('table', {}, el('tr', {}, el('th', {}, 'Visit started'), el('th', {}, 'Length'), el('th', {})),
    ...r.captures.map((c) => el('tr', {}, el('td', {}, fmtDateTime(c.start_ts)),
      el('td', {}, c.end_ts ? fmtDur(c.end_ts - c.start_ts) : 'running'),
      el('td', {}, el('button', { class: 'danger', onclick: () => deleteCapture(c.id) }, 'Delete')))));
  return el('div', { class: 'subgrid' },
    el('div', {}, el('h3', {}, 'Networks heard'), nets),
    el('div', {}, el('h3', {}, 'Access points'), aps),
    el('div', {}, el('h3', {}, 'Mac connected via'), via),
    el('div', {}, el('h3', {}, 'Segments'), caps));
}

// ---------- walk mode: full-screen view for carrying the laptop around ----------
async function enterWalk() {
  S.walk = true;
  walkKey = '';
  $('#walk').hidden = false;
  document.body.classList.add('walking');
  try {
    await document.documentElement.requestFullscreen();
    S.walkFs = true;
  } catch { S.walkFs = false; }
  once('walk', refreshWalk);
}

function exitWalk() {
  if (!S.walk) return;
  S.walk = false;
  $('#walk').hidden = true;
  document.body.classList.remove('walking');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  TABS[S.tab]();
}

async function refreshWalk() {
  S.walkLive = await api('/api/live?since=120');
  renderWalk();
}

let walkKey = '';
function renderWalk() {
  const st = S.status, L = S.walkLive;
  if (!S.walk || !st || !L) return;
  const rec = st.recording, cap = st.capture, b = $('#wrecord');
  $('#wsession').textContent = st.session?.name ?? '';
  b.classList.toggle('on', !!rec);
  b.textContent = rec ? `\u25a0 Stop  ${fmtClockDur(st.now - rec.start_ts)}` : '\u25cf Record';
  $('#wrecinfo').textContent = rec ? `${rec.samples} scans saved` : 'Not recording';

  const groups = groupNetworks(L.aps);
  let title, now, lines;
  if (!S.target) {
    const c = L.connected, g = groups.find((x) => x.ssid === c.ssid);
    title = `Connected \u00b7 ${c.ssid ?? '(name hidden)'}${c.bssid && S.apNames[c.bssid] ? ` \u00b7 ${S.apNames[c.bssid]}` : ''}`;
    now = st.last?.rssi ?? null;
    lines = [{ color: TH.ink, points: c.points || [], width: 3 },
      ...(g ? g.aps.slice(0, 4).map((a, i) => ({ color: PALETTE[i], points: a.points, width: 1.5 })) : [])];
  } else {
    const g = S.target === '*' ? groups.slice().sort((x, y) => (y.now ?? -999) - (x.now ?? -999))[0] : groups.find((x) => x.ssid === S.target);
    title = g ? (S.target === '*' ? `Strongest \u00b7 ${g.title}` : g.title) : `${S.target} \u00b7 not heard`;
    now = g?.now ?? null;
    lines = g ? g.aps.slice(0, 5).map((a, i) => ({ color: PALETTE[i % PALETTE.length], points: a.points, width: 2 })) : [];
  }
  $('#wtarget').textContent = title;
  $('#wnum').textContent = now == null ? '\u2013' : Math.round(now);
  $('#wnum').style.color = now == null ? '' : rssiColor(now);
  $('#wbadge').replaceChildren(now == null ? el('span', { class: 'muted' }, 'not heard') : badge(quality(now)));
  const c = $('#wchart');
  drawMini(c, c.parentElement.clientWidth, lines, L.t0, L.t1, Math.max(L.interval, L.bucket || 0), 220);
  const top = groups.filter((g) => g.now != null).sort((x, y) => y.now - x.now).slice(0, 6);
  $('#wnets').replaceChildren(...top.map((g) => el('div', { class: 'rnet' },
    el('span', { class: 'rnetname' }, g.title), meter(g.now, 'thin'),
    el('span', { class: 'val', style: `color:${rssiColor(g.now)}` }, Math.round(g.now)))));

  $('#wroom').replaceChildren(...(cap
    ? [el('div', { class: 'wroomname' }, cap.room), el('div', { class: 'muted' }, `${cap.stats.samples} scans \u00b7 ${targetName()} avg ${dbm(targetValue(cap.stats).avg)}`)]
    : [el('div', { class: 'wroomname muted' }, 'No room'), el('div', { class: 'muted' }, rec ? 'Recording without a room' : 'Tap a room to start recording in it')]));
  // Rebuild buttons only when they change, so a tap during a refresh isn't lost.
  const key = JSON.stringify([S.rooms.map((r) => [r.id, r.name]), cap?.room_id ?? null]);
  if (key !== walkKey) {
    walkKey = key;
    $('#wroombtns').replaceChildren(
      ...S.rooms.map((r) => el('button', { class: cap?.room_id === r.id ? 'active' : null,
        onclick: () => (cap?.room_id === r.id ? stopCapture() : startCapture(r.id)) }, r.name)),
      el('button', { class: 'ghost', onclick: quickRoom }, '+ Room'),
      ...(cap ? [el('button', { class: 'endroom', onclick: stopCapture }, 'End room (keep recording)')] : []));
  }
}

// ---------- wiring ----------
const busy = {};
async function once(name, fn) {
  if (busy[name] || S.quit) return;
  busy[name] = true;
  try { await fn(); } catch (e) { if (!S.quit) { console.error(e); toast(e.message); } } finally { busy[name] = false; }
}

async function refreshSsids() {
  const sel = $('#target');
  if (document.activeElement === sel) return;
  const list = await api('/api/ssids');
  const opts = [el('option', { value: '' }, '(connected network)'), el('option', { value: '*' }, '(all networks: strongest per room)'),
    ...list.map((s) => el('option', { value: s.ssid }, s.ssid))];
  if (S.target && S.target !== '*' && !list.some((s) => s.ssid === S.target)) opts.push(el('option', { value: S.target }, S.target));
  sel.replaceChildren(...opts);
  sel.value = S.target;
}

function redrawAll() {
  if (S.tab === 'live' && S.live) renderPanes();
  if (S.tab === 'history') drawChart();
  if (S.tab === 'channels' && S.chan) { drawSpectrum(); renderChannelTable(); }
  if (S.tab === 'rooms') renderRooms();
}

const TABS = {
  live: () => once('live', refreshLive),
  networks: () => once('networks', refreshNetworks),
  history: () => once('history', refreshHistory),
  channels: () => once('channels', refreshChannels),
  rooms: () => once('rooms', refreshRooms),
};

function showTab(tab) {
  S.tab = tab;
  localStorage.setItem('tab', tab);
  $$('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  for (const t of Object.keys(TABS)) $(`#tab-${t}`).hidden = t !== tab;
  TABS[tab]();
}

let tickN = 0;
async function tick() {
  const n = tickN++;
  await once('status', refreshStatus);
  if (S.walk) return once('walk', refreshWalk);
  const capturing = !!S.status?.capture;
  if (S.tab === 'live') once('live', refreshLive);
  if (S.tab === 'networks' && n % 3 === 0) once('networks', refreshNetworks);
  if (S.tab === 'history' && n % 5 === 0 && !S.histWin) once('history', refreshHistory);
  if (S.tab === 'channels' && n % 2 === 0) once('channels', refreshChannels);
  if (S.tab === 'rooms' && (capturing || n % 5 === 0)) once('rooms', refreshRooms);
  if (n % 15 === 0) once('ssids', refreshSsids);
}

function init() {
  $('#dead').value = S.dead;
  $('#duration').value = String(S.duration);
  $('#range').value = localStorage.getItem('range') || '900';
  $('#group').value = localStorage.getItem('group') || 'ssid';
  for (const id of ['lwin', 'lsort', 'lmin', 'nwin', 'cband', 'cwin']) {
    const v = localStorage.getItem(id);
    if (v !== null && [...$(`#${id}`).options].some((o) => o.value === v)) $(`#${id}`).value = v;
    $(`#${id}`).addEventListener('change', (e) => { localStorage.setItem(id, e.target.value); TABS[S.tab](); });
  }

  $$('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('.dlgcancel').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close('cancel')));
  $('#record').addEventListener('click', toggleRecord);
  $('#quit').addEventListener('click', quitApp);
  $('#quickroom').addEventListener('click', quickRoom);
  $('#walkbtn').addEventListener('click', enterWalk);
  $('#wexit').addEventListener('click', exitWalk);
  $('#wrecord').addEventListener('click', toggleRecord);
  $('#rsort').addEventListener('change', renderRooms);
  $('#rview').value = localStorage.getItem('rview') || 'network';
  $('#rview').addEventListener('change', (e) => { localStorage.setItem('rview', e.target.value); renderRooms(); });
  $('#apclear').addEventListener('click', () => $('#apdlg').close('clear'));
  $('#compare').addEventListener('toggle', () => $('#compare').open && renderRoomMatrix());
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || $('#ask').open || $('#apdlg').open || e.metaKey || e.ctrlKey) return;
    if (e.key === 'Escape' && S.walk) exitWalk();
    else if (e.key.toLowerCase() === 'w') (S.walk ? exitWalk : enterWalk)();
  });
  // Esc in full screen is handled by the browser and only exits full screen; leave walk mode with it.
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.walk && S.walkFs) exitWalk(); });
  $('#session').addEventListener('change', (e) => switchSession(e.target.value));
  $('#newsession').addEventListener('click', newSession);
  // Close open menus on outside click or after choosing an item.
  document.addEventListener('click', (e) => {
    for (const d of $$('details.menu[open]')) {
      if (!d.contains(e.target) || e.target.closest('.menuitem')) d.open = false;
    }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { loadTheme(); redrawAll(); });
  $('#theme').value = localStorage.getItem('theme') || '';
  $('#theme').addEventListener('change', (e) => {
    localStorage.setItem('theme', e.target.value);
    applyTheme(e.target.value);
    redrawAll();
  });
  $('#target').addEventListener('change', (e) => { S.target = e.target.value; save(); redrawAll(); once('status', refreshStatus); });
  $('#dead').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (v >= -100 && v <= -40) { S.dead = v; save(); redrawAll(); }
  });
  $('#duration').addEventListener('change', (e) => { S.duration = Number(e.target.value); save(); });
  $('#range').addEventListener('change', (e) => {
    S.histWin = null;
    if (e.target.value !== 'custom') localStorage.setItem('range', e.target.value);
    once('history', refreshHistory);
  });
  $('#group').addEventListener('change', (e) => { localStorage.setItem('group', e.target.value); once('history', refreshHistory); });
  $('#autoselect').addEventListener('click', () => { S.sel[$('#group').value] = null; save(); once('history', refreshHistory); });
  $('#clearsel').addEventListener('click', () => { S.sel[$('#group').value] = []; save(); once('history', refreshHistory); });
  $('#chart').addEventListener('mousemove', onChartMove);
  $('#chart').addEventListener('mouseleave', onChartLeave);
  $('#nshowall').addEventListener('change', () => once('networks', refreshNetworks));
  $('#rmatrix').addEventListener('change', renderRoomMatrix);
  $$('#nets th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    S.nsort = { key: k, dir: S.nsort?.key === k ? -S.nsort.dir : (k === 'name' || k === 'channel' || k === 'band' ? 1 : -1) };
    localStorage.setItem('nsort', JSON.stringify(S.nsort));
    once('networks', refreshNetworks);
  }));
  $('#ruleform').addEventListener('submit', (e) => {
    e.preventDefault();
    addRule($('#rulekind').value, $('#rulevalue').value.trim(), $('#ruleaction').value).then(() => ($('#rulevalue').value = ''));
  });

  $('#addroom').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await post('/api/rooms', { name: $('#roomname').value });
      $('#roomname').value = '';
      await refreshRooms();
    } catch (err) { toast(err.message); }
  });

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redrawAll, 150); });

  once('sessions', refreshSessions);
  once('apnames', refreshApNames);
  once('rooms', refreshRooms);
  showTab(TABS[localStorage.getItem('tab')] ? localStorage.getItem('tab') : 'live');
  tick();
  S.timer = setInterval(tick, 2000);
}

// Runs after live.js and channels.js have loaded.
document.addEventListener('DOMContentLoaded', init);
