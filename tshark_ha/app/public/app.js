'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_TABLE_ROWS = 2000;   // keep DOM lean

// Works correctly both direct (http://addon:8099/) and behind HA ingress
// (/api/hassio_ingress/<token>/) by using the page's own pathname as base.
const BASE_URL = (() => {
  const p = location.pathname;
  return p.endsWith('/') ? p : p + '/';
})();
const PROTO_COLORS = {
  HTTP:    '#06b6d4',
  'HTTP/2':'#0891b2',
  TLS:     '#a855f7',
  DNS:     '#f59e0b',
  DHCP:    '#84cc16',
  TCP:     '#3b82f6',
  UDP:     '#10b981',
  ICMP:    '#f97316',
  ICMPv6:  '#fb923c',
  ARP:     '#ec4899',
  IPv6:    '#8b5cf6',
  IP:      '#6366f1',
  OTHER:   '#64748b',
};

// ── State ─────────────────────────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;
let isCapturing = false;
let sessionStartTime = null;
let durationTimer = null;
let allPackets = [];          // local mirror of ring buffer
let filteredIds = null;       // Set of IDs when search active, null = no filter
let selectedPacketId = null;
let chartProto = null;
let chartTimeline = null;
let lastStats = {};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const btnToggle       = $('btn-toggle');
const btnLabel        = $('btn-label');
const btnClear        = $('btn-clear');
const ctrlInterface   = $('ctrl-interface');
const ctrlFilter      = $('ctrl-filter');
const ctrlDFilter     = $('ctrl-dfilter');
const statusDot       = $('status-dot');
const statusLabel     = $('status-label');
const svTotal         = $('sv-total');
const svPps           = $('sv-pps');
const svBps           = $('sv-bps');
const svBytes         = $('sv-bytes');
const svDuration      = $('sv-duration');
const badgeProtos     = $('badge-protocols');
const badgeConvs      = $('badge-convs');
const packetTbody     = $('packet-tbody');
const emptyState      = $('empty-state');
const tableContainer  = $('table-container');
const searchInput     = $('search-input');
const chkAutoscroll   = $('chk-autoscroll');
const detailDrawer    = $('detail-drawer');
const drawerOverlay   = $('drawer-overlay');
const drawerTitle     = $('drawer-title');
const drawerContent   = $('drawer-content');
const btnCloseDrawer  = $('btn-close-drawer');
const convList        = $('conv-list');
const toastsEl        = $('toasts');

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  loadInterfaces();
  connectWS();
  bindEvents();
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${BASE_URL}ws`);

  ws.addEventListener('open', () => {
    console.log('[ws] connected');
    clearTimeout(wsReconnectTimer);
  });

  ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case 'snapshot':    handleSnapshot(msg);     break;
      case 'packet':      handlePacket(msg.packet); break;
      case 'stats':       handleStats(msg.stats);   break;
      case 'captureState': handleCaptureState(msg); break;
    }
  });

  ws.addEventListener('close', () => {
    console.log('[ws] disconnected – reconnecting in 3s');
    wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => ws.close());
}

// ── Message handlers ──────────────────────────────────────────────────────────
function handleSnapshot(msg) {
  // Hydrate local state from server snapshot
  allPackets = msg.packets || [];
  lastStats  = msg.stats   || {};
  setCapturingUI(msg.isCapturing);
  if (msg.sessionStartTime) sessionStartTime = msg.sessionStartTime;
  if (msg.config) {
    if (msg.config.captureFilter) ctrlFilter.value = msg.config.captureFilter;
    if (msg.config.interface)     setInterfaceOption(msg.config.interface);
  }
  rebuildTable();
  renderStats(lastStats);
  renderConversations(lastStats.conversations || {});
  updateCharts(lastStats);
  updateEmptyState();
  if (msg.isCapturing) startDurationTimer();
}

function handlePacket(pkt) {
  allPackets.push(pkt);
  if (allPackets.length > MAX_TABLE_ROWS) allPackets.shift();

  if (passesSearch(pkt)) {
    appendTableRow(pkt);
    if (chkAutoscroll.checked) scrollTableToBottom();
  }
  updateEmptyState();
}

function handleStats(stats) {
  lastStats = stats;
  renderStats(stats);
  renderConversations(stats.conversations || {});
  updateCharts(stats);
}

function handleCaptureState(msg) {
  setCapturingUI(msg.isCapturing);
  if (msg.isCapturing) {
    if (msg.sessionStartTime) sessionStartTime = msg.sessionStartTime;
    startDurationTimer();
    toast('Capture started', 'success');
  } else {
    stopDurationTimer();
    toast('Capture stopped');
  }
}

// ── Capture control ───────────────────────────────────────────────────────────
async function toggleCapture() {
  btnToggle.disabled = true;
  try {
    if (!isCapturing) {
      const body = {
        interface:     ctrlInterface.value,
        captureFilter: ctrlFilter.value.trim(),
        displayFilter: ctrlDFilter.value.trim(),
      };
      const r = await fetch(BASE_URL + 'api/capture/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json();
        toast(err.error || 'Failed to start capture', 'error');
      }
    } else {
      await fetch(BASE_URL + 'api/capture/stop', { method: 'POST' });
    }
  } catch (e) {
    toast('Connection error: ' + e.message, 'error');
  } finally {
    btnToggle.disabled = false;
  }
}

function setCapturingUI(capturing) {
  isCapturing = capturing;
  if (capturing) {
    btnToggle.classList.replace('btn-start', 'btn-stop');
    btnToggle.querySelector('.btn-icon').textContent = '■';
    btnLabel.textContent = 'Stop Capture';
    statusDot.classList.add('active');
    statusLabel.textContent = 'Capturing';
    ctrlInterface.disabled = true;
    ctrlFilter.disabled    = true;
    ctrlDFilter.disabled   = true;
  } else {
    btnToggle.classList.replace('btn-stop', 'btn-start');
    btnToggle.querySelector('.btn-icon').textContent = '▶';
    btnLabel.textContent = 'Start Capture';
    statusDot.classList.remove('active');
    statusLabel.textContent = 'Idle';
    ctrlInterface.disabled = false;
    ctrlFilter.disabled    = false;
    ctrlDFilter.disabled   = false;
  }
}

// ── Duration timer ─────────────────────────────────────────────────────────────
function startDurationTimer() {
  stopDurationTimer();
  durationTimer = setInterval(() => {
    if (!sessionStartTime) return;
    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    svDuration.textContent = h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

function stopDurationTimer() {
  clearInterval(durationTimer);
  durationTimer = null;
  svDuration.textContent = '--:--';
}

// ── Stats rendering ───────────────────────────────────────────────────────────
function renderStats(stats) {
  setStatVal(svTotal,    fmtNum(stats.totalPackets));
  setStatVal(svPps,      fmtNum(stats.packetsPerSec));
  setStatVal(svBps,      fmtBytes(stats.bytesPerSec) + '/s');
  setStatVal(svBytes,    fmtBytes(stats.totalBytes));
  badgeProtos.textContent = `${Object.keys(stats.protocols || {}).length} protocols`;
}

function setStatVal(el, val) {
  if (el.textContent !== val) {
    el.textContent = val;
    el.classList.remove('flash');
    // Trigger reflow to restart animation
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

// ── Conversations ─────────────────────────────────────────────────────────────
function renderConversations(convs) {
  const entries = Object.values(convs)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 15);

  badgeConvs.textContent = String(Object.keys(convs).length);

  if (!entries.length) {
    convList.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:0.78rem;text-align:center">No conversations yet</div>';
    return;
  }

  const maxBytes = entries[0].bytes;
  convList.innerHTML = entries.map(c => {
    const pct = maxBytes > 0 ? Math.round((c.bytes / maxBytes) * 100) : 0;
    return `
      <div class="conv-item">
        <div class="conv-hosts">${esc(c.src)} ↔ ${esc(c.dst)}</div>
        <div class="conv-meta">
          <div class="conv-bytes">${fmtBytes(c.bytes)}</div>
          <div class="conv-pkts">${fmtNum(c.packets)} pkts</div>
        </div>
        <div class="conv-bar-wrap"><div class="conv-bar" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
}

// ── Charts ────────────────────────────────────────────────────────────────────
function initCharts() {
  Chart.defaults.color = '#64748b';
  Chart.defaults.borderColor = 'rgba(99,120,180,0.1)';

  // Protocol donut
  chartProto = new Chart($('chart-protocols'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 0, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 10, padding: 10, font: { size: 11, family: 'Inter' } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total ? Math.round(ctx.raw / total * 100) : 0;
              return ` ${ctx.label}: ${fmtNum(ctx.raw)} (${pct}%)`;
            },
          },
        },
      },
    },
  });

  // Bandwidth timeline
  chartTimeline = new Chart($('chart-timeline'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Bytes/s',
          data: [],
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6,182,212,0.08)',
          borderWidth: 1.5,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          yAxisID: 'yBytes',
        },
        {
          label: 'Pkts/s',
          data: [],
          borderColor: '#7c3aed',
          backgroundColor: 'rgba(124,58,237,0.06)',
          borderWidth: 1.5,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          yAxisID: 'yPkts',
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { display: false },
        yBytes: {
          position: 'left',
          ticks: { callback: v => fmtBytes(v), font: { size: 10 }, maxTicksLimit: 4 },
          grid: { color: 'rgba(99,120,180,0.08)' },
        },
        yPkts: {
          position: 'right',
          ticks: { font: { size: 10 }, maxTicksLimit: 4 },
          grid: { display: false },
        },
      },
      plugins: {
        legend: { labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.datasetIndex === 0
              ? ` Bytes/s: ${fmtBytes(ctx.raw)}`
              : ` Pkts/s: ${fmtNum(ctx.raw)}`,
          },
        },
      },
    },
  });
}

function updateCharts(stats) {
  // Protocol chart
  const protos = stats.protocols || {};
  const sorted = Object.entries(protos).sort((a, b) => b[1] - a[1]);
  chartProto.data.labels            = sorted.map(([k]) => k);
  chartProto.data.datasets[0].data  = sorted.map(([, v]) => v);
  chartProto.data.datasets[0].backgroundColor = sorted.map(([k]) => PROTO_COLORS[k] || PROTO_COLORS.OTHER);
  chartProto.update('none');

  // Timeline chart
  const tl = stats.timeline || [];
  chartTimeline.data.labels               = tl.map((_, i) => i);
  chartTimeline.data.datasets[0].data     = tl.map(t => t.bytes);
  chartTimeline.data.datasets[1].data     = tl.map(t => t.packets);
  chartTimeline.update('none');
}

// ── Packet Table ──────────────────────────────────────────────────────────────
function rebuildTable() {
  packetTbody.innerHTML = '';
  const toRender = searchInput.value.trim()
    ? allPackets.filter(passesSearch)
    : allPackets;

  // Only render last MAX_TABLE_ROWS to keep DOM lean
  const start = Math.max(0, toRender.length - MAX_TABLE_ROWS);
  for (let i = start; i < toRender.length; i++) {
    packetTbody.appendChild(buildRow(toRender[i]));
  }
  if (chkAutoscroll.checked) scrollTableToBottom();
  updateEmptyState();
}

function appendTableRow(pkt) {
  // Prune oldest rows if DOM is getting heavy
  while (packetTbody.children.length >= MAX_TABLE_ROWS) {
    packetTbody.removeChild(packetTbody.firstChild);
  }
  packetTbody.appendChild(buildRow(pkt));
}

function buildRow(pkt) {
  const tr = document.createElement('tr');
  tr.dataset.id    = pkt.id;
  tr.dataset.proto = pkt.protocol;

  const timeStr = formatTime(pkt.time);
  tr.innerHTML = `
    <td>${pkt.id}</td>
    <td>${esc(timeStr)}</td>
    <td title="${esc(pkt.src)}">${esc(truncate(pkt.src, 20))}</td>
    <td title="${esc(pkt.dst)}">${esc(truncate(pkt.dst, 20))}</td>
    <td><span class="proto-badge ${sanitizeClass(pkt.protocol)}">${esc(pkt.protocol)}</span></td>
    <td>${pkt.length}</td>
    <td title="${esc(pkt.info)}">${esc(truncate(pkt.info, 80))}</td>
  `;

  if (pkt.id === selectedPacketId) tr.classList.add('selected');

  tr.addEventListener('click', () => openDrawer(pkt.id));
  return tr;
}

function scrollTableToBottom() {
  tableContainer.scrollTop = tableContainer.scrollHeight;
}

function updateEmptyState() {
  const hasRows = packetTbody.children.length > 0;
  emptyState.classList.toggle('hidden', hasRows);
}

// ── Search / filter ───────────────────────────────────────────────────────────
let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(rebuildTable, 250);
});

function passesSearch(pkt) {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return true;
  return (
    pkt.src.toLowerCase().includes(q) ||
    pkt.dst.toLowerCase().includes(q) ||
    pkt.info.toLowerCase().includes(q) ||
    pkt.protocol.toLowerCase().includes(q)
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────────
function openDrawer(packetId) {
  const pkt = allPackets.find(p => p.id === packetId);
  if (!pkt) return;

  selectedPacketId = packetId;
  // Highlight row
  document.querySelectorAll('#packet-tbody tr').forEach(tr => {
    tr.classList.toggle('selected', parseInt(tr.dataset.id) === packetId);
  });

  drawerTitle.textContent = `Packet #${pkt.id} – ${pkt.protocol}`;
  drawerContent.innerHTML = buildDrawerContent(pkt);
  detailDrawer.classList.add('open');
  drawerOverlay.classList.add('open');
}

function closeDrawer() {
  detailDrawer.classList.remove('open');
  drawerOverlay.classList.remove('open');
  selectedPacketId = null;
  document.querySelectorAll('#packet-tbody tr.selected').forEach(tr => tr.classList.remove('selected'));
}

function buildDrawerContent(pkt) {
  const layers = pkt.raw?._source?.layers || {};

  const summaryFields = [
    ['Packet #',    pkt.id],
    ['Protocol',    pkt.protocol],
    ['Time',        formatTime(pkt.time)],
    ['Relative',    `${parseFloat(pkt.timeRelative).toFixed(6)} s`],
    ['Source',      pkt.src],
    ['Destination', pkt.dst],
    ['Length',      `${pkt.length} bytes`],
    ['Info',        pkt.info],
  ];

  const summaryHtml = `
    <div class="pkt-summary">
      ${summaryFields.map(([label, val]) => `
        <div class="pkt-field">
          <div class="pkt-field-label">${esc(label)}</div>
          <div class="pkt-field-value">${esc(String(val))}</div>
        </div>
      `).join('')}
    </div>`;

  // Layer breakdown
  const layerOrder = ['frame','eth','ip','ipv6','tcp','udp','icmp','icmpv6','arp','dns','http','http2','tls','dhcp'];
  const renderedLayers = new Set();
  let layersHtml = '';

  for (const name of layerOrder) {
    if (layers[name]) {
      layersHtml += renderLayerSection(name.toUpperCase(), layers[name]);
      renderedLayers.add(name);
    }
  }
  // Remaining unknown layers
  for (const [name, data] of Object.entries(layers)) {
    if (!renderedLayers.has(name)) {
      layersHtml += renderLayerSection(name.toUpperCase(), data);
    }
  }

  return summaryHtml + (layersHtml
    ? `<div class="json-section"><div class="json-section-head">Layer Detail</div>${layersHtml}</div>`
    : '');
}

function renderLayerSection(title, obj) {
  if (!obj || typeof obj !== 'object') return '';
  const rows = Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const valStr = Array.isArray(v) ? v.join(', ') : String(v);
      return `<div><span class="json-key">${esc(k)}</span>: <span class="${valClass(v)}">${esc(valStr)}</span></div>`;
    })
    .join('');
  if (!rows) return '';
  return `
    <div class="json-section">
      <div class="json-section-head">${esc(title)}</div>
      <div class="json-tree">${rows}</div>
    </div>`;
}

function valClass(v) {
  if (v === null || v === undefined) return 'json-null';
  if (typeof v === 'boolean') return 'json-bool';
  if (typeof v === 'number' || !isNaN(Number(v))) return 'json-num';
  return 'json-str';
}

// ── Interface loader ──────────────────────────────────────────────────────────
async function loadInterfaces() {
  try {
    const r = await fetch(BASE_URL + 'api/interfaces');
    const { interfaces } = await r.json();
    ctrlInterface.innerHTML = interfaces
      .map(i => `<option value="${esc(i)}">${esc(i)}</option>`)
      .join('');
  } catch (_) {
    // leave default "any" option
  }
}

function setInterfaceOption(iface) {
  // Try to select existing option, otherwise add it
  for (const opt of ctrlInterface.options) {
    if (opt.value === iface) { opt.selected = true; return; }
  }
  const opt = document.createElement('option');
  opt.value = opt.textContent = iface;
  opt.selected = true;
  ctrlInterface.prepend(opt);
}

// ── Clear ─────────────────────────────────────────────────────────────────────
function clearPackets() {
  allPackets = [];
  packetTbody.innerHTML = '';
  updateEmptyState();
}

// ── Toasts ────────────────────────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast${type ? ' ' + type : ''}`;
  el.textContent = msg;
  toastsEl.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  btnToggle.addEventListener('click', toggleCapture);
  btnClear.addEventListener('click', clearPackets);
  btnCloseDrawer.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDrawer();
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function formatTime(epoch) {
  if (!epoch) return '--';
  const d = new Date(epoch * 1000);
  return d.toLocaleTimeString('en-GB', { hour12: false }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeClass(proto) {
  // Only allow known safe protocol names as CSS classes
  return /^[A-Z0-9/]{1,10}$/.test(proto) ? proto.replace('/', '') : 'OTHER';
}
