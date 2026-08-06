// ccd node client: command dispatcher.
//   node index.js connect <url>        save server + token
//   node index.js start                start the daemon in the background
//   node index.js stop                 stop the daemon
//   node index.js status               daemon status + session list
//   node index.js ls                   list sessions
//   node index.js attach <sessionId>   attach to a running session
//   node index.js spawn <profile> [cwd] spawn a session non-interactively and attach
//   node index.js                      TUI: pick profile -> spawn -> attach
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn: spawnChild } = require('child_process');
const axios = require('axios');
const { loadProfiles, pickProfileTUI } = require('./tui');
const { attach } = require('./attach');

// --- Configuration ---
// CCD_HOME / CCD_TOKEN_FILE overrides exist for tests; defaults match the real layout.
const CONFIG_DIR = process.env.CCD_HOME || path.join(os.homedir(), '.ccd');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CCH_TOKEN_FILE = process.env.CCD_TOKEN_FILE || path.join(os.homedir(), '.cch', 'token');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
const LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');
const SOCK_FILE = path.join(CONFIG_DIR, 'daemon.sock');

function loadConfig() {
    if (fs.existsSync(CCH_TOKEN_FILE)) {
        const data = fs.readFileSync(CCH_TOKEN_FILE, 'utf-8').trim();
        const parts = data.split('|');
        if (parts.length === 2) {
            return { server: parts[0], token: parts[1] };
        }
    }
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error('Not connected. Run: node index.js connect <url>');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig(server, token) {
    const cchDir = path.dirname(CCH_TOKEN_FILE);
    fs.mkdirSync(cchDir, { recursive: true });
    fs.writeFileSync(CCH_TOKEN_FILE, `${server}|${token}`);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ server, token }, null, 2));
}

// --- Auth ---
async function bootstrap(server, token, hostname) {
    const resp = await axios.post(`${server}/v1/auth/bootstrap`, { token, hostname }, { timeout: 15000 });
    return resp.data.token;
}

// --- IPC client ---
// Sends one newline-delimited JSON command and resolves with the first response line.
function ipcCall(msg, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(SOCK_FILE);
        let buffer = '';
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            sock.destroy();
            reject(new Error('ipc timeout'));
        }, timeoutMs);

        sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
        sock.on('data', (chunk) => {
            buffer += chunk.toString('utf-8');
            const idx = buffer.indexOf('\n');
            if (idx < 0) return;
            if (done) return;
            done = true;
            clearTimeout(timer);
            sock.end();
            try {
                resolve(JSON.parse(buffer.slice(0, idx).trim()));
            } catch (e) {
                reject(new Error('invalid response from daemon'));
            }
        });
        sock.on('error', (e) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(e);
        });
    });
}

async function isDaemonAlive() {
    try {
        const resp = await ipcCall({ cmd: 'status' }, 1500);
        return !!resp.ok;
    } catch (e) {
        return false;
    }
}

function startDaemon() {
    if (isProcessRunning()) {
        throw new Error('daemon already running (pid file exists). Use "node index.js stop" first, or delete ' + PID_FILE + ' if stale.');
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const logFd = fs.openSync(LOG_FILE, 'a');
    const child = spawnChild(process.execPath, [path.join(__dirname, 'daemon.js')], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    console.log(`daemon starting (pid ${child.pid}), log: ${LOG_FILE}`);
}

function isProcessRunning() {
    if (!fs.existsSync(PID_FILE)) return false;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

async function ensureDaemon() {
    if (await isDaemonAlive()) return;
    startDaemon();
    // Wait for the IPC socket to come up
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (await isDaemonAlive()) return;
    }
    throw new Error(`daemon failed to start; check log: ${LOG_FILE}`);
}

function printSessions(sessions) {
    if (!sessions.length) {
        console.log('no sessions');
        return;
    }
    for (const s of sessions) {
        const title = s.title ? ` "${s.title}"` : '';
        const csid = s.claudeSessionId ? ` claude=${s.claudeSessionId.slice(0, 8)}` : '';
        console.log(`${s.sessionId} [${s.state}] ${s.profile}${csid}${title} (${s.cwd})`);
    }
}

// --- Commands ---
async function cmdConnect(url) {
    if (!url) { console.error('Usage: node index.js connect <url>'); process.exit(1); }
    const m = url.match(/^(https?:\/\/[^/]+)(?:\/connect)?\?token=(.+)$/);
    if (!m) { console.error('Invalid URL format'); process.exit(1); }
    saveConfig(m[1], m[2]);
    console.log(`Connected to ${m[1]}`);
}

async function cmdStart() {
    if (await isDaemonAlive()) {
        console.error('daemon already running');
        process.exit(1);
    }
    startDaemon();
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (await isDaemonAlive()) {
            console.log('daemon is up');
            return;
        }
    }
    console.error(`daemon did not come up; check log: ${LOG_FILE}`);
    process.exit(1);
}

async function cmdStop() {
    try {
        await ipcCall({ cmd: 'shutdown' }, 3000);
        // Wait until the daemon actually exits (it replies before cleaning up)
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 100));
            if (!(await isDaemonAlive())) {
                console.log('daemon stopped');
                return;
            }
        }
        console.error('daemon did not exit after shutdown command');
        process.exit(1);
    } catch (e) {
        // fall back to pid kill
    }
    if (isProcessRunning()) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
        process.kill(pid, 'SIGTERM');
        console.log(`sent SIGTERM to daemon (pid ${pid})`);
        return;
    }
    console.log('daemon not running');
}

async function cmdStatus() {
    if (!(await isDaemonAlive())) {
        console.error('daemon not running. Start with: node index.js start');
        process.exit(1);
    }
    const status = await ipcCall({ cmd: 'status' });
    const list = await ipcCall({ cmd: 'list' });
    console.log(`uptime: ${status.uptime}s  sessions: ${status.sessionCount}  server: ${status.serverConnected ? 'connected' : 'disconnected'}  pty: ${status.ptyBackend || 'unknown'}`);
    printSessions(list.sessions || []);
}

async function cmdLs() {
    if (!(await isDaemonAlive())) {
        console.error('daemon not running. Start with: node index.js start');
        process.exit(1);
    }
    const list = await ipcCall({ cmd: 'list' });
    printSessions(list.sessions || []);
}

async function cmdAttach(sessionId) {
    if (!sessionId) { console.error('Usage: node index.js attach <sessionId>'); process.exit(1); }
    await ensureDaemon();
    const result = await attach(sessionId);
    if (result === 'detached') {
        console.log(`\ndetached; session still running, re-attach: node index.js attach ${sessionId}`);
    }
}

async function cmdSpawn(profileName, cwd) {
    if (!profileName) { console.error('Usage: node index.js spawn <profileName> [cwd]'); process.exit(1); }
    const profiles = loadProfiles();
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) {
        console.error(`profile '${profileName}' not found. Available: ${profiles.map(p => p.name).join(', ') || '(none)'}`);
        process.exit(1);
    }
    await ensureDaemon();
    const resp = await ipcCall({
        cmd: 'spawn',
        profile,
        cwd: cwd || process.cwd(),
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        resume: !!profile._continue,
    });
    if (!resp.ok) {
        console.error(`spawn failed: ${resp.error}`);
        process.exit(1);
    }
    console.log(`session: ${resp.sessionId}`);
    const result = await attach(resp.sessionId);
    if (result === 'detached') {
        console.log(`\ndetached; session still running, re-attach: node index.js attach ${resp.sessionId}`);
    }
}

async function cmdDefault() {
    await ensureDaemon();
    const profiles = loadProfiles();
    const profile = await pickProfileTUI(profiles);
    const resp = await ipcCall({
        cmd: 'spawn',
        profile,
        cwd: process.cwd(),
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        resume: !!profile._continue,
    });
    if (!resp.ok) {
        console.error(`spawn failed: ${resp.error}`);
        process.exit(1);
    }
    const result = await attach(resp.sessionId);
    if (result === 'detached') {
        console.log(`\ndetached; session still running, re-attach: node index.js attach ${resp.sessionId}`);
    }
}

// --- Main ---
async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0];

    switch (cmd) {
        case 'connect': return cmdConnect(args[1]);
        case 'start': return cmdStart();
        case 'stop': return cmdStop();
        case 'status': return cmdStatus();
        case 'ls': return cmdLs();
        case 'attach': return cmdAttach(args[1]);
        case 'spawn': return cmdSpawn(args[1], args[2]);
        case undefined: return cmdDefault();
        default:
            console.error(`unknown command: ${cmd}`);
            console.error('commands: connect | start | stop | status | ls | attach <id> | spawn <profile> [cwd]');
            process.exit(1);
    }
}

module.exports = {
    loadConfig,
    saveConfig,
    bootstrap,
    ipcCall,
    CONFIG_DIR,
    CONFIG_FILE,
    CCH_TOKEN_FILE,
    PID_FILE,
    LOG_FILE,
    SOCK_FILE,
};

if (require.main === module) {
    main().catch(e => { console.error(e.message || e); process.exit(1); });
}
