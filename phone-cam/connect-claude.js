// Registers (or removes) Phone Camera's MCP server with the Claude apps on this computer:
//
//  - Claude Code:    `claude mcp add --scope user ...` (works in every project). If the
//                    `claude` command isn't on the PATH, edits ~/.claude.json directly.
//  - Claude Desktop: adds an entry to claude_desktop_config.json. Desktop only starts
//                    local servers as commands (stdio), so it runs our small bridge
//                    script with the app's own executable: no Node install needed.
//
// Config files are backed up once (*.bak-phonecam) before the first change, and only
// the "phone-cam" entry is ever touched.
// For tests, PHONECAM_TEST_HOME / PHONECAM_TEST_APPDATA point everything at fake folders
// (and skip the `claude` command).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NAME = 'phone-cam';

function paths() {
  const test = process.env.PHONECAM_TEST_HOME;
  const home = test || os.homedir();
  let desktopDir;
  if (process.platform === 'win32') {
    desktopDir = path.join(process.env.PHONECAM_TEST_APPDATA || (test ? path.join(home, 'AppData', 'Roaming') : process.env.APPDATA || path.join(home, 'AppData', 'Roaming')), 'Claude');
  } else if (process.platform === 'darwin') {
    desktopDir = path.join(home, 'Library', 'Application Support', 'Claude');
  } else {
    desktopDir = path.join(home, '.config', 'Claude');
  }
  return {
    test: !!test,
    claudeJson: path.join(home, '.claude.json'),
    claudeDir: path.join(home, '.claude'),
    desktopDir,
    desktopConfig: path.join(desktopDir, 'claude_desktop_config.json'),
  };
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);           // throws on a broken file: we never overwrite those
}
function writeJson(file, obj) {
  const bak = file + '.bak-phonecam';
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-phonecam';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);          // atomic replace, so a crash can't leave half a file
}

// Run the `claude` CLI. Resolves { found, code, out }.
function runClaude(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('claude', args, { shell: process.platform === 'win32', windowsHide: true });
    } catch { return resolve({ found: false, code: -1, out: '' }); }
    const timer = setTimeout(() => { child.kill(); resolve({ found: true, code: -1, out: out + '\n(timed out)' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ found: false, code: -1, out }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Windows shells report "not recognized" instead of failing to spawn
      const missing = code !== 0 && /not recognized|not found|No such file/i.test(out);
      resolve({ found: !missing, code, out: out.trim() });
    });
  });
}

const codeInstalled = (p) => fs.existsSync(p.claudeJson) || fs.existsSync(p.claudeDir);
const desktopInstalled = (p) => fs.existsSync(p.desktopDir);

async function status() {
  const p = paths();
  const res = { claudeCode: { installed: codeInstalled(p), connected: false }, claudeDesktop: { installed: desktopInstalled(p), connected: false } };
  try { res.claudeCode.connected = !!readJson(p.claudeJson).mcpServers?.[NAME]; } catch (e) { res.claudeCode.error = `can't read ${p.claudeJson}: ${e.message}`; }
  try { res.claudeDesktop.connected = !!readJson(p.desktopConfig).mcpServers?.[NAME]; } catch (e) { res.claudeDesktop.error = `can't read ${p.desktopConfig}: ${e.message}`; }
  return res;
}

async function connectClaudeCode(url) {
  const p = paths();
  if (!p.test) {
    await runClaude(['mcp', 'remove', NAME, '--scope', 'user']);            // replace an old entry, if any
    const r = await runClaude(['mcp', 'add', '--transport', 'http', '--scope', 'user', NAME, url]);
    if (r.found && r.code === 0) return { ok: true, via: 'claude command', detail: r.out };
    if (r.found && r.code !== 0 && !codeInstalled(p)) return { ok: false, error: r.out || 'claude mcp add failed' };
  }
  if (!codeInstalled(p)) return { ok: false, missing: true };
  try {
    const cfg = readJson(p.claudeJson);
    cfg.mcpServers = { ...(cfg.mcpServers || {}), [NAME]: { type: 'http', url } };
    writeJson(p.claudeJson, cfg);
    return { ok: true, via: 'config file', detail: p.claudeJson };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function connectClaudeDesktop(url, bridgePath, exePath) {
  const p = paths();
  if (!desktopInstalled(p)) return { ok: false, missing: true };
  try {
    const cfg = readJson(p.desktopConfig);
    cfg.mcpServers = {
      ...(cfg.mcpServers || {}),
      // the app's own executable runs the bridge as plain Node (ELECTRON_RUN_AS_NODE)
      [NAME]: { command: exePath, args: [bridgePath, url], env: { ELECTRON_RUN_AS_NODE: '1' } },
    };
    writeJson(p.desktopConfig, cfg);
    return { ok: true, via: 'config file', detail: p.desktopConfig, restartNeeded: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function connect({ url, bridgeSource, bridgeDir, exePath }) {
  // Copy the bridge out of the app folder, so it still works when the app is packaged.
  fs.mkdirSync(bridgeDir, { recursive: true });
  const bridgePath = path.join(bridgeDir, 'mcp-stdio-bridge.js');
  fs.copyFileSync(bridgeSource, bridgePath);
  const [claudeCode, claudeDesktop] = [await connectClaudeCode(url), await connectClaudeDesktop(url, bridgePath, exePath)];
  return { claudeCode, claudeDesktop, url };
}

async function disconnect() {
  const p = paths();
  const out = { claudeCode: { ok: true }, claudeDesktop: { ok: true } };
  if (!p.test) {
    const r = await runClaude(['mcp', 'remove', NAME, '--scope', 'user']);
    if (r.found && r.code === 0) out.claudeCode.via = 'claude command';
  }
  for (const [key, file] of [['claudeCode', p.claudeJson], ['claudeDesktop', p.desktopConfig]]) {
    try {
      const cfg = readJson(file);
      if (cfg.mcpServers?.[NAME]) { delete cfg.mcpServers[NAME]; writeJson(file, cfg); out[key].via ??= 'config file'; }
    } catch (e) { out[key] = { ok: false, error: e.message }; }
  }
  return out;
}

module.exports = { status, connect, disconnect, NAME };
