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
const BACKEND = process.env.CAPTURE_BACKEND || 'tshark';

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
function processPacket(pkt) {
  packetIdCounter++;

  const layers = pkt?._source?.layers || {};
  const frame  = layers.frame || {};
  const ip     = layers.ip || layers.ipv6 || {};
  const eth    = layers.eth || {};

  const proto   = guessProtocol(layers);
  const src     = ip['ip.src'] || ip['ipv6.src'] || eth['eth.src'] || '?';
  const dst     = ip['ip.dst'] || ip['ipv6.dst'] || eth['eth.dst'] || '?';
  const length  = parseInt(frame['frame.len'] || '0', 10);
  const time    = parseFloat(frame['frame.time_epoch'] || (Date.now() / 1000));
  const info    = buildInfo(proto, layers);

  const packet = {
    id: packetIdCounter,
    time,
    timeRelative: frame['frame.time_relative'] || '0',
    src,
    dst,
    protocol: proto,
    length,
    info,
    raw: pkt,
  };

  // Push to ring buffer
  packetBuffer.push(packet);
  if (packetBuffer.length > MAX_PACKETS) packetBuffer.shift();

  // Accumulate stats
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
  if (layers.http)  return 'HTTP';
  if (layers.http2) return 'HTTP/2';
  if (layers.tls)   return 'TLS';
  if (layers.dns)   return 'DNS';
  if (layers.dhcp)  return 'DHCP';
  if (layers.icmp)  return 'ICMP';
  if (layers.icmpv6) return 'ICMPv6';
  if (layers.tcp)   return 'TCP';
  if (layers.udp)   return 'UDP';
  if (layers.arp)   return 'ARP';
  if (layers.ipv6)  return 'IPv6';
  if (layers.ip)    return 'IP';
  return 'OTHER';
}

function buildInfo(proto, layers) {
  try {
    if (proto === 'DNS') {
      const dns = layers.dns;
      const qry = dns['dns.qry.name'] || '';
      const resp = dns['dns.resp.name'] || '';
      return qry ? `Query: ${qry}` : resp ? `Response: ${resp}` : 'DNS';
    }
    if (proto === 'HTTP') {
      const http = layers.http;
      return http['http.request.method']
        ? `${http['http.request.method']} ${http['http.request.uri'] || ''}`
        : `${http['http.response.code'] || ''} ${http['http.response.phrase'] || ''}`;
    }
    if (proto === 'TCP') {
      const tcp = layers.tcp;
      return `${tcp['tcp.srcport']} → ${tcp['tcp.dstport']} [${tcp['tcp.flags.string'] || ''}]`;
    }
    if (proto === 'UDP') {
      const udp = layers.udp;
      return `${udp['udp.srcport']} → ${udp['udp.dstport']}`;
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
  const iface  = opts.interface || INTERFACE;
  const filter = opts.captureFilter !== undefined ? opts.captureFilter : CAPTURE_FILTER;
  const snap   = opts.snaplen || SNAPLEN;
  const dfilter = opts.displayFilter !== undefined ? opts.displayFilter : DISPLAY_FILTER;

  const args = [
    '-i', iface,
    '-s', String(snap),
    '-l',           // line-buffered
    '-T', 'json',
    '-e', 'frame.time_epoch',
    '-e', 'frame.time_relative',
    '-e', 'frame.len',
    '-e', 'eth.src',
    '-e', 'eth.dst',
    '-e', 'ip.src',
    '-e', 'ip.dst',
    '-e', 'ipv6.src',
    '-e', 'ipv6.dst',
    '-e', 'ip.proto',
    '-e', 'tcp.srcport',
    '-e', 'tcp.dstport',
    '-e', 'tcp.flags.string',
    '-e', 'udp.srcport',
    '-e', 'udp.dstport',
    '-e', 'dns.qry.name',
    '-e', 'dns.resp.name',
    '-e', 'http.request.method',
    '-e', 'http.request.uri',
    '-e', 'http.response.code',
    '-e', 'http.response.phrase',
    '-e', 'tls.handshake.type',
  ];

  // Layer-based protocol presence markers
  ['eth','ip','ipv6','tcp','udp','icmp','icmpv6','arp','dns','http','http2','tls','dhcp'].forEach(p => {
    args.push('-e', `${p}`);
  });

  if (filter) args.push('-f', filter);
  if (dfilter) args.push('-Y', dfilter);

  console.log(`[tshark] Starting: tshark ${args.join(' ')}`);

  captureProcess = spawn('tshark', args);
  sessionStartTime = Date.now();

  // tshark emits a JSON array. We accumulate and parse bracket-by-bracket.
  let buf = '';
  let bracketDepth = 0;
  let inObject = false;

  captureProcess.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    // Simple streaming JSON parser: extract complete top-level objects
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (ch === '{') {
        if (bracketDepth === 0) inObject = true;
        bracketDepth++;
      } else if (ch === '}') {
        bracketDepth--;
        if (bracketDepth === 0 && inObject) {
          const jsonStr = buf.slice(buf.lastIndexOf('{', i - (buf.length - i - 1)), i + 1);
          // Find the actual start of this object
          try {
            // Re-extract cleanly
            const start = findObjectStart(buf, i);
            if (start !== -1) {
              const candidate = buf.slice(start, i + 1);
              const parsed = JSON.parse(candidate);
              processPacket(parsed);
              buf = buf.slice(i + 1);
              i = -1; // restart scan
              bracketDepth = 0;
              inObject = false;
            }
          } catch (_) {}
        }
      }
    }
    // Prevent unbounded buffer growth if parsing lags
    if (buf.length > 2_000_000) buf = buf.slice(-500_000);
  });

  captureProcess.stderr.on('data', (d) => console.error('[tshark stderr]', d.toString()));
  captureProcess.on('close', (code) => {
    console.log(`[tshark] exited with code ${code}`);
    captureProcess = null;
    broadcast({ type: 'captureState', isCapturing: false });
  });

  broadcast({ type: 'captureState', isCapturing: true, sessionStartTime });
}

function findObjectStart(str, endIdx) {
  let depth = 0;
  for (let i = endIdx; i >= 0; i--) {
    if (str[i] === '}') depth++;
    else if (str[i] === '{') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
