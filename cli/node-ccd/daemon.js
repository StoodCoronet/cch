// ccd daemon: long-running process that owns all claude PTY sessions,
// bridges them to the server over Socket.IO, and exposes a local IPC
// (unix socket, newline-delimited JSON) for index.js / attach.js.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const util = require('util');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const io = require('socket.io-client');
const axios = require('axios');
const {
    createPty,
    getPtyBackendName,
    JsonlWatcher,
    getProjectDirName,
    findLatestJsonl,
    listConversations,
    listAllConversations,
    listDirectories,
} = require('./session');
const { loadConfig, bootstrap, CONFIG_DIR, PID_FILE, LOG_FILE, SOCK_FILE } = require('./index');
const { loadProfiles } = require('./tui');

// --- Logging: everything goes to ~/.ccd/daemon.log, never stdout ---
fs.mkdirSync(CONFIG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function logLine(level, args) {
    logStream.write(`${new Date().toISOString()} ${level} ${util.format(...args)}\n`);
}
console.log = (...args) => logLine('INFO', args);
console.warn = (...args) => logLine('WARN', args);
console.error = (...args) => logLine('ERROR', args);

const CLAUDE_BIN = process.env.CCD_CLAUDE_BIN ||
    path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

const startedAt = Date.now();
const sessions = new Map(); // sessionId -> session object
const pendingPermissions = new Map(); // reqId -> pending permission request

let server = null;
let authToken = null;
let socket = null;
const hostname = os.hostname();
let lastSocketReauth = 0;

// --- REST helper with auth self-healing ---
// The authToken is bootstrapped once at startup and cached. It goes stale
// when the account is reset server-side or when `connect <new url>` replaced
// the config while the daemon kept running — every REST call then 401s
// forever. On 401 we re-read the config (it may carry a new token),
// re-bootstrap, and retry the request once. A second 401 propagates.
let isAuthenticated = false;

function isAuthError(e) {
    return !!(e && e.response && e.response.status === 401);
}

let reauthPromise = null;
// Concurrent 401s share one bootstrap round-trip.
function refreshAuthOnce(reason) {
    if (!reauthPromise) {
        reauthPromise = (async () => {
            console.log(`re-authenticating (${reason})`);
            try {
                const config = loadConfig();
                server = config.server;
                authToken = await bootstrap(server, config.token, hostname);
                isAuthenticated = true;
                console.log('re-authenticated OK');
                // The account may have been recreated — re-register the machine
                // row so /v1/machines and the web device picker recover too.
                registerMachine().catch(() => {});
                return true;
            } catch (e) {
                isAuthenticated = false;
                if (isAuthError(e)) {
                    console.error('re-auth failed: bootstrap token rejected (401). The account may have been reset — run: node index.js connect <url>');
                } else {
                    console.error(`re-auth failed: ${e.message}`);
                }
                return false;
            }
        })().finally(() => { reauthPromise = null; });
    }
    return reauthPromise;
}

async function restRequest(method, path, body) {
    try {
        const resp = await axios({
            method,
            url: `${server}${path}`,
            data: body,
            headers: { Authorization: `Bearer ${authToken}` },
            timeout: 10000,
        });
        return resp.data;
    } catch (e) {
        if (!isAuthError(e)) throw e;
        console.warn(`REST ${method} ${path} got 401; attempting re-auth`);
        if (!(await refreshAuthOnce(`401 on ${method} ${path}`))) throw e;
        // Retry exactly once with the fresh token; a second 401 propagates
        const resp = await axios({
            method,
            url: `${server}${path}`,
            data: body,
            headers: { Authorization: `Bearer ${authToken}` },
            timeout: 10000,
        });
        return resp.data;
    }
}

// --- Server session / message sync ---
async function createServerSession(session) {
    // Fresh spawns get a unique pending tag (two claude processes in the same
    // cwd must not collide on the server, which dedupes sessions by tag).
    // Once claude reveals its sessionId the tag is rewritten via PATCH.
    session.tagPending = !session.claudeSessionId;
    const tag = session.claudeSessionId
        ? `${getProjectDirName(session.cwd)}-${session.claudeSessionId.slice(0, 8)}`
        : `${getProjectDirName(session.cwd)}-pending-${session.localId.slice(-8)}`;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const data = await restRequest('post', '/v1/sessions', {
                tag,
                metadata: hostname,
            });
            return data.session.id;
        } catch (e) {
            lastErr = e;
            console.error(`createServerSession attempt ${attempt + 1} failed: ${e.message}`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw lastErr;
}

// Rewrite the server session tag to include the claudeSessionId (fire-and-forget).
// Only runs while the row carries a pending tag: rows created for a specific
// conversation (resume) keep that tag even when claude forks — the user resumed
// THAT conversation and expects the row to continue.
async function updateServerTag(session) {
    if (!session.serverReady || !session.claudeSessionId || !session.tagPending) return;
    const tag = `${getProjectDirName(session.cwd)}-${session.claudeSessionId.slice(0, 8)}`;
    try {
        await restRequest('patch', `/v1/sessions/${session.sessionId}/tag`, { tag });
        session.tagPending = false;
        console.log(`server tag aligned: ${tag}`);
    } catch (e) {
        console.error(`updateServerTag failed: ${e.message}`);
    }
}

async function postMessage(session, role, content, metadata = {}) {
    if (!session.serverReady) {
        session.pendingMessages.push({ role, content, metadata });
        return;
    }
    try {
        await restRequest('post', `/v1/sessions/${session.sessionId}/plaintext-messages`, {
            role, content, metadata,
        });
    } catch (e) {
        console.error(`postMessage error (session ${session.sessionId}): ${e.message}`);
    }
}

function sessionMeta(session) {
    return {
        claudeSessionId: session.claudeSessionId || null,
        title: session.title || null,
        cwd: session.cwd,
        deviceName: hostname,
    };
}

function emitTermRegister(session) {
    if (!socket || !socket.connected || !session.serverReady) return;
    socket.emit('term:register', {
        sessionId: session.sessionId,
        meta: sessionMeta(session),
        cols: session.cols,
        rows: session.rows,
    });
}

function emitTermMeta(session) {
    if (!socket || !socket.connected || !session.serverReady) return;
    socket.emit('term:meta', { sessionId: session.sessionId, meta: sessionMeta(session) });
}

function emitTermState(session, state, exitCode) {
    if (!socket || !socket.connected || !session.serverReady) return;
    const payload = { sessionId: session.sessionId, state };
    if (exitCode !== undefined) payload.exitCode = exitCode;
    socket.emit('term:state', payload);
}

// Finalize a session once we know the claudeSessionId (from the jsonl
// watcher, or immediately in resume mode): create the server session,
// re-key the session table on the server CUID, register and flush buffers.
async function finalizeServerSession(session) {
    if (session.finalizing || session.serverReady) return;
    session.finalizing = true;
    try {
        const sessionId = await createServerSession(session);
        if (sessions.get(session.localId) === session) {
            sessions.delete(session.localId);
        }
        session.sessionId = sessionId;
        session.serverReady = true;
        sessions.set(sessionId, session);
        console.log(`session ready: ${sessionId} (claude=${session.claudeSessionId || 'unknown'}, profile=${session.profile.name})`);
        // Bump lastActiveAt/updatedAt so resumed sessions surface in the web
        // sidebar even before any new message arrives
        restRequest('post', `/v1/sessions/${sessionId}/activity`, {})
            .catch(e => console.error(`activity ping failed: ${e.message}`));
        emitTermRegister(session);
        emitTermMeta(session);
        // Flush permission requests that arrived before the server session
        // existed (perm:request carries the server sessionId)
        for (const entry of pendingPermissions.values()) {
            if (entry.session === session) emitPermRequest(entry);
        }
        // Flush buffered PTY output so early claude output reaches the server
        if (session.pendingOutput) {
            socket && socket.connected && socket.emit('term:output', { sessionId, data: session.pendingOutput });
            session.pendingOutput = '';
        }
        const pending = session.pendingMessages.splice(0);
        for (const m of pending) {
            await postMessage(session, m.role, m.content, m.metadata);
        }
        if (session.spawnResolve) {
            session.spawnResolve({ ok: true, sessionId });
            session.spawnResolve = null;
        }
    } catch (e) {
        console.error(`finalizeServerSession failed: ${e.message}`);
        if (session.spawnResolve) {
            session.spawnResolve({ ok: false, error: `failed to create server session: ${e.message}` });
            session.spawnResolve = null;
        }
        killSession(session, 'server session creation failed');
    } finally {
        session.finalizing = false;
    }
}

// --- Permission bridge (claude PreToolUse hook -> web) ---
// Each spawned session gets a generated claude settings file registering
// hook.js as a PreToolUse hook. The hook calls back over IPC (keyed by
// localId via CCD_SESSION_ID); we forward to the server as perm:request and
// wait for perm:respond. Timeout / disconnect -> 'ask', which makes the hook
// print nothing so claude shows its local TUI approval prompt.
function hookSettingsPath(localId) {
    return path.join(CONFIG_DIR, 'hooks', `${localId}.json`);
}

function writeHookSettings(localId) {
    fs.mkdirSync(path.join(CONFIG_DIR, 'hooks'), { recursive: true });
    const file = hookSettingsPath(localId);
    const settings = {
        hooks: {
            PreToolUse: [
                {
                    matcher: '*',
                    hooks: [{ type: 'command', command: `"${process.execPath}" "${path.join(__dirname, 'hook.js')}"`, timeout: 60 }],
                },
            ],
        },
    };
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    return file;
}

function removeHookSettings(localId) {
    try {
        fs.unlinkSync(hookSettingsPath(localId));
    } catch (e) { /* ignore */ }
}

function emitPermRequest(entry) {
    if (entry.sent || !entry.session.serverReady) return;
    if (!socket || !socket.connected) return;
    entry.sent = true;
    socket.emit('perm:request', {
        sessionId: entry.session.sessionId,
        reqId: entry.reqId,
        toolName: entry.toolName,
        input: entry.toolInput,
        meta: sessionMeta(entry.session),
    });
}

// IPC 'permission' handler: holds the response until the web decides or the
// 55s timeout fires (hook.js has the same cap; the hook prints nothing on
// 'ask' so claude falls back to its local prompt).
function handlePermissionRequest(msg) {
    // The hook knows the session by localId (CCD_SESSION_ID); the sessions
    // map may already be re-keyed on the server sessionId, so scan values.
    const session = [...sessions.values()].find(s => s.localId === msg.ccdSessionId);
    if (!session || session.state === 'exited') {
        return Promise.resolve({ ok: true, decision: 'ask' });
    }
    const reqId = crypto.randomUUID();
    return new Promise((resolve) => {
        const entry = {
            reqId,
            session,
            toolName: msg.toolName || null,
            toolInput: msg.toolInput !== undefined ? msg.toolInput : null,
            sent: false,
            settled: false,
            timer: null,
            settle: null,
        };
        entry.settle = (decision, source) => {
            if (entry.settled) return;
            entry.settled = true;
            clearTimeout(entry.timer);
            pendingPermissions.delete(reqId);
            console.log(`permission ${reqId} settled: ${decision} (${source})`);
            if (socket && socket.connected) {
                socket.emit('perm:resolve', { reqId, decision, source });
            }
            resolve({ ok: true, decision });
        };
        entry.timer = setTimeout(() => entry.settle('ask', 'timeout'), 55000);
        pendingPermissions.set(reqId, entry);
        console.log(`permission request ${reqId}: tool=${entry.toolName} (session=${session.sessionId || session.localId})`);
        emitPermRequest(entry);
    });
}

// --- Session lifecycle ---
// resumeId (an explicit claudeSessionId) takes priority over the resume bool,
// which keeps its original meaning: resume the latest jsonl for this cwd.
function spawnSession({ profile, cwd, cols, rows, resume, resumeId }) {
    const localId = 'tmp-' + crypto.randomUUID();
    const env = {
        ...process.env,
        ...(profile.env || {}),
        ...(profile.model ? { ANTHROPIC_MODEL: profile.model } : {}),
        ...(profile.base_url ? { ANTHROPIC_BASE_URL: profile.base_url } : {}),
        // The PreToolUse hook (hook.js) uses this to call back over IPC
        CCD_SESSION_ID: localId,
    };
    // The daemon is often started detached (no TTY), so process.env may lack
    // TERM or carry NO_COLOR — claude then renders without colors. Force a
    // color-capable terminal identity for the PTY child.
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    delete env.NO_COLOR;
    // Resume mode: the claudeSessionId is either given explicitly (resumeId)
    // or resolved from the latest jsonl file name for this cwd (resume bool).
    let resumeClaudeSessionId = resumeId || null;
    if (!resumeClaudeSessionId && resume) {
        const jsonlPath = findLatestJsonl(cwd);
        if (jsonlPath) resumeClaudeSessionId = path.basename(jsonlPath, '.jsonl');
    }
    const claudeArgs = [];
    if (profile.model) claudeArgs.push('--model', profile.model);
    if (profile.skip_permissions) claudeArgs.push('--dangerously-skip-permissions');
    if (resumeClaudeSessionId) claudeArgs.push('--resume', resumeClaudeSessionId);
    // Register our PreToolUse hook for this session (web permission bridge)
    const hookFile = writeHookSettings(localId);
    claudeArgs.push('--settings', hookFile);
    if (profile.extra_args && profile.extra_args.length) claudeArgs.push(...profile.extra_args);

    const session = {
        localId,
        sessionId: null,
        serverReady: false,
        finalizing: false,
        pty: null,
        watcher: null,
        cwd,
        profile,
        claudeSessionId: resumeClaudeSessionId,
        title: null,
        cols: cols || 80,
        rows: rows || 24,
        createdAt: Date.now(),
        state: 'running',
        exitCode: null,
        attachSockets: new Set(),
        pendingMessages: [],
        pendingOutput: '',
        spawnResolve: null,
        hookFile,
    };
    sessions.set(localId, session);

    const pty = createPty(CLAUDE_BIN, claudeArgs, { cwd, env, cols: session.cols, rows: session.rows });
    session.pty = pty;

    pty.onData((data) => {
        for (const conn of session.attachSockets) {
            try { conn.write(data); } catch (e) { /* ignore */ }
        }
        if (session.serverReady) {
            if (socket && socket.connected) socket.emit('term:output', { sessionId: session.sessionId, data });
        } else {
            // Buffer early output (claude startup banner) until register; cap at 64KB
            session.pendingOutput = (session.pendingOutput + data).slice(-65536);
        }
    });

    pty.onExit((code) => {
        session.state = 'exited';
        session.exitCode = code;
        // Do NOT stop the watcher here: claude sometimes replaces its process
        // (e.g. in-TUI /resume) — the old process exits but the conversation
        // lives on in a forked jsonl. Keep syncing messages until the session
        // is explicitly killed.
        console.log(`session process exited: ${session.sessionId || session.localId} code=${code} (watcher stays active)`);
        // If claude never produced a conversation (no jsonl, no messages), the
        // server row is an empty shell — remove it instead of polluting the
        // sidebar with a 0-msg pending session.
        if (!session.claudeSessionId && session.serverReady) {
            restRequest('delete', `/v1/sessions/${session.sessionId}`)
                .then(() => console.log(`empty session row deleted: ${session.sessionId}`))
                .catch(e => console.error(`delete empty session failed: ${e.message}`));
        }
        emitTermState(session, 'exited', code);
        for (const conn of session.attachSockets) {
            try { conn.write(`\r\n[ccd] session exited (code ${code})\r\n`); } catch (e) { /* ignore */ }
            try { conn.end(); } catch (e) { /* ignore */ }
        }
        session.attachSockets.clear();
        if (session.spawnResolve) {
            session.spawnResolve({ ok: false, error: `claude exited immediately (code ${code})` });
            session.spawnResolve = null;
        }
    });

    const watcher = new JsonlWatcher(cwd, {
        onClaudeSessionId: (id) => {
            if (session.claudeSessionId === id) return;
            session.claudeSessionId = id;
            console.log(`claudeSessionId detected: ${id} (cwd=${cwd})`);
            finalizeServerSession(session);
            emitTermMeta(session);
            // Align the server session tag with the claudeSessionId so a later
            // --resume of this conversation lands on the same server session.
            if (session.serverReady) {
                updateServerTag(session);
            }
        },
        onTitle: (title) => {
            session.title = title;
            emitTermMeta(session);
        },
        onMessage: (role, text, metadata) => {
            postMessage(session, role, text, metadata);
        },
    }, { expectedId: resumeClaudeSessionId || null });
    session.watcher = watcher;
    watcher.start();

    if (resumeClaudeSessionId) {
        // Resume mode: claudeSessionId known up front, create server session now
        finalizeServerSession(session);
    }

    return session;
}

function killSession(session, reason) {
    if (session.state === 'exited') return;
    console.log(`killing session ${session.sessionId || session.localId}: ${reason || ''}`);
    try { session.pty.kill(); } catch (e) { /* ignore */ }
    if (session.watcher) session.watcher.stop();
    removeHookSettings(session.localId);
    session.state = 'exited';
    emitTermState(session, 'exited');
    for (const conn of session.attachSockets) {
        try { conn.write(`\r\n[ccd] session killed\r\n`); } catch (e) { /* ignore */ }
        try { conn.end(); } catch (e) { /* ignore */ }
    }
    session.attachSockets.clear();
}

function findSession(id) {
    return sessions.get(id) || null;
}

// Shared session table shape for both the IPC `list` command and the
// `list-sessions` socket RPC.
function listSessionsPayload() {
    return [...sessions.values()]
        .filter(s => s.serverReady)
        .map(s => ({
            sessionId: s.sessionId,
            claudeSessionId: s.claudeSessionId,
            title: s.title,
            cwd: s.cwd,
            profile: s.profile.name,
            state: s.state,
            createdAt: s.createdAt,
        }));
}

// --- Socket.IO to server ---
// Register this machine so GET /v1/machines shows it to the web. Retries a
// few times but never blocks daemon startup.
async function registerMachine() {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await restRequest('post', '/v1/machines', {
                id: hostname,
                metadata: hostname,
            });
            console.log(`machine registered: ${hostname}`);
            return;
        } catch (e) {
            lastErr = e;
            console.error(`registerMachine attempt ${attempt + 1} failed: ${e.message}`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    console.error(`registerMachine gave up; machine will not appear in /v1/machines: ${lastErr.message}`);
}

// Heartbeat: the server marks a machine offline after 10 min without
// machine-alive, so emit every 60s while the socket is connected.
let heartbeatTimer = null;
function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
        if (!socket || !socket.connected) return;
        socket.emit('machine-alive', { machineId: hostname, time: Date.now() });
        console.log('machine-alive sent');
    }, 60000);
}

function connectServer() {
    socket = io(server, {
        path: '/v1/updates',
        auth: { token: authToken, clientType: 'machine-scoped', machineId: hostname },
        transports: ['websocket'],
    });

    socket.on('connect', () => {
        console.log(`server connected (${server})`);
        // The machine row may be gone (account reset, server wipe, web-side
        // machine delete) — registerMachine is create-or-load, so just
        // re-assert it on every (re)connect.
        registerMachine().catch(() => {});
        // Re-register all live sessions after (re)connect
        for (const session of sessions.values()) {
            if (session.serverReady) {
                emitTermRegister(session);
                emitTermMeta(session);
                emitTermState(session, session.state, session.exitCode === null ? undefined : session.exitCode);
            }
        }
        // Retry permission requests that couldn't be sent while disconnected
        for (const entry of pendingPermissions.values()) emitPermRequest(entry);
    });

    socket.on('disconnect', (reason) => {
        console.log(`server disconnected: ${reason}`);
    });
    socket.on('connect_error', (e) => {
        console.error(`server connect_error: ${e.message}`);
        // Auth failures ('Invalid authentication token' etc.) mean the cached
        // authToken is stale: re-bootstrap and reconnect with the fresh token.
        // Throttled so a persistently-rejected token can't spin a reconnect loop.
        if (!/auth|401|unauthor/i.test(e.message || '')) return;
        const now = Date.now();
        if (now - lastSocketReauth < 60000) return;
        lastSocketReauth = now;
        refreshAuthOnce(`socket ${e.message}`).then((ok) => {
            if (!ok || !socket) return;
            socket.auth = { token: authToken, clientType: 'machine-scoped', machineId: hostname };
            socket.disconnect();
            socket.connect();
        });
    });

    socket.on('term:input', (payload) => {
        const session = payload && findSession(payload.sessionId);
        if (!session || session.state === 'exited') return;
        session.pty.write(String(payload.data));
    });

    socket.on('term:resize', (payload) => {
        const session = payload && findSession(payload.sessionId);
        if (!session || session.state === 'exited') return;
        session.cols = payload.cols;
        session.rows = payload.rows;
        session.pty.resize(payload.cols, payload.rows);
    });

    // Web's answer to a perm:request, forwarded by the server
    socket.on('perm:respond', (payload) => {
        const entry = payload && pendingPermissions.get(payload.reqId);
        if (!entry) return;
        const decision = payload.decision === 'allow' || payload.decision === 'deny' ? payload.decision : 'ask';
        entry.settle(decision, 'web');
    });

    socket.on('ccd:rpc', (msg) => {
        handleRpc(msg).then((resp) => {
            if (!resp) return;
            if (socket && socket.connected) {
                socket.emit('ccd:rpc-result', resp);
            } else {
                console.warn(`ccd:rpc result dropped (socket disconnected): reqId=${resp.reqId}`);
            }
        }).catch((e) => {
            console.error(`ccd:rpc handler error: ${e.stack || e.message}`);
        });
    });
}

// --- Socket RPC (ccd:rpc / ccd:rpc-result) ---
// The server relays web-originated requests to the machine-scoped socket as
// {reqId, method, params}; we answer with {reqId, result} or {reqId, error}.
async function handleRpc(msg) {
    const reqId = msg && msg.reqId;
    if (!reqId) return null;
    try {
        const result = await handleRpcMethod(msg.method, msg.params || {});
        return { reqId, result };
    } catch (e) {
        return { reqId, error: e.message || String(e) };
    }
}

async function handleRpcMethod(method, params) {
    switch (method) {
        case 'list-profiles': {
            // Sanitized: env and other sensitive profile fields stay local.
            const profiles = loadProfiles().map(p => ({
                name: p.name,
                description: p.description,
                model: p.model,
                base_url: p.base_url,
                backend: p.backend,
            }));
            return { profiles };
        }
        case 'list-conversations': {
            if (!params.cwd) throw new Error('list-conversations requires cwd');
            return { conversations: listConversations(params.cwd) };
        }
        case 'list-all-conversations': {
            return { conversations: listAllConversations() };
        }
        case 'list-directories': {
            return { dirs: listDirectories(params.prefix || '') };
        }
        case 'list-sessions': {
            if (!isAuthenticated) throw new Error('daemon is not authenticated with the server — run: node index.js connect <url>');
            return { sessions: listSessionsPayload() };
        }
        case 'spawn': {
            if (!isAuthenticated) throw new Error('daemon is not authenticated with the server — run: node index.js connect <url>');
            const { cwd, profileName, resumeId } = params;
            if (!cwd || !profileName) throw new Error('spawn requires cwd and profileName');
            let cwdStat = null;
            try {
                cwdStat = fs.statSync(cwd);
            } catch (e) { /* fall through */ }
            if (!cwdStat || !cwdStat.isDirectory()) throw new Error(`cwd does not exist: ${cwd}`);
            const profile = loadProfiles().find(p => p.name === profileName);
            if (!profile) throw new Error(`profile not found: ${profileName}`);
            const session = spawnSession({ profile, cwd, cols: params.cols, rows: params.rows, resumeId });
            return new Promise((resolve, reject) => {
                session.spawnResolve = (resp) => {
                    if (resp.ok) resolve({ sessionId: resp.sessionId });
                    else reject(new Error(resp.error));
                };
                finalizeServerSession(session);
            });
        }
        case 'kill': {
            const session = findSession(params.sessionId);
            if (!session) throw new Error('session not found');
            killSession(session, 'rpc kill');
            return {};
        }
        default:
            throw new Error(`unknown method: ${method}`);
    }
}

// --- IPC (unix socket, newline-delimited JSON) ---
async function handleCommand(conn, msg) {
    switch (msg.cmd) {
        case 'spawn': {
            const { profile, cwd, cols, rows, resume, resumeId } = msg;
            if (!profile || !cwd) return { ok: false, error: 'spawn requires profile and cwd' };
            const session = spawnSession({ profile, cwd, cols, rows, resume, resumeId });
            return new Promise((resolve) => {
                session.spawnResolve = resolve;
                // Create the server session immediately: the PTY terminal is
                // interactable from the web right away. The claudeSessionId only
                // appears once claude writes its jsonl (first user message) and
                // follows via term:meta.
                finalizeServerSession(session);
            });
        }
        case 'list': {
            return { ok: true, sessions: listSessionsPayload() };
        }
        case 'list-conversations': {
            if (!msg.cwd) return { ok: false, error: 'list-conversations requires cwd' };
            return { ok: true, conversations: listConversations(msg.cwd) };
        }
        case 'kill': {
            const session = findSession(msg.sessionId);
            if (!session) return { ok: false, error: 'session not found' };
            killSession(session, 'ipc kill');
            return { ok: true };
        }
        case 'permission': {
            // Holds the IPC response until the web decides or the 55s
            // timeout fires — see handlePermissionRequest.
            return handlePermissionRequest(msg);
        }
        case 'status': {
            return {
                ok: true,
                uptime: Math.floor((Date.now() - startedAt) / 1000),
                sessionCount: sessions.size,
                serverConnected: !!(socket && socket.connected),
                ptyBackend: getPtyBackendName(),
            };
        }
        case 'resize': {
            const session = findSession(msg.sessionId);
            if (!session) return { ok: false, error: 'session not found' };
            if (session.state !== 'exited') {
                session.cols = msg.cols;
                session.rows = msg.rows;
                session.pty.resize(msg.cols, msg.rows);
            }
            return { ok: true };
        }
        case 'attach': {
            const session = findSession(msg.sessionId);
            if (!session) return { ok: false, error: 'no such session' };
            // Refuse to attach to a dead PTY: the client would switch to raw
            // stream mode against a dead end and appear to hang.
            if (session.state !== 'running') {
                const code = session.exitCode === null || session.exitCode === undefined ? '?' : session.exitCode;
                return { ok: false, error: `session exited (code ${code}) — resume it instead` };
            }
            if (msg.cols && msg.rows) {
                session.cols = msg.cols;
                session.rows = msg.rows;
                session.pty.resize(msg.cols, msg.rows);
            }
            // Mark the connection as attached: after the {ok} line the socket
            // switches to raw byte stream mode (see handleConnection).
            return { ok: true, _attach: session };
        }
        case 'shutdown': {
            setTimeout(() => shutdown(0), 100);
            return { ok: true };
        }
        default:
            return { ok: false, error: `unknown command: ${msg.cmd}` };
    }
}

function handleConnection(conn) {
    let buffer = Buffer.alloc(0);
    let attachedSession = null;
    const decoder = new StringDecoder('utf8');

    conn.on('data', (chunk) => {
        if (attachedSession) {
            // Raw mode: bytes go straight into the PTY stdin
            attachedSession.pty.write(decoder.write(chunk));
            return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        let idx;
        while ((idx = buffer.indexOf(0x0a)) >= 0) {
            const line = buffer.slice(0, idx).toString('utf-8').trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                conn.write(JSON.stringify({ ok: false, error: 'invalid JSON' }) + '\n');
                continue;
            }
            handleCommand(conn, msg).then((resp) => {
                const attachSession = resp && resp._attach;
                if (attachSession) delete resp._attach;
                conn.write(JSON.stringify(resp) + '\n', () => {
                    if (attachSession) {
                        attachedSession = attachSession;
                        attachedSession.attachSockets.add(conn);
                        // Flush any leftover bytes after the header into the PTY
                        if (buffer.length) {
                            attachedSession.pty.write(decoder.write(buffer));
                            buffer = Buffer.alloc(0);
                        }
                    }
                });
            }).catch((e) => {
                console.error(`ipc command error: ${e.stack || e.message}`);
                try { conn.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); } catch (e2) { /* ignore */ }
            });
        }
    });

    conn.on('close', () => {
        if (attachedSession) attachedSession.attachSockets.delete(conn);
    });
    conn.on('error', () => {
        if (attachedSession) attachedSession.attachSockets.delete(conn);
    });
}

function startIpc() {
    try { fs.unlinkSync(SOCK_FILE); } catch (e) { /* ignore */ }
    const srv = net.createServer(handleConnection);
    srv.listen(SOCK_FILE);
    srv.on('error', (e) => {
        console.error(`ipc server error: ${e.message}`);
        process.exit(1);
    });
    console.log(`ipc listening on ${SOCK_FILE}`);
}

// --- Shutdown ---
function shutdown(code) {
    console.log('daemon shutting down');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const session of sessions.values()) {
        try { session.pty.kill(); } catch (e) { /* ignore */ }
        if (session.watcher) session.watcher.stop();
        removeHookSettings(session.localId);
    }
    if (socket) socket.disconnect();
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(SOCK_FILE); } catch (e) { /* ignore */ }
    process.exit(code);
}

// --- Main ---
async function main() {
    // Refuse to start twice
    if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
        if (pid) {
            try {
                process.kill(pid, 0);
                console.error(`daemon already running (pid ${pid})`);
                process.exit(1);
            } catch (e) {
                // stale pid file, continue
            }
        }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));

    const config = loadConfig();
    server = config.server;
    authToken = await bootstrap(server, config.token, hostname);
    isAuthenticated = true;
    await registerMachine();
    console.log(`daemon started (pid ${process.pid}, pty backend: ${getPtyBackendName()})`);

    connectServer();
    startHeartbeat();
    startIpc();

    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
    process.on('uncaughtException', (e) => console.error(`uncaughtException: ${e.stack || e.message}`));
    process.on('unhandledRejection', (e) => console.error(`unhandledRejection: ${e && (e.stack || e.message) || e}`));
}

main().catch((e) => {
    console.error(`fatal: ${e.stack || e.message}`);
    process.exit(1);
});
