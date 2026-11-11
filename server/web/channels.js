'use strict';
// Channels tab: spectrum view per band, 20 MHz channel congestion, and AP channel-change log.

const range = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const BANDS = {
  '2.4': { lo: 2400, hi: 2495, chans: range(1, 13, 1), freq: (n) => (n === 14 ? 2484 : 2407 + 5 * n), pick: [1, 6, 11] },
  5: {
    lo: 5150, hi: 5895, freq: (n) => 5000 + 5 * n,
    chans: [...range(36, 64, 4), ...range(100, 144, 4), ...range(149, 177, 4)],
  },
  // 6 GHz: preferred scanning channels are the usual picks.
  6: { lo: 5925, hi: 7125, chans: range(1, 233, 4), freq: (n) => 5950 + 5 * n, pick: range(5, 229, 16) },
};
const isDFS = (band, ch) => band === '5' && ch >= 52 && ch <= 144;

// Primary channel + width -> centre channel of the bonded block.
function centerChannel(band, ch, width) {
  if (!width || width <= 20) return ch;
  if (band === '2.4') return ch <= 7 ? ch + 2 : ch - 2;
  const base = band === '5' ? (ch >= 149 ? 149 : 36) : 1;
  const block = width / 5;
  return base + Math.floor((ch - base) / block) * block + block / 2 - 2;
}

function apSpan(a) {
  const b = BANDS[a.band], w = a.width || 20;
  const fc = b.freq(centerChannel(a.band, a.channel, w));
  const half = (a.band === '2.4' && w === 20 ? 22 : w) / 2;
  return [fc - half, fc + half, fc];
}

const bandAps = (band) => (S.chan?.aps || []).filter((a) => a.band === band && a.channel && a.avg != null && BANDS[band]);

async function refreshChannels() {
  S.chan = await api(`/api/channels?since=${$('#cwin').value}`);
  if (!S.chanBandPicked) {
    const b = S.status?.last?.band;
    if (b && BANDS[b] && !localStorage.getItem('cband')) $('#cband').value = b;
    S.chanBandPicked = true;
  }
  for (const o of $('#cband').options) o.textContent = `${o.value} GHz (${bandAps(o.value).length} APs)`;
  drawSpectrum();
  renderChannelTable();
  renderChanges();
}

function drawSpectrum() {
  const c = $('#spectrum'), band = $('#cband').value, B = BANDS[band], connB = S.chan?.connected?.bssid;
  const aps = bandAps(band).sort((a, b) => a.avg - b.avg);
  const w = c.parentElement.clientWidth - 12, h = 340, ctx = setupCanvas(c, w, h);
  const L = 44, R = 10, T = 14, Bm = 34, pw = w - L - R, ph = h - T - Bm;
  const X = (f) => L + ((f - B.lo) / (B.hi - B.lo)) * pw;
  const Y = (v) => T + ((YMAX - Math.max(YMIN, Math.min(YMAX, v))) / (YMAX - YMIN)) * ph;

  if (band === '5') {
    ctx.fillStyle = 'rgba(140,90,200,.07)';
    ctx.fillRect(X(B.freq(52) - 10), T, X(B.freq(144) + 10) - X(B.freq(52) - 10), ph);
    ctx.fillStyle = '#8a64c8'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('DFS (radar) channels', X((B.freq(52) + B.freq(144)) / 2), T + 2);
  }
  ctx.strokeStyle = TH.grid; ctx.fillStyle = TH.axis; ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = YMIN; v <= YMAX; v += 10) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
    ctx.fillText(`${v}`, L - 6, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  B.chans.forEach((ch) => {
    const x = Math.round(X(B.freq(ch))) + 0.5, label = String(ch), tw = ctx.measureText(label).width;
    ctx.strokeStyle = TH.grid;
    ctx.beginPath(); ctx.moveTo(x, T + ph); ctx.lineTo(x, T + ph + 4); ctx.stroke();
    if (x - tw / 2 > lastRight + 4) { ctx.fillText(label, x, T + ph + 6); lastRight = x + tw / 2; }
  });
  ctx.fillText(`Channel (${band} GHz)`, L + pw / 2, T + ph + 20);

  if (!aps.length) {
    ctx.fillStyle = TH.axis; ctx.font = '13px system-ui';
    ctx.fillText('No access points seen on this band in this window.', L + pw / 2, T + ph / 2);
    return;
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  for (const a of aps) {
    const [f0, f1] = apSpan(a), ramp = Math.min(4, (f1 - f0) * 0.15), col = seriesColor(a.bssid);
    ctx.beginPath();
    ctx.moveTo(X(f0), Y(YMIN));
    ctx.lineTo(X(f0 + ramp), Y(a.avg));
    ctx.lineTo(X(f1 - ramp), Y(a.avg));
    ctx.lineTo(X(f1), Y(YMIN));
    ctx.globalAlpha = 0.12; ctx.fillStyle = col; ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = a.bssid === connB ? 3 : 1.5; ctx.stroke();
  }
  ctx.font = '11px -apple-system, system-ui, sans-serif'; ctx.textBaseline = 'bottom';
  for (const a of aps) {
    if (a.avg < -90) continue;
    const [, , fc] = apSpan(a);
    ctx.fillStyle = seriesColor(a.bssid);
    ctx.fillText(`${S.apNames[a.bssid] || a.ssid}${a.bssid === connB ? ' \u2605' : ''}`, X(fc), Y(a.avg) - 3);
  }
  ctx.restore();
}

function channelUsage(band) {
  const B = BANDS[band], aps = bandAps(band);
  return B.chans.map((ch) => {
    const f = B.freq(ch);
    const over = aps.filter((a) => { const [f0, f1] = apSpan(a); return f0 < f + 10 && f1 > f - 10; });
    const mw = over.reduce((s, a) => s + 10 ** (a.avg / 10), 0);
    return {
      ch, freq: f, over, primary: aps.filter((a) => a.channel === ch),
      strongest: over.length ? Math.max(...over.map((a) => a.avg)) : null,
      combined: mw ? 10 * Math.log10(mw) : null,
    };
  });
}

function renderChannelTable() {
  const band = $('#cband').value, B = BANDS[band], rows = channelUsage(band), connCh = S.status?.last?.band === band ? S.status.last.channel : null;
  const picks = rows.filter((r) => (B.pick || B.chans).includes(r.ch));
  const score = (r) => r.combined ?? -200;
  const best = (list) => list.reduce((a, b) => (score(b) < score(a) ? b : a), list[0]);
  const describe = (r) => `ch ${r.ch}${isDFS(band, r.ch) ? ' (DFS)' : ''} (${r.over.length ? `${r.over.length} overlapping, ${dbm(r.combined)} combined` : 'no overlapping APs'})`;
  const parts = [`Least congested: ${describe(best(picks))}`];
  if (band === '5') parts.push(`best non-DFS: ${describe(best(picks.filter((r) => !isDFS(band, r.ch))))}`);
  if (band === '6') parts.push('(PSC channels)');
  $('#cbest').textContent = parts.join(' \u00b7 ');

  const head = el('tr', {}, ...['Ch', 'MHz', 'APs on channel', 'Overlapping', 'Strongest', 'Combined', 'Networks on channel'].map((t) => el('th', {}, t)));
  $('#chantable').replaceChildren(head, ...rows.filter((r) => r.over.length || r.ch === connCh).map((r) => el('tr', { class: r.ch === connCh ? 'connected' : null },
    el('td', {}, el('b', {}, r.ch), isDFS(band, r.ch) ? el('span', { class: 'muted' }, ' DFS') : null),
    el('td', {}, r.freq), el('td', {}, r.primary.length), el('td', {}, r.over.length),
    cell(r.strongest), el('td', {}, dbm(r.combined)),
    el('td', { class: 'wrap' }, uniq(r.primary.map((a) => a.ssid)).join(', ') || '\u2013'))));
}

function renderChanges() {
  const ch = S.chan?.changes || [];
  const fmt = (c, b, w) => `${c ?? '?'}${b ? ` (${b} GHz${w ? `, ${w} MHz` : ''})` : ''}`;
  $('#chchanges').replaceChildren(el('tr', {}, ...['When', 'SSID', 'BSSID', 'From', 'To'].map((t) => el('th', {}, t))),
    ...(ch.length
      ? ch.map((c) => el('tr', {}, el('td', {}, fmtDateTime(c.ts)), el('td', {}, c.ssid ?? '(unknown)'), el('td', { class: 'mono' }, c.bssid),
        el('td', {}, fmt(c.old_channel, c.old_band, c.old_width)), el('td', {}, fmt(c.new_channel, c.new_band, c.new_width))))
      : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'No access point has changed channel since the app started tracking.'))]));
}
