'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');

// ─── Configuration ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8099', 10);
const INTERFACE = process.env.HA_INTERFACE || 'any';
const CAPTURE_FILTER = process.env.HA_CAPTURE_FILTER || '';
const DISPLAY_FILTER = process.env.HA_DISPLAY_FILTER || '';
const MAX_PACKETS = parseInt(process.env.HA_MAX_PACKETS || '10000', 10);
const SNAPLEN = parseInt(process.env.HA_SNAPLEN || '65535', 10);

// ─── State ───────────────────────────────────────────────────────────────────
let captureProcess = null;
let sessionStartTime = null;
let packetBuffer = [];           // ring buffer of last MAX_PACKETS packets
let packetIdCounter = 0;

// Stats for the live dashboard
let stats = {
  totalPackets: 0,
  totalBytes: 0,
  packetsPerSec: 0,
  bytesPerSec: 0,
  protocols: {},       // protocol -> count
  conversations: {},   // 'src:dst' -> { bytes, packets }
  timeline: [],        // [ { ts, bytes, packets } ] 60 entries
};

let lastStatsSnap = { packets: 0, bytes: 0, ts: Date.now() };

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── HTTP Server + WebSocket ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const wsClients = new Set();
wss.on('connection', (ws) => {
  wsClients.add(ws);
  // Send initial snapshot so the UI can hydrate immediately
  ws.send(JSON.stringify({
    type: 'snapshot',
    packets: packetBuffer.slice(-200),
    stats,
    isCapturing: captureProcess !== null,
    sessionStartTime,
    config: { interface: INTERFACE, captureFilter: CAPTURE_FILTER, maxPackets: MAX_PACKETS },
  }));
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

// ─── Packet processing ────────────────────────────────────────────────────────
// tshark EK format: field names use underscores (ip_src) in some versions,
// dots (ip.src) in others. Try both so we work across tshark versions.
const fld = (layers, name) => {
  const v = layers[name] !== undefined
    ? layers[name]
    : layers[name.replace(/\./g, '_')];
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v[0] : v;
};

function processPacket(pkt) {
  packetIdCounter++;

  const layers = pkt.layers || {};
  const proto  = guessProtocol(layers);
  const src    = fld(layers, 'ip.src') || fld(layers, 'ipv6.src') || fld(layers, 'eth.src') || '?';
  const dst    = fld(layers, 'ip.dst') || fld(layers, 'ipv6.dst') || fld(layers, 'eth.dst') || '?';
  const length = parseInt(fld(layers, 'frame.len') || '0', 10);
  const time   = parseFloat(fld(layers, 'frame.time_epoch') || (Date.now() / 1000));
  const info   = buildInfo(proto, layers);

  const packet = {
    id: packetIdCounter,
    time,
    timeRelative: fld(layers, 'frame.time_relative') || '0',
    src,
    dst,
    protocol: proto,
    length,
    info,
    raw: layers,
  };

  packetBuffer.push(packet);
  if (packetBuffer.length > MAX_PACKETS) packetBuffer.shift();

  stats.totalPackets++;
  stats.totalBytes += length;
  stats.protocols[proto] = (stats.protocols[proto] || 0) + 1;

  const convKey = [src, dst].sort().join(' ↔ ');
  if (!stats.conversations[convKey]) {
    stats.conversations[convKey] = { packets: 0, bytes: 0, src, dst };
  }
  stats.conversations[convKey].packets++;
  stats.conversations[convKey].bytes += length;

  broadcast({ type: 'packet', packet });
}

function guessProtocol(layers) {
  if (fld(layers, 'http.request.method') || fld(layers, 'http.response.code')) return 'HTTP';
  if (fld(layers, 'http2.stream'))         return 'HTTP/2';
  if (fld(layers, 'tls.handshake.type') !== undefined) return 'TLS';
  if (fld(layers, 'dns.qry.name') !== undefined || fld(layers, 'dns.resp.name') !== undefined) return 'DNS';
  if (fld(layers, 'dhcp.option.dhcp') !== undefined)   return 'DHCP';
  if (fld(layers, 'icmpv6.type') !== undefined)         return 'ICMPv6';
  if (fld(layers, 'icmp.type')   !== undefined)         return 'ICMP';
  if (fld(layers, 'arp.opcode')  !== undefined)         return 'ARP';
  if (fld(layers, 'tcp.srcport') !== undefined)         return 'TCP';
  if (fld(layers, 'udp.srcport') !== undefined)         return 'UDP';
  if (fld(layers, 'ipv6.src')    !== undefined)         return 'IPv6';
  if (fld(layers, 'ip.src')      !== undefined)         return 'IP';
  if (fld(layers, 'eth.src')     !== undefined)         return 'Ethernet';
  return 'OTHER';
}

function buildInfo(proto, layers) {
  try {
    if (proto === 'DNS') {
      const qry  = fld(layers, 'dns.qry.name')  || '';
      const resp = fld(layers, 'dns.resp.name') || '';
      return qry ? `Query: ${qry}` : resp ? `Response: ${resp}` : 'DNS';
    }
    if (proto === 'HTTP') {
      const method = fld(layers, 'http.request.method');
      return method
        ? `${method} ${fld(layers, 'http.request.uri') || ''}`
        : `${fld(layers, 'http.response.code') || ''} ${fld(layers, 'http.response.phrase') || ''}`;
    }
    if (proto === 'TCP') {
      const flags = fld(layers, 'tcp.flags') || '';
      return `${fld(layers, 'tcp.srcport')} → ${fld(layers, 'tcp.dstport')} [${flags}]`;
    }
    if (proto === 'UDP') {
      return `${fld(layers, 'udp.srcport')} → ${fld(layers, 'udp.dstport')}`;
    }
    if (proto === 'ICMP' || proto === 'ICMPv6') {
      const type = fld(layers, 'icmp.type') || fld(layers, 'icmpv6.type') || '';
      return `Type: ${type}`;
    }
  } catch (_) {}
  return proto;
}

// ─── Stats ticker (1 s) ───────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const elapsed = (now - lastStatsSnap.ts) / 1000;
  stats.packetsPerSec = Math.round((stats.totalPackets - lastStatsSnap.packets) / elapsed);
  stats.bytesPerSec   = Math.round((stats.totalBytes   - lastStatsSnap.bytes)   / elapsed);
  lastStatsSnap = { packets: stats.totalPackets, bytes: stats.totalBytes, ts: now };

  // Rolling 60s timeline
  stats.timeline.push({ ts: now, bytes: stats.bytesPerSec, packets: stats.packetsPerSec });
  if (stats.timeline.length > 60) stats.timeline.shift();

  broadcast({ type: 'stats', stats });
}, 1000);

// ─── tshark capture ───────────────────────────────────────────────────────────
function startTshark(opts = {}) {
  const iface   = opts.interface || INTERFACE;
  const filter  = opts.captureFilter !== undefined ? opts.captureFilter : CAPTURE_FILTER;
  const snap    = opts.snaplen || SNAPLEN;
  const dfilter = opts.displayFilter !== undefined ? opts.displayFilter : DISPLAY_FILTER;

  const args = [
    '-i', iface,
    '-s', String(snap),
    '-l',
    '-T', 'ek',          // EK = newline-delimited JSON, one object per line
    '-e', 'frame.time_epoch',
    '-e', 'frame.time_relative',
    '-e', 'frame.len',
    '-e', 'eth.src',
    '-e', 'eth.dst',
    '-e', 'ip.src',
    '-e', 'ip.dst',
    '-e', 'ip.proto',
    '-e', 'ipv6.src',
    '-e', 'ipv6.dst',
    '-e', 'tcp.srcport',
    '-e', 'tcp.dstport',
    '-e', 'tcp.flags',
    '-e', 'udp.srcport',
    '-e', 'udp.dstport',
    '-e', 'icmp.type',
    '-e', 'icmpv6.type',
    '-e', 'arp.opcode',
    '-e', 'dns.qry.name',
    '-e', 'dns.resp.name',
    '-e', 'http.request.method',
    '-e', 'http.request.uri',
    '-e', 'http.response.code',
    '-e', 'http.response.phrase',
    '-e', 'http2.stream',
    '-e', 'tls.handshake.type',
    '-e', 'dhcp.option.dhcp',
  ];

  if (filter)  args.push('-f', filter);
  if (dfilter) args.push('-Y', dfilter);

  console.log(`[tshark] Starting: tshark ${args.join(' ')}`);

  captureProcess = spawn('tshark', args);
  sessionStartTime = Date.now();

  // EK format: two lines per packet — an index line then a packet line.
  // Index lines start with {"index":...}, packet lines have {"timestamp":...,"layers":{...}}.
  // We only care about packet lines (those with a "layers" key).
  let buf = '';
  captureProcess.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // retain incomplete trailing line
    for (const line of lines) {
      if (!line.trim() || line.includes('"index"')) continue;
      try {
        const pkt = JSON.parse(line);
        if (pkt.layers) processPacket(pkt);
      } catch (_) {}
    }
  });

  captureProcess.stderr.on('data', (d) => console.error('[tshark stderr]', d.toString()));
  captureProcess.on('close', (code) => {
    console.log(`[tshark] exited with code ${code}`);
    captureProcess = null;
    broadcast({ type: 'captureState', isCapturing: false });
  });

  broadcast({ type: 'captureState', isCapturing: true, sessionStartTime });
}

function stopCapture() {
  if (captureProcess) {
    captureProcess.kill('SIGTERM');
    captureProcess = null;
  }
  broadcast({ type: 'captureState', isCapturing: false });
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/interfaces', (_req, res) => {
  try {
    const output = execSync('tshark -D 2>&1 || ip link show 2>&1', { timeout: 5000 }).toString();
    const ifaces = [];
    output.split('\n').forEach(line => {
      // tshark -D format: "1. eth0 (Ethernet)"
      const m = line.match(/^\d+\.\s+(\S+)/);
      if (m) ifaces.push(m[1]);
    });
    // Also include OS interfaces
    const osIfaces = Object.keys(os.networkInterfaces());
    const merged = ['any', ...new Set([...ifaces, ...osIfaces])];
    res.json({ interfaces: merged });
  } catch (e) {
    res.json({ interfaces: ['any', 'eth0', 'wlan0'] });
  }
});

app.post('/api/capture/start', (req, res) => {
  if (captureProcess) return res.status(409).json({ error: 'Capture already running' });
  // Reset stats for new session
  stats = { totalPackets: 0, totalBytes: 0, packetsPerSec: 0, bytesPerSec: 0, protocols: {}, conversations: {}, timeline: [] };
  packetBuffer = [];
  packetIdCounter = 0;
  lastStatsSnap = { packets: 0, bytes: 0, ts: Date.now() };
  startTshark(req.body || {});
  res.json({ ok: true, started: new Date().toISOString() });
});

app.post('/api/capture/stop', (_req, res) => {
  stopCapture();
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => {
  res.json({
    isCapturing: captureProcess !== null,
    sessionStartTime,
    totalPackets: stats.totalPackets,
    config: { interface: INTERFACE, captureFilter: CAPTURE_FILTER, maxPackets: MAX_PACKETS },
  });
});

app.get('/api/packets', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 5000);
  const offset = parseInt(req.query.offset || '0', 10);
  let filtered = packetBuffer;
  if (req.query.protocol) filtered = filtered.filter(p => p.protocol === req.query.protocol);
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    filtered = filtered.filter(p => p.src.includes(q) || p.dst.includes(q) || p.info.toLowerCase().includes(q));
  }
  res.json({
    total: filtered.length,
    packets: filtered.slice(offset, offset + limit),
  });
});

app.get('/api/stats', (_req, res) => res.json(stats));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] tshark-HA running on http://0.0.0.0:${PORT}`);
  // Auto-start capture if interface configured explicitly
  if (INTERFACE && INTERFACE !== 'any' || process.env.AUTO_START === 'true') {
    console.log('[server] Auto-starting capture...');
    startTshark();
  }
});
