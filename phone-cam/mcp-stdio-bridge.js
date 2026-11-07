// stdio <-> HTTP bridge for Phone Camera's MCP server.
//
// Claude Desktop starts local MCP servers as commands that talk JSON-RPC over
// stdin/stdout, one message per line. This forwards each message to the app's HTTP
// endpoint and prints the reply. Run with plain Node, or with the Phone Camera app's own
// executable and ELECTRON_RUN_AS_NODE=1 (so no Node install is needed).
//
//   node mcp-stdio-bridge.js http://localhost:8080/mcp

const http = require('http');

const url = process.argv[2] || 'http://localhost:8080/mcp';
let pending = 0, ended = false;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// One message at a time, so replies come back in the order requests were sent.
let chain = Promise.resolve();
function forward(line) {
  pending++;
  chain = chain.then(() => new Promise((resolve) => send(line, resolve)));
}

function send(line, finished) {
  let msg;
  const done = () => { finished(); doneOne(); };
  try { msg = JSON.parse(line); } catch { return done(); }
  const body = Buffer.from(line, 'utf8');
  const req = http.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': body.length },
  }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { text += c; });
    res.on('end', () => {
      if (res.statusCode === 200 && text.trim()) process.stdout.write(text.trim() + '\n');
      else if (res.statusCode !== 202 && msg.id !== undefined) {
        out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Phone Camera answered HTTP ${res.statusCode}` } });
      }
      done();
    });
  });
  req.on('error', () => {
    if (msg.id !== undefined) {
      out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'The Phone Camera app is not running. Open it, then try again.' } });
    }
    done();
  });
  req.end(body);
}
function doneOne() { pending--; if (ended && pending === 0) process.exit(0); }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) forward(line);
  }
});
process.stdin.on('end', () => { ended = true; if (pending === 0) process.exit(0); });
