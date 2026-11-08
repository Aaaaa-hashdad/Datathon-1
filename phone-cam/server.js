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
const { createMcp } = require('./mcp');
const { createMotionLog } = require('./motionlog');
const { createFeedback } = require('./feedback');
const { createStats } = require('./stats');

const PUBLIC = path.join(__dirname, 'public');
const LOGIN_ASSETS = {
  '/static/app.css': '../backend/app/static/app.css',
  '/static/auth-cube.css': '../backend/app/static/auth-cube.css',
  '/static/campus.jpg': '../backend/app/static/campus.jpg',
  '/static/signup-fields.js': '../backend/app/static/signup-fields.js',
  '/ui/assets/reveille-logo.png': '../ui/assets/reveille-logo.png',
};
const LOGIN_POSTS = new Set(['/auth/login', '/auth/register', '/auth/guest', '/auth/guest/reset', '/ui/logout']);

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
  '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
};
const MOUNTS = {
  '/mp/': path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision'),
  '/models/': path.join(__dirname, 'models'),
};

async function start({
  httpPort = Number(process.env.HTTP_PORT || 8080),
  httpsPort = Number(process.env.HTTPS_PORT || 8443),
  revgymPort = Number(process.env.REVGYM_PORT || 8000),
  certDir = path.join(__dirname, 'certs'),
  testsetDir = process.env.TESTSET_DIR || path.join(__dirname, 'testset'),
  motionLogDir = process.env.MOTION_LOG_DIR || path.join(__dirname, 'motion-logs'),
} = {}) {
  fs.mkdirSync(path.join(testsetDir, 'reports'), { recursive: true });
  let latest = null;          // Buffer (JPEG)
  let frameCount = 0;
  let lastFrameAt = 0;
  let latestCaptureTime = 0;
  let jpegClock = null;
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
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store',
      'X-Frame': String(frameCount), 'X-Capture-Time': String(latestCaptureTime),
    });
    res.end(latest);
  }

  function pushFrame(buf, headers) {
    const receivedAt = Date.now();
    const id = headers['x-capture-stream'];
    const time = Number(headers['x-capture-time']);
    let capturedAt = receivedAt;
    if (typeof id === 'string' && /^[\d.-]{1,64}$/.test(id) && time > 0 && time <= Number.MAX_SAFE_INTEGER) {
      // The phone and PC may disagree on wall time. Align the first frame, then
      // preserve the phone's frame intervals and ignore late, out-of-order uploads.
      if (jpegClock?.id !== id) jpegClock = { id, offset: receivedAt - time, last: -Infinity };
      if (time <= jpegClock.last) return;
      jpegClock.last = time;
      capturedAt = time + jpegClock.offset;
      if (Math.abs(capturedAt - receivedAt) > 5000) {
        jpegClock.offset = receivedAt - time;
        capturedAt = receivedAt;
      }
    }
    latest = buf;
    frameCount++;
    latestCaptureTime = capturedAt;
    lastFrameAt = receivedAt;
    recent.push(lastFrameAt);
    while (recent.length && recent[0] < lastFrameAt - 2000) recent.shift();
    for (const res of viewers) writeFrame(res, buf);
    for (const w of waiters) { clearTimeout(w.timer); sendJpeg(w.res); }
    waiters.clear();
  }

  // ---- WebRTC signalling: one phone <-> one viewer, whole SDP at once (no trickle ICE) ----
  // Phone posts an offer, the viewer long-polls for it and posts an answer, the phone
  // long-polls for the answer. After that the video flows peer-to-peer, not through here.
  const rtc = { offer: null, answer: null, offerWaiters: new Set(), answerWaiters: new Set() };
  let sensor = null;           // latest phone motion-sensor reading (see /sensor)
  const sendJson = (res, obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });

  function isLocalViewer(req) {
    return !req.socket.encrypted && ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      && [`localhost:${httpPort}`, `127.0.0.1:${httpPort}`].includes(req.headers.host);
  }

  const sessionCookie = (req) => req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('revgym_session='));

  function revgym(req, pathname, body) {
    const headers = {};
    const session = sessionCookie(req);
    if (session) headers.Cookie = session;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`http://127.0.0.1:${revgymPort}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  }

  const loginUnavailable = (res) => sendJson(res, { detail: 'Start the local RevGym server, then try again.' }, 503);

  async function withSignedInViewer(req, res, action) {
    const { origin, 'sec-fetch-site': site } = req.headers;
    if (!isLocalViewer(req) || (origin && origin !== `http://${req.headers.host}`)
      || (req.method !== 'GET' && site && site !== 'same-origin')) return res.writeHead(403).end();
    if (!sessionCookie(req)) return sendJson(res, { error: 'Sign in to RevGym first.' }, 401);
    try {
      const reply = await revgym(req, '/ui/whoami');
      if (!reply.ok) {
        await reply.body?.cancel();
        return reply.status === 401 ? sendJson(res, { error: 'Sign in to RevGym first.' }, 401) : loginUnavailable(res);
      }
      const { username } = await reply.json();
      return await action(motionLog.accountKey(username), username);
    } catch {
      return sendJson(res, { error: 'Could not complete this request. Try again.' }, 502);
    }
  }

  async function publishResults(req, sets) {
    for (let i = 0; i < sets.length; i += 50) {
      const reply = await revgym(req, '/api/ui/workout-results', JSON.stringify({ sets: sets.slice(i, i + 50) }));
      if (!reply.ok) {
        await reply.body?.cancel();
        throw new Error('Could not publish sets to RevGym.');
      }
    }
  }

  async function loginAction(req, res, pathname) {
    if (!isLocalViewer(req)) return res.writeHead(403).end();
    const { origin, 'sec-fetch-site': fetchSite } = req.headers;
    if ((origin && origin !== `http://${req.headers.host}`) || (fetchSite && fetchSite !== 'same-origin')) {
      return res.writeHead(403).end();
    }
    let body = '';
    if (pathname !== '/ui/logout') {
      try { body = JSON.stringify(await readJson(req)); }
      catch { return sendJson(res, { detail: 'Invalid login request.' }, 400); }
    }
    try {
      const reply = await revgym(req, pathname, body);
      const cookies = reply.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      // The shared login page only needs the cookie. Keep the bearer token out of its response.
      if (reply.ok) {
        await reply.body?.cancel();
        return res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      }
      return sendJson(res, await reply.json(), reply.status);
    } catch {
      return loginUnavailable(res);
    }
  }

  async function serveViewer(req, res, file, embedded = false) {
    if (!isLocalViewer(req)) return res.writeHead(403).end();
    if (embedded) {
      const parentOrigin = new URL(`http://${req.headers.host}`);
      parentOrigin.port = revgymPort;
      res.setHeader('Content-Security-Policy', `frame-ancestors ${parentOrigin.origin}`);
    }
    const loginPage = path.resolve(__dirname, '../backend/app/static/ui-login.html');
    try {
      const token = sessionCookie(req);
      if (token) {
        const cameraViewer = path.basename(file).toLowerCase() === 'viewer.html';
        const reply = await revgym(req, cameraViewer ? '/ui/whoami?include_height=true' : '/ui/whoami');
        if (reply.ok) {
          // Motion logs (and Person Statistics) are kept per RevGym user: <username>/<day>/…
          const who = await reply.json().catch(() => null);
          if (cameraViewer && who?.username) {
            const owner = motionLog.accountKey(who.username);
            fs.mkdirSync(path.join(motionLog.dir, owner), { recursive: true });
            motionLog.setUser(owner);
            activeCamera = { token, owner };
          }
          const heightCm = Math.round(who?.height_in * 254) / 100;
          if (cameraViewer && heightCm >= 100 && heightCm <= 245) {
            return serveFile(res, file, 'no-store', (html) => html.replace(
              '<meta name="profile-height-cm" content="">', `<meta name="profile-height-cm" content="${heightCm}">`,
            ));
          }
          return serveFile(res, file, 'no-store');
        }
        await reply.body?.cancel();
        if (reply.status !== 401) return loginUnavailable(res);
      }
      if (embedded) return sendJson(res, { detail: 'Sign in to RevGym first.' }, 401);
      return serveFile(res, loginPage, 'no-store');
    } catch {
      return loginUnavailable(res);
    }
  }

  function serveFile(res, file, cacheControl, transform) {
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        ...(cacheControl && { 'Cache-Control': cacheControl }),
      });
      res.end(transform ? transform(data.toString('utf8')) : data);
    });
  }
  // Park a long-poll until `waiters` is woken with a value, or reply 204 after `ms`.
  function park(waiters, req, res, ms, data = {}) {
    const w = { res, ...data, timer: setTimeout(() => { waiters.delete(w); res.writeHead(204).end(); }, ms) };
    waiters.add(w);
    req.on('close', () => { clearTimeout(w.timer); waiters.delete(w); });
  }

  // Motion log: every live sample -> <user>/<day>/<session>.xlsx (local + Supabase)
  const motionLog = createMotionLog({ dir: motionLogDir });
  let activeCamera;
  const mcp = createMcp({ onState: (sample, req) => {
    if (!activeCamera || (sessionCookie(req) === activeCamera.token && motionLog.user === activeCamera.owner)) {
      motionLog.addSample(sample);
    }
  }, motionLog });
  // Set feedback for the Form Check screen: Claude reads the last set (feedback.js)
  const feedback = createFeedback({ motionLog });
  // Person Statistics: everything this user recorded, with Claude's set analyses (stats.js)
  const stats = createStats({ motionLog, feedback });

  // ---- test set ----
  // A folder of short video clips, each with an optional <clip>.labels.json describing
  // what really happens in it. The viewer's evaluator plays every clip through the
  // tracker + brain and compares the results to the labels.
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;
  const VIDEO_MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
  // Only plain file names inside the test-set folder (no paths, no tricks).
  const safeName = (n) => (n && /^[\w.\- ()]+$/.test(n) && !n.startsWith('.') ? n : null);
  const labelsPath = (video) => path.join(testsetDir, video.replace(VIDEO_EXT, '') + '.labels.json');

  function testsetRoute(req, res, url) {
    const name = safeName(url.searchParams.get('name'));

    if (url.pathname === '/testset/list') {
      const files = fs.readdirSync(testsetDir).filter((f) => VIDEO_EXT.test(f)).sort();
      return sendJson(res, {
        dir: testsetDir,
        clips: files.map((f) => {
          let labels = null;
          try { labels = JSON.parse(fs.readFileSync(labelsPath(f), 'utf8')); } catch {}
          return { name: f, size: fs.statSync(path.join(testsetDir, f)).size, labels };
        }),
      });
    }

    // Video with HTTP range support, so the evaluator can seek frame by frame.
    if (url.pathname.startsWith('/testset/video/')) {
      const file = safeName(decodeURIComponent(url.pathname.slice('/testset/video/'.length)));
      const full = file && path.join(testsetDir, file);
      if (!full || !VIDEO_EXT.test(file) || !fs.existsSync(full)) return res.writeHead(404).end();
      const size = fs.statSync(full).size;
      const type = VIDEO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size) return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        return fs.createReadStream(full, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
      return fs.createReadStream(full).pipe(res);
    }

    if (url.pathname === '/testset/upload' && req.method === 'POST') {
      if (!name || !VIDEO_EXT.test(name)) return sendJson(res, { error: 'bad name' }, 400);
      const out = fs.createWriteStream(path.join(testsetDir, name));
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 1024 * 1024 * 1024) req.destroy(); });
      req.pipe(out);
      out.on('finish', () => sendJson(res, { saved: name, size }));
      out.on('error', (e) => sendJson(res, { error: e.message }, 500));
      return;
    }

    if (url.pathname === '/testset/labels' && req.method === 'POST') {
      if (!name || !VIDEO_EXT.test(name)) return sendJson(res, { error: 'bad name' }, 400);
      readJson(req).then((labels) => {
        fs.writeFileSync(labelsPath(name), JSON.stringify(labels, null, 2));
        sendJson(res, { saved: path.basename(labelsPath(name)) });
      }).catch(() => sendJson(res, { error: 'bad labels' }, 400));
      return;
    }

    if (url.pathname === '/testset/report' && req.method === 'POST') {
      readJson(req).then((report) => {
        const d = new Date(), p = (n) => String(n).padStart(2, '0');
        const file = `report-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
        fs.writeFileSync(path.join(testsetDir, 'reports', file), JSON.stringify(report, null, 2));
        sendJson(res, { saved: path.join(testsetDir, 'reports', file) });
      }).catch(() => sendJson(res, { error: 'bad report' }, 400));
      return;
    }

    return res.writeHead(404).end();
  }

  function handler(req, res) {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/form-check') return serveViewer(req, res, path.join(PUBLIC, 'viewer.html'), true);
    // Person Statistics page, shown inside RevGym like Form Check (signed-in user only)
    if (url.pathname === '/person-stats') return serveViewer(req, res, path.join(PUBLIC, 'person-stats.html'), true);
    if (url.pathname === '/leaderboard-view' || url.pathname === '/data-view') {
      return serveViewer(req, res, path.join(PUBLIC, 'workout-reports.html'), true);
    }
    if (req.method === 'POST' && LOGIN_POSTS.has(url.pathname)) return loginAction(req, res, url.pathname);
    if (req.method === 'GET' && url.pathname === '/ui/') {
      // The shared RevGym login page goes here after it receives its session cookie.
      return res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }).end();
    }
    if (Object.hasOwn(LOGIN_ASSETS, url.pathname)) {
      return serveFile(res, path.resolve(__dirname, LOGIN_ASSETS[url.pathname]), 'no-cache');
    }

    if (url.pathname === '/rtc/offer' && req.method === 'POST') {
      readJson(req).then((o) => {
        rtc.offer = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: o.type, sdp: o.sdp };
        rtc.answer = null;
        for (const w of rtc.offerWaiters) { clearTimeout(w.timer); sendJson(w.res, rtc.offer); }
        rtc.offerWaiters.clear();
        sendJson(res, { id: rtc.offer.id });
      }).catch(() => sendJson(res, { error: 'bad offer' }, 400));
      return;
    }
    if (url.pathname === '/rtc/offer') {          // viewer: wait for an offer newer than ?after
      const after = url.searchParams.get('after') || '';
      if (rtc.offer && rtc.offer.id !== after) return sendJson(res, rtc.offer);
      return park(rtc.offerWaiters, req, res, 15000);
    }
    if (url.pathname === '/rtc/answer' && req.method === 'POST') {
      readJson(req).then((a) => {
        if (!rtc.offer || a.id !== rtc.offer.id) return sendJson(res, { error: 'stale offer' }, 409);
        rtc.answer = { id: a.id, type: a.type, sdp: a.sdp };
        for (const w of rtc.answerWaiters) {
          if (w.id === a.id) { clearTimeout(w.timer); sendJson(w.res, rtc.answer); rtc.answerWaiters.delete(w); }
        }
        res.writeHead(204).end();
      }).catch(() => sendJson(res, { error: 'bad answer' }, 400));
      return;
    }
    if (url.pathname === '/rtc/answer') {         // phone: wait for the answer to its offer
      const id = url.searchParams.get('id');
      if (rtc.answer && rtc.answer.id === id) return sendJson(res, rtc.answer);
      return park(rtc.answerWaiters, req, res, 15000, { id });
    }

    // Phone motion sensors (gravity + rotation), for the room lock's true vertical and
    // "camera moved" check. The phone posts (like /frame); only this PC may read it back.
    if (url.pathname === '/sensor') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
        req.on('end', () => {
          try { sensor = { ...JSON.parse(body), t: Date.now() }; } catch {}
          res.writeHead(204).end();
        });
        return;
      }
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (!local) return res.writeHead(403).end();
      return sendJson(res, sensor && Date.now() - sensor.t < 2000 ? sensor : { none: true });
    }

    if (req.method === 'POST' && url.pathname === '/frame') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 5 * 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        pushFrame(Buffer.concat(chunks), req.headers);
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

    // Long-poll: returns the first frame newer than ?after=N (or 204 after ?wait ms, max 10s).
    if (url.pathname === '/next.jpg') {
      const after = Number(url.searchParams.get('after') || 0);
      const wait = Math.min(10000, Number(url.searchParams.get('wait') || 10000));
      if (latest && frameCount > after) return sendJpeg(res);
      const w = { res, timer: setTimeout(() => { waiters.delete(w); res.writeHead(204).end(); }, wait) };
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

    // ---- test set: labelled clips for measuring accuracy ----
    if (url.pathname.startsWith('/testset/')) return testsetRoute(req, res, url);

    // ---- account-scoped feedback, stats and data ----
    if (url.pathname === '/feedback') {
      if (req.method !== 'POST') return res.writeHead(405).end();
      return withSignedInViewer(req, res, (owner) => feedback.route(req, res, url, sendJson, owner, (sets) => publishResults(req, sets)));
    }
    if (url.pathname.startsWith('/stats/')) {
      return withSignedInViewer(req, res, (owner, username) =>
        stats.route(req, res, url, sendJson, owner, (sets) => publishResults(req, sets), username));
    }
    if (url.pathname === '/workout-leaderboard' && req.method === 'GET') {
      return withSignedInViewer(req, res, async () => {
        const reply = await revgym(req, `/api/ui/workout-leaderboard${url.search}`);
        return sendJson(res, await reply.json(), reply.status);
      });
    }
    if (url.pathname === '/workout-leaderboard/publish' && req.method === 'POST') {
      return withSignedInViewer(req, res, async (owner) => {
        const sets = feedback.savedBoardResults(owner);
        await publishResults(req, sets);
        return sendJson(res, { published: sets.length });
      });
    }
    if (url.pathname.startsWith('/workout-data/') && req.method === 'GET') {
      return withSignedInViewer(req, res, async (owner) => {
        if (url.pathname === '/workout-data/list') {
          const day = url.searchParams.get('day');
          if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, { error: 'Invalid date.' }, 400);
          const keys = await motionLog.dataKeys(owner, day);
          return sendJson(res, { files: keys.map((key) => key.slice(owner.length + 1)) });
        }
        const session = url.searchParams.get('session') || '';
        if (!/^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.xlsx$/.test(session)) return sendJson(res, { error: 'Invalid session.' }, 400);
        const key = `${owner}/${session}`;
        if (url.pathname === '/workout-data/preview') {
          const log = await motionLog.readSession(key);
          return sendJson(res, { rows: log.rows.slice(0, 12), frames: log.rows.length,
            jumps: log.jumps.slice(0, 12), jumpCount: log.jumps.length });
        }
        if (url.pathname === '/workout-data/download') {
          const workbook = await motionLog.readWorkbook(key);
          if (!workbook) return sendJson(res, { error: 'Workbook not found.' }, 404);
          res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${session.replace('/', '_')}"` });
          return res.end(workbook);
        }
        return sendJson(res, { error: 'Not found.' }, 404);
      });
    }

    // ---- MCP: lets Claude ask what the tracker sees (this computer only) ----
    if (url.pathname === '/mcp') return mcp.mcpRoute(req, res);
    if (url.pathname === '/state' || url.pathname.startsWith('/state/')) return mcp.stateRoute(req, res, url);

    // ---- motion log: Excel files per user / day / session (local + Supabase Storage) ----
    if (url.pathname.startsWith('/motionlog/')) return motionLog.route(req, res, url);

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
    if (root === PUBLIC && /^viewer\.html[. ]*$/i.test(path.basename(full))) return serveViewer(req, res, full);
    // Big MediaPipe/model files may cache. The camera pages and scripts must stay fresh.
    const ours = root === PUBLIC && /\.(html|js|mjs|css)$/.test(full);
    return serveFile(res, full, ours ? 'no-cache' : undefined);
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
    testsetDir,
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
    console.log(`  Claude (MCP):      claude mcp add --transport http phone-cam ${viewerUrl}mcp\n`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
