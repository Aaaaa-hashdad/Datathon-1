// Phone -> PC camera bridge.
//
// Phone opens https://<pc-lan-ip>:8443/phone  (HTTPS is required for the phone camera)
// PC opens    http://localhost:8080/          (live view + QR code)
//
// Endpoints (both ports):
//   POST /frame        phone uploads a JPEG frame
//   GET  /stream.mjpg  live MJPEG stream (works in <img>, OpenCV, VLC)
//   GET  /latest.jpg   most recent frame
//   GET  /status       JSON: connected, fps, frame count
//   GET  /info         JSON: phone URLs (best first)
//   GET  /qr.svg?url=  QR code for one of the phone URLs

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');

const PUBLIC = path.join(__dirname, 'public');

// LAN IPv4s, best guess first: home/campus ranges before VPN-ish ones (e.g. Hamachi 25.x).
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  const rank = (ip) =>
    /^192\.168\./.test(ip) ? 0 :
    /^10\./.test(ip) ? 1 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return out.sort((a, b) => rank(a) - rank(b));
}

// Self-signed cert covering localhost + every LAN IP. Regenerated if the IPs change.
async function ensureCert(certDir, ips) {
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  const ipsPath = path.join(certDir, 'ips.txt');
  const want = ips.slice().sort().join(',');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath) &&
      fs.existsSync(ipsPath) && fs.readFileSync(ipsPath, 'utf8') === want) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'phone-cam' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 365 * 864e5),
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...ips.map((ip) => ({ type: 7, ip })),
      ],
    }],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(ipsPath, want);
  return { key: pems.private, cert: pems.cert };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm',
};
const MOUNTS = {
  '/mp/': path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision'),
  '/models/': path.join(__dirname, 'models'),
};

async function start({
  httpPort = Number(process.env.HTTP_PORT || 8080),
  httpsPort = Number(process.env.HTTPS_PORT || 8443),
  certDir = path.join(__dirname, 'certs'),
} = {}) {
  let latest = null;          // Buffer (JPEG)
  let frameCount = 0;
  let lastFrameAt = 0;
  const recent = [];          // timestamps for fps
  const viewers = new Set();  // MJPEG responses

  const ips = lanIPs();
  const phoneUrls = ips.map((ip) => `https://${ip}:${httpsPort}/phone`);

  function writeFrame(res, buf) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
    res.write(buf);
    res.write('\r\n');
  }

  const waiters = new Set();  // /next.jpg long-polls

  function sendJpeg(res) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame': String(frameCount) });
    res.end(latest);
  }

  function pushFrame(buf) {
    latest = buf;
    frameCount++;
    lastFrameAt = Date.now();
    recent.push(lastFrameAt);
    while (recent.length && recent[0] < lastFrameAt - 2000) recent.shift();
    for (const res of viewers) writeFrame(res, buf);
    for (const w of waiters) { clearTimeout(w.timer); sendJpeg(w.res); }
    waiters.clear();
  }

  function handler(req, res) {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'POST' && url.pathname === '/frame') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 5 * 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        pushFrame(Buffer.concat(chunks));
        res.writeHead(204).end();
      });
      return;
    }

    if (url.pathname === '/stream.mjpg') {
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'close',
      });
      viewers.add(res);
      if (latest) writeFrame(res, latest);
      req.on('close', () => viewers.delete(res));
      return;
    }

    if (url.pathname === '/latest.jpg') {
      if (!latest) return res.writeHead(404).end('no frame yet');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(latest);
    }

    // Long-poll: returns the first frame newer than ?after=N (or 204 after 10s).
    if (url.pathname === '/next.jpg') {
      const after = Number(url.searchParams.get('after') || 0);
      if (latest && frameCount > after) return sendJpeg(res);
      const w = { res, timer: setTimeout(() => { waiters.delete(w); res.writeHead(204).end(); }, 10000) };
      waiters.add(w);
      req.on('close', () => { clearTimeout(w.timer); waiters.delete(w); });
      return;
    }

    if (url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        connected: Date.now() - lastFrameAt < 2000,
        fps: recent.length / 2,
        frames: frameCount,
        viewers: viewers.size,
      }));
    }

    if (url.pathname === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ phoneUrls }));
    }

    if (url.pathname === '/qr.svg') {
      // Only encode our own phone URLs, never arbitrary input.
      const target = phoneUrls.includes(url.searchParams.get('url'))
        ? url.searchParams.get('url') : phoneUrls[0];
      if (!target) return res.writeHead(404).end('no network');
      QRCode.toString(target, { type: 'svg', margin: 1, width: 280 }, (err, svg) => {
        if (err) return res.writeHead(500).end(String(err));
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        res.end(svg);
      });
      return;
    }

    // static files: / -> viewer (PC), /phone -> camera page,
    // /mp/* -> MediaPipe JS+WASM, /models/* -> bundled .task models (works offline)
    let root = PUBLIC;
    let file = url.pathname === '/' ? 'viewer.html'
      : url.pathname === '/phone' ? 'phone.html'
      : url.pathname.slice(1);
    for (const [prefix, dir] of Object.entries(MOUNTS)) {
      if (url.pathname.startsWith(prefix)) { root = dir; file = url.pathname.slice(prefix.length); }
    }
    const full = path.join(root, path.normalize(file));
    if (!full.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.readFile(full, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  const tls = await ensureCert(certDir, ips);
  const listen = (srv, port) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '0.0.0.0', resolve);
  });
  const httpsServer = https.createServer(tls, handler);
  const httpServer = http.createServer(handler);
  await listen(httpsServer, httpsPort);
  await listen(httpServer, httpPort);

  return {
    phoneUrls,
    viewerUrl: `http://localhost:${httpPort}/`,
    close() { httpsServer.close(); httpServer.close(); },
  };
}

module.exports = { start };

if (require.main === module) {
  start().then(({ phoneUrls, viewerUrl }) => {
    console.log('\nPhone camera bridge running\n');
    console.log('  On your PHONE (same Wi-Fi), open (or scan the QR in the viewer):');
    for (const u of phoneUrls) console.log(`    ${u}`);
    console.log('    (tap "Advanced" -> "Proceed" on the certificate warning)\n');
    console.log(`  On this PC, open:  ${viewerUrl}\n`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
