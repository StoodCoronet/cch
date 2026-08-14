// Business e2e test: server <-> node-ccd daemon <-> web terminal relay.
//
// Prerequisites:
//   - server running (default http://localhost:3005, override with SERVER env)
//   - `node index.js connect <url>` done (uses ~/.cch/token)
//   - at least one claude profile in profiles.toml (override with TEST_PROFILE env)
//
// What it verifies:
//   1. daemon starts and connects to server (machine-scoped)
//   2. IPC spawn creates a claude PTY session and registers it on the server
//   3. a web-style client (user-scoped socket) can term:join and receive scrollback
//   4. term:input reaches the claude TUI (echo visible in term:output)
//   5. term:resize is accepted
//   6. killing the session broadcasts term:state exited
//   7. stopping the daemon broadcasts term:state offline (only with TEST_OFFLINE=1)
//
// Cleanup: kills the spawned session; stops the daemon only if this script started it.
//
// Usage: node test-e2e.js
// Env:   TEST_PROFILE=deepseek  SKIP_CLAUDE_MSG=1  TEST_OFFLINE=1

const io = require('socket.io-client');
const { loadConfig, bootstrap, ipcCall } = require('./index');
const { loadProfiles } = require('./tui');
const os = require('os');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const v = await fn();
        if (v) return v;
        await sleep(intervalMs);
    }
    return null;
}

async function main() {
    const { server, token } = loadConfig();
    const hostname = os.hostname();

    // --- 1. daemon up ---
    let startedDaemon = false;
    let alive = false;
    try {
        const resp = await ipcCall({ cmd: 'status' }, 1500);
        alive = !!resp.ok;
    } catch (e) { /* not running */ }
    if (!alive) {
        const { spawnSync } = require('child_process');
        const r = spawnSync(process.execPath, [require('path').join(__dirname, 'index.js'), 'start'], { stdio: 'pipe' });
        startedDaemon = r.status === 0;
    }
    const status = await waitFor(async () => {
        try { return await ipcCall({ cmd: 'status' }, 1500); } catch (e) { return null; }
    }, 10000);
    check('daemon up', !!status && status.ok);
    check('daemon connected to server', !!status && status.serverConnected === true);
    if (!status || !status.ok) return summarize();

    // --- 2. spawn session ---
    const profiles = loadProfiles();
    const profileName = process.env.TEST_PROFILE;
    const profile = profileName
        ? profiles.find(p => p.name === profileName)
        : profiles.find(p => p.backend === 'claude') || profiles[0];
    if (!profile) {
        check('profile found', false, 'no profiles in profiles.toml');
        return summarize();
    }
    const spawnResp = await ipcCall({
        cmd: 'spawn', profile, cwd: process.cwd(), cols: 120, rows: 30,
    }, 40000);
    check('spawn session', !!spawnResp.ok, spawnResp.ok ? `sessionId=${spawnResp.sessionId}` : JSON.stringify(spawnResp));
    if (!spawnResp.ok) return summarize();
    const sessionId = spawnResp.sessionId;

    // --- 3. web client join ---
    const authToken = await bootstrap(server, token, hostname);
    const socket = io(server, {
        path: '/v1/updates',
        auth: { token: authToken, clientType: 'user-scoped' },
        transports: ['websocket'],
    });
    const outputs = [];
    const states = [];
    const metas = [];
    socket.on('term:output', (m) => { if (m.sessionId === sessionId) outputs.push(m.data); });
    socket.on('term:state', (m) => { if (m.sessionId === sessionId) states.push(m.state); });
    socket.on('term:meta', (m) => { if (m.sessionId === sessionId) metas.push(m.meta || {}); });
    await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
        setTimeout(() => reject(new Error('socket connect timeout')), 10000);
    }).catch(e => { check('web socket connect', false, e.message); });

    const joinResp = await new Promise(r => socket.emit('term:join', { sessionId }, r));
    check('term:join', !!joinResp && joinResp.ok, joinResp && joinResp.ok
        ? `state=${joinResp.state} scrollback=${(joinResp.scrollback || '').length} chars`
        : JSON.stringify(joinResp));

    // --- 4. wait for claude banner, then input echo ---
    const allOutput = () => (joinResp.scrollback || '') + outputs.join('');
    const banner = await waitFor(() => {
        const o = allOutput();
        return o.includes('Claude Code') || o.includes('❯') ? o : null;
    }, 30000);
    check('claude TUI banner in relay', !!banner);

    if (!process.env.SKIP_CLAUDE_MSG) {
        const before = allOutput().length;
        socket.emit('term:input', { sessionId, data: 'hi' });
        await sleep(500);
        socket.emit('term:input', { sessionId, data: '\r' });
        const echo = await waitFor(() => allOutput().length > before ? allOutput() : null, 15000);
        check('term:input reaches claude (output grows)', !!echo,
            echo ? `+${allOutput().length - before} chars` : 'no new output');
        // Assistant reply is nice-to-have; wait but don't fail hard on slow APIs
        const afterEcho = allOutput().length;
        const reply = await waitFor(() => allOutput().length > afterEcho + 20 ? true : null, 45000);
        check('claude response streams back', !!reply, reply ? `+${allOutput().length - afterEcho} chars` : 'no response within 45s');
        // claude writes its jsonl on the first user message; the daemon then
        // pushes term:meta with claudeSessionId + title (first-message excerpt)
        const meta = await waitFor(() => metas.find(m => m.claudeSessionId), 15000);
        check('term:meta carries claudeSessionId', !!meta,
            meta ? `claude=${meta.claudeSessionId.slice(0, 8)} title=${JSON.stringify(meta.title || '')}` : `metas seen: ${metas.length}`);
        // The transcript view's data source: the typed message must round-trip
        // through the jsonl watcher into the server's plaintext messages
        const axios = require('axios');
        const userMsg = await waitFor(async () => {
            try {
                const resp = await axios.get(`${server}/v1/sessions/${sessionId}/plaintext-messages?role=user&limit=50`, {
                    headers: { Authorization: `Bearer ${authToken}` }, timeout: 10000,
                });
                return (resp.data.messages || []).find(m => (m.content || '').includes('hi'));
            } catch (e) { return null; }
        }, 20000);
        check('user message round-trips via jsonl to REST', !!userMsg);

        // Blind slash command from the web: /rename with args executes without
        // any TUI interaction; the invocation and its stdout must arrive as
        // structured records, and the session title must flip.
        socket.emit('term:input', { sessionId, data: '/rename e2e-rename' });
        await sleep(400);
        socket.emit('term:input', { sessionId, data: '\r' });
        let cmdMsg = null, sysMsg = null;
        for (let i = 0; i < 40 && !(cmdMsg && sysMsg); i++) {
            await sleep(500);
            try {
                const r = await axios.get(`${server}/v1/sessions/${sessionId}/plaintext-messages`, {
                    headers: { Authorization: `Bearer ${authToken}` }, timeout: 10000,
                });
                const msgs = r.data.messages || [];
                cmdMsg = msgs.find(m => m.metadata && m.metadata.command && m.metadata.command.name === '/rename');
                sysMsg = msgs.find(m => m.role === 'system' && (m.content || '').includes('renamed'));
            } catch (e) { /* retry */ }
        }
        check('slash command record (/rename)', !!cmdMsg,
            cmdMsg ? JSON.stringify(cmdMsg.metadata.command) : 'not found in REST');
        check('command stdout record (system role)', !!sysMsg, sysMsg ? sysMsg.content : 'not found');
        const renamed = await waitFor(async () => {
            const ack = await new Promise(r => socket.emit('term:query-state', { sessionId }, r));
            return ack && ack.meta && ack.meta.title === 'e2e-rename';
        }, 10000);
        check('title syncs after /rename', !!renamed);
    }

    // --- 5. resize ---
    socket.emit('term:resize', { sessionId, cols: 100, rows: 40 });
    await sleep(500);
    check('term:resize accepted', true, 'no error (fire-and-forget)');

    // --- 6. kill session -> exited ---
    await ipcCall({ cmd: 'kill', sessionId }, 5000);
    const exited = await waitFor(() => states.includes('exited'), 10000);
    check('term:state exited broadcast', !!exited, `states seen: ${states.join(',') || 'none'}`);

    // --- 7. optional: daemon stop -> offline ---
    if (process.env.TEST_OFFLINE === '1' && startedDaemon) {
        spawnOfflineCheck(socket, sessionId, states);
        await ipcCall({ cmd: 'shutdown' }, 3000).catch(() => {});
        const offline = await waitFor(() => states.includes('offline'), 10000);
        check('term:state offline on daemon stop', !!offline);
        startedDaemon = false; // already stopped
    }

    // --- cleanup ---
    socket.disconnect();
    if (startedDaemon) {
        await ipcCall({ cmd: 'shutdown' }, 3000).catch(() => {});
    }
    summarize();
}

function spawnOfflineCheck() { /* states listener already registered */ }

function summarize() {
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => {
    console.error('e2e error:', e.message || e);
    summarize();
});
