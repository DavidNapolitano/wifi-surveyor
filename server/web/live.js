'use strict';
// Live tab: one signal-over-time pane per network (one line per access point).
// Networks tab: every AP seen, with include/exclude rules.

const panes = new Map();

async function refreshLive() {
  S.live = await api(`/api/live?since=${$('#lwin').value}`);
  renderPanes();
}

// Hidden radios that share a router with a visible network are grouped under that network;
// other hidden radios are grouped per physical AP (related BSSIDs or a shared nickname), never all together.
function groupNetworks(aps) {
  const groups = new Map(), clusters = [];
  for (const a of aps) {
    if (a.ssid === '(hidden)' && !a.alias) {
      const nick = S.apNames[a.bssid];
      let c = clusters.find((c) => c.some((b) => relatedBssid(a.bssid, b.bssid) || (nick && S.apNames[b.bssid] === nick)));
      if (!c) clusters.push((c = []));
      c.push(a);
      continue;
    }
    const key = a.ssid === '(hidden)' ? a.alias : a.ssid;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const make = (key, title, list, hidden) => {
    const live = list.some((a) => a.included !== false) ? list.filter((a) => a.included !== false) : list;
    const nows = live.map((a) => a.now).filter((v) => v != null);
    const avgs = live.map((a) => a.avg).filter((v) => v != null);
    return {
      key, title, ssid: hidden ? '(hidden)' : key, aps: list, hidden, unknown: key === '(unknown)',
      now: nows.length ? Math.max(...nows) : null, best: avgs.length ? Math.max(...avgs) : null,
      seen: Math.max(...live.map((a) => a.seen || 0)),
    };
  };
  return [
    ...[...groups.entries()].map(([ssid, list]) => make(ssid, ssid, list, false)),
    ...clusters.map((c) => {
      const first = c.map((a) => a.bssid).sort()[0], nick = c.map((a) => S.apNames[a.bssid]).find(Boolean);
      return make(`\u0001hidden ${first}`, nick || first, c, true);
    }),
  ];
}

const uniq = (xs) => [...new Set(xs.filter((x) => x != null))];
const ssidValue = (name) => (name === '(hidden)' || name === '(unknown)' ? '' : name);

// Exclude rules that hide a network group: its SSID plus any hidden radios grouped under it.
function hideRulesFor(g) {
  if (g.unknown) return [];
  const rules = g.hidden ? [] : [{ kind: 'ssid', value: g.ssid, action: 'exclude' }];
  for (const a of g.aps) if (a.ssid === '(hidden)') rules.push({ kind: 'bssid', value: a.bssid, action: 'exclude' });
  return rules;
}

async function applyRules(rules, message) {
  try {
    for (const r of rules) await post('/api/filters', r);
    if (message) toast(message);
  } catch (e) { toast(e.message); }
  TABS[S.tab]();
}

const hideGroup = (g) => applyRules(hideRulesFor(g), `Hid "${g.title}". Undo on the Networks tab.`);
const hideAp = (a) => applyRules([{ kind: 'bssid', value: a.bssid, action: 'exclude' }], `Hid ${a.bssid}. Undo on the Networks tab.`);

// Strongest-first, but a pane only overtakes the one above it once it is clearly stronger,
// so networks with similar signal don't keep swapping places.
const SORT_MARGIN = 3;
let liveOrder = [];
function stableStrongest(groups) {
  const v = (g) => g.best ?? -999, rank = new Map(liveOrder.map((k, i) => [k, i]));
  const list = groups.slice().sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity) || v(b) - v(a));
  for (let i = 1; i < list.length; i++) {
    for (let j = i; j > 0 && v(list[j]) > v(list[j - 1]) + SORT_MARGIN; j--) [list[j - 1], list[j]] = [list[j], list[j - 1]];
  }
  liveOrder = list.map((g) => g.key);
  return list;
}

function renderPanes() {
  const L = S.live, minV = Number($('#lmin').value);
  const all = groupNetworks(L.aps).filter((g) => !minV || (g.best ?? -999) >= minV);
  const groups = $('#lsort').value === 'name' ? all.sort((a, b) => a.title.localeCompare(b.title)) : stableStrongest(all);

  const items = [];
  const c = L.connected;
  if (c.points?.length) {
    const last = c.points[c.points.length - 1][1];
    items.push({
      key: '\u0000connected', title: `Connected link \u00b7 ${c.ssid ?? '(name hidden)'}`, now: last,
      sub: `${c.bssid ?? ''} \u00b7 updates every scan`, cls: 'conn',
      lines: [{ color: TH.ink, points: c.points, width: 2.5 }], legend: [],
    });
  }
  for (const g of groups) {
    const lines = g.aps.map((a, i) => ({ color: PALETTE[i % PALETTE.length], points: a.points, width: 1.8, ap: a }));
    items.push({
      key: g.key, title: g.title, now: g.now,
      hide: hideRulesFor(g).length ? () => hideGroup(g) : null,
      sub: `${g.hidden ? 'Hidden network \u00b7 ' : ''}${g.aps.length} AP${g.aps.length > 1 ? 's' : ''} \u00b7 ${uniq(g.aps.map((a) => a.band)).map((b) => `${b} GHz`).join(', ') || '?'}`
        + ` \u00b7 ch ${uniq(g.aps.map((a) => a.channel)).join(', ')}`,
      lines,
      legend: lines.map((l) => el('div', { class: 'apline' }, swatch(l.color),
        S.apNames[l.ap.bssid] ? el('b', { class: 'nick' }, `${S.apNames[l.ap.bssid]} `) : null,
        el('span', { class: 'mono' }, l.ap.bssid),
        l.ap.ssid === '(hidden)' && !g.hidden ? el('span', { class: 'tag' }, 'hidden radio') : null,
        ` ch ${l.ap.channel ?? '?'}${l.ap.band ? ` \u00b7 ${l.ap.band} GHz` : ''}${l.ap.width ? ` \u00b7 ${l.ap.width} MHz` : ''} \u00b7 ${phyLabel(l.ap.phy, l.ap.band)} \u00b7 `,
        el('span', { class: 'val', style: l.ap.now == null ? null : `color:${rssiColor(l.ap.now)}` }, l.ap.now == null ? 'gone' : dbm(l.ap.now)),
        l.ap.bssid !== '(redacted)' ? el('button', { class: 'icon', title: 'Hide this access point', onclick: () => hideAp(l.ap) }, '\u00d7') : null)),
    });
  }

  // Move panes only when the order changed; re-appending them all makes the page lose its scroll position.
  const box = $('#panes'), seen = new Set();
  let at = box.firstElementChild;
  for (const it of items) {
    let p = panes.get(it.key);
    if (!p) panes.set(it.key, (p = makePane()));
    seen.add(it.key);
    if (p.root === at) at = at.nextElementSibling;
    else box.insertBefore(p.root, at);
    fillPane(p, it, L.t0, L.t1, Math.max(L.interval, L.bucket || 0));
  }
  for (const [k, p] of panes) if (!seen.has(k)) { p.root.remove(); panes.delete(k); }
  $('#liveempty').hidden = items.length > 0;
}

function makePane() {
  const title = el('span', { class: 'ptitle' }), now = el('span', { class: 'pnow' });
  const hide = el('button', { class: 'icon', title: 'Hide this network everywhere' }, 'Hide');
  const sub = el('div', { class: 'psub' }), canvas = el('canvas'), legend = el('div', { class: 'plegend' });
  return {
    root: el('div', { class: 'pane' }, el('div', { class: 'phead' }, title, now, hide), sub, canvas, legend),
    title, now, hide, sub, canvas, legend,
  };
}

function fillPane(p, it, t0, t1, interval) {
  p.root.className = `pane ${it.cls || ''}`;
  p.title.textContent = it.title;
  p.hide.hidden = !it.hide;
  p.hide.onclick = it.hide;
  p.now.replaceChildren(...(it.now == null
    ? [el('span', { class: 'muted' }, 'not in last scan')]
    : [el('span', { class: 'val', style: `color:${rssiColor(it.now)}` }, dbm(it.now)), ' ', badge(quality(it.now))]));
  p.sub.textContent = it.sub;
  drawMini(p.canvas, p.root.clientWidth - 22, it.lines, t0, t1, interval);
  p.legend.replaceChildren(...it.legend);
}

function drawMini(c, w, lines, t0, t1, interval, h = 140) {
  const ctx = setupCanvas(c, w, h);
  const L = 32, R = 6, T = 6, B = 16, pw = w - L - R, ph = h - T - B;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * pw;
  const Y = (v) => T + ((YMAX - Math.max(YMIN, Math.min(YMAX, v))) / (YMAX - YMIN)) * ph;
  ctx.fillStyle = 'rgba(46,160,67,.08)';
  ctx.fillRect(L, Y(YMAX), pw, Y(-67) - Y(YMAX));
  ctx.fillStyle = 'rgba(220,40,40,.09)';
  ctx.fillRect(L, Y(S.dead), pw, Y(YMIN) - Y(S.dead));
  ctx.strokeStyle = TH.grid; ctx.fillStyle = TH.axis; ctx.lineWidth = 1;
  ctx.font = '10px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = -90; v <= -30; v += 20) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
    ctx.fillText(`${v}`, L - 4, y);
  }
  ctx.textBaseline = 'top';
  const span = t1 - t0;
  ctx.textAlign = 'left'; ctx.fillText(span < 90 ? `${Math.round(span)} sec ago` : `${Math.round(span / 60)} min ago`, L, T + ph + 3);
  ctx.textAlign = 'right'; ctx.fillText('now', L + pw, T + ph + 3);

  const gap = Math.max(3 * interval, 10);
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  for (const l of lines) {
    ctx.strokeStyle = l.color; ctx.fillStyle = l.color; ctx.lineWidth = l.width;
    ctx.beginPath();
    let prev = null;
    for (const [t, v] of l.points) {
      if (v == null) { prev = null; continue; }
      if (prev === null || t - prev > gap) ctx.moveTo(X(t), Y(v)); else ctx.lineTo(X(t), Y(v));
      prev = t;
    }
    ctx.stroke();
    const last = l.points[l.points.length - 1];
    if (last && last[1] != null) { ctx.beginPath(); ctx.arc(X(last[0]), Y(last[1]), 2.5, 0, 2 * Math.PI); ctx.fill(); }
  }
  ctx.restore();
}

// ---------- Networks tab ----------
async function refreshNetworks() {
  const [data, rules] = await Promise.all([api(`/api/live?since=${$('#nwin').value}&all=1&points=0`), api('/api/filters')]);
  S.rules = rules;
  S.netData = data;
  renderRules();
  renderNetTable();
}

async function addRule(kind, value, action) {
  if (value == null) return;
  try {
    await post('/api/filters', { kind, value, action });
    await refreshNetworks();
  } catch (e) { toast(e.message); }
}

async function deleteRules(ids) {
  try {
    for (const id of ids) await del(`/api/filters/${id}`);
    await refreshNetworks();
  } catch (e) { toast(e.message); }
}
const deleteRule = (id) => deleteRules([id]);

const ruleLabel = (r) => (r.kind === 'ssid' && r.value === '' ? '(hidden networks)' : r.value);

function renderRules() {
  $('#rules').replaceChildren(...(S.rules.length
    ? [el('span', { class: 'muted' }, 'Active rules:'), ...S.rules.map((r) => el('span', { class: `chip rule-${r.action}` },
      `${r.action === 'include' ? 'Track' : 'Hide'} ${r.kind === 'ssid' ? 'network' : 'AP'} `, el('b', {}, ruleLabel(r)), ' ',
      el('button', { class: 'x', title: 'Remove rule', onclick: () => deleteRule(r.id) }, '\u00d7')))]
    : [el('span', { class: 'muted' }, 'No rules: every network is collected and shown.')]));
}

const ruleMatch = (r, kind, value) => r.kind === kind && r.value === value;

const SORTS = {
  name: [(g) => g.title.toLowerCase(), (a) => a.bssid],
  band: [(g) => Math.min(...g.aps.map((a) => parseFloat(a.band) || 99)), (a) => parseFloat(a.band) || 99],
  channel: [(g) => Math.min(...g.aps.map((a) => a.channel ?? 999)), (a) => a.channel ?? 999],
  now: [(g) => g.now ?? -999, (a) => a.now ?? -999],
  avg: [(g) => g.best ?? -999, (a) => a.avg ?? -999],
  seen: [(g) => g.seen, (a) => a.seen],
};

function renderNetTable() {
  const data = S.netData, showAll = $('#nshowall').checked, connB = S.status?.last?.bssid;
  const { key, dir } = S.nsort, [gKey, aKey] = SORTS[key] || SORTS.avg;
  const by = (f) => (x, y) => { const a = f(x), b = f(y); return (a < b ? -1 : a > b ? 1 : 0) * dir; };
  $$('#nets th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === key));
  const vals = uniq([...data.aps.map((a) => a.ssid), ...data.aps.map((a) => a.bssid)]).filter((v) => !v.startsWith('('));
  $('#rulevals').replaceChildren(...vals.map((v) => el('option', { value: v })));

  const anyTracked = S.rules.some((r) => r.action === 'include');
  const groups = groupNetworks(data.aps);
  const category = (g) => {
    const v = g.hidden ? '' : g.ssid;
    if (S.rules.some((r) => r.action === 'exclude' && ruleMatch(r, 'ssid', v))) return 'hidden';
    if (S.rules.some((r) => r.action === 'include' && ruleMatch(r, 'ssid', v))) return 'tracked';
    if (g.aps.every((a) => !a.included)) return anyTracked ? 'untracked' : 'hidden';
    return 'other';
  };
  const cats = [
    ['tracked', '\u2605 Your networks'],
    ['other', anyTracked ? 'Also included (tracked access points)' : 'Networks'],
    ['untracked', 'Not tracked'],
    ['hidden', 'Hidden by you'],
  ];
  const ncols = $$('#nets thead th').length;
  const rows = [];
  for (const [cat, title] of cats) {
    const list = groups.filter((g) => category(g) === cat).sort(by(gKey));
    if (!list.length || (!showAll && (cat === 'hidden' || cat === 'untracked'))) continue;
    rows.push(el('tr', { class: 'cat' }, el('td', { colspan: ncols }, `${title} \u00b7 ${list.length}`)));
    for (const g of list) rows.push(netRow(g, cat), ...g.aps.slice().sort(by(aKey)).map((a) => apRow(a, g, connB)));
  }
  if (!rows.length) rows.push(el('tr', {}, el('td', { colspan: ncols, class: 'muted' }, 'No networks in this window.')));
  $('#nets tbody').replaceChildren(...rows);
}

function netRow(g, cat) {
  const v = g.hidden ? '' : g.ssid;
  const track = S.rules.find((r) => r.action === 'include' && ruleMatch(r, 'ssid', v));
  const hideRules = S.rules.filter((r) => r.action === 'exclude'
    && (ruleMatch(r, 'ssid', v) || g.aps.some((a) => a.ssid === '(hidden)' && ruleMatch(r, 'bssid', a.bssid))));
  const star = el('button', {
    class: `star ${track ? 'on' : ''}`, disabled: g.hidden || g.unknown,
    title: track ? 'Stop tracking' : 'Track: collect and show only tracked networks',
    onclick: () => (track ? deleteRule(track.id) : addRule('ssid', v, 'include')),
  }, track ? '\u2605' : '\u2606');
  const action = cat === 'hidden'
    ? el('button', { class: 'small', onclick: () => deleteRules(hideRules.map((r) => r.id)) }, 'Unhide')
    : el('button', { class: 'small', disabled: !hideRulesFor(g).length, onclick: () => hideGroup(g) }, 'Hide');
  const bands = uniq(g.aps.map((a) => a.band)).map((b) => `${b}`).join(' / ');
  return el('tr', { class: `net ${cat === 'hidden' || cat === 'untracked' ? 'excluded' : ''}` },
    el('td', {}, star, el('b', { class: 'netname' }, g.title), g.hidden ? el('span', { class: 'tag' }, 'hidden network') : null, action,
      el('span', { class: 'muted' }, ` ${g.aps.length} AP${g.aps.length > 1 ? 's' : ''}`)),
    el('td', {}, bands ? `${bands} GHz` : '\u2013'), el('td', {}, uniq(g.aps.map((a) => a.channel)).join(', ')),
    el('td'), el('td'), cell(g.now), cell(g.best), el('td'), el('td'), el('td', {}, pct(g.seen)),
    el('td', {}, cat === 'hidden' || cat === 'untracked' ? '' : badge(quality(g.best, g.seen))));
}

function apRow(a, g, connB) {
  const rule = S.rules.find((r) => r.action === 'exclude' && ruleMatch(r, 'bssid', a.bssid));
  const btn = a.bssid === '(redacted)' ? null : rule
    ? el('button', { class: 'small', onclick: () => deleteRule(rule.id) }, 'Unhide AP')
    : el('button', { class: 'small', disabled: !a.included, onclick: () => hideAp(a) }, 'Hide AP');
  const connected = connB && connB === a.bssid;
  return el('tr', { class: `ap ${a.included ? '' : 'excluded'} ${connected ? 'connected' : ''}` },
    el('td', {}, S.apNames[a.bssid] ? el('b', { class: 'nick' }, `${S.apNames[a.bssid]} `) : null,
      el('span', { class: 'mono' }, a.bssid),
      a.bssid === '(redacted)' ? null : el('button', { class: 'small', title: 'Give this access point a name', onclick: () => nameAp(a.bssid) },
        S.apNames[a.bssid] ? 'Rename' : 'Name'),
      btn,
      a.ssid === '(hidden)' && !g.hidden ? el('span', { class: 'tag' }, 'hidden radio') : null,
      connected ? el('span', { class: 'tag conn' }, 'connected') : null),
    el('td', {}, a.band ? `${a.band} GHz` : '\u2013'), el('td', {}, a.channel ?? '\u2013'),
    el('td', {}, a.width ? `${a.width} MHz` : '\u2013'), el('td', {}, phyLabel(a.phy, a.band)),
    cell(a.now), cell(a.avg), el('td', {}, dbm(a.min)), el('td', {}, dbm(a.max)), el('td', {}, pct(a.seen)),
    el('td', {}, a.included ? badge(quality(a.avg, a.seen)) : el('span', { class: 'muted' }, 'hidden')));
}
