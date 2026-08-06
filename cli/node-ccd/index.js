const { query } = require('@anthropic-ai/claude-agent-sdk');
const io = require('socket.io-client');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { loadProfiles, pickProfileTUI } = require('./tui');

// --- Configuration ---
const CONFIG_DIR = path.join(os.homedir(), '.ccd');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CCH_TOKEN_FILE = path.join(os.homedir(), '.cch', 'token');

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

async function pickProfile(profiles) {
    return pickProfileTUI(profiles);
}

// --- Auth ---
async function bootstrap(server, token, hostname) {
    const resp = await axios.post(`${server}/v1/auth/bootstrap`, { token, hostname }, { timeout: 15000 });
    return resp.data.token;
}

// --- Session tracking ---
function getTrackDir() {
    return path.join(os.homedir(), '.ccd', 'node-ccd_sessions');
}

function writeTrack(sessionId, claudeSessionId, cwd, hostname, profileName) {
    const dir = getTrackDir();
    fs.mkdirSync(dir, { recursive: true });
    const track = { sessionId, claudeSessionId, cwd, hostname, profile: profileName, createdAt: Date.now() };
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(track, null, 2));
}

// --- JSONL monitoring ---
function getClaudeProjectsDir() {
    return path.join(os.homedir(), '.claude', 'projects');
}

function getProjectDirName(cwd) {
    return cwd.replace(/\//g, '-').replace(/_/g, '-');
}

function findLatestJsonl(cwd) {
    const projDir = path.join(getClaudeProjectsDir(), getProjectDirName(cwd));
    if (!fs.existsSync(projDir)) return null;
    const files = fs.readdirSync(projDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, path: path.join(projDir, f), mtime: fs.statSync(path.join(projDir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].path : null;
}

function extractMessageText(msg) {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
            if (block.type === 'text') parts.push(block.text || '');
            else if (block.type === 'tool_use') parts.push(`[tool_use: ${block.name} ${JSON.stringify(block.input)}]`);
            else if (block.type === 'tool_result') parts.push(`[tool_result: ${truncateForDisplay(block.content || '', 500)}]`);
        }
        return parts.join('\n');
    }
    return typeof content === 'string' ? content : '';
}

function truncateForDisplay(s, maxLen) {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '… +' + (s.length - maxLen) + ' chars';
}

// --- Main ---
async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0];

    if (cmd === 'connect') {
        const url = args[1];
        if (!url) { console.error('Usage: node index.js connect <url>'); process.exit(1); }
        const m = url.match(/^(https?:\/\/[^/]+)(?:\/connect)?\?token=(.+)$/);
        if (!m) { console.error('Invalid URL format'); process.exit(1); }
        saveConfig(m[1], m[2]);
        console.log(`Connected to ${m[1]}`);
        return;
    }

    const { server, token } = loadConfig();
    const hostname = os.hostname();
    const authToken = await bootstrap(server, token, hostname);
    const cwd = process.cwd();

    // TUI: pick profile
    const profiles = loadProfiles();
    const profile = await pickProfile(profiles);

    // Connect to server Socket.IO for realtime messages
    const socket = io(server, {
        path: '/v1/updates',
        auth: { token: authToken, clientType: 'user-scoped' },
        transports: ['websocket'],
    });

    // Create server session lazily on first message
    let serverSessionId = null;
    let sessionPromise = null;
    async function ensureServerSession() {
        if (serverSessionId) return serverSessionId;
        if (sessionPromise) return sessionPromise;
        sessionPromise = (async () => {
            // Reuse existing session for this project directory instead of creating new one
            const tag = getProjectDirName(cwd);
            const resp = await axios.post(`${server}/v1/sessions`, {
                tag,
                metadata: hostname,
            }, {
                headers: { Authorization: `Bearer ${authToken}` },
                timeout: 10000,
            });
            serverSessionId = resp.data.session.id;
            writeTrack(serverSessionId, '', cwd, hostname, profile.name);
            return serverSessionId;
        })();
        return sessionPromise;
    }

    // Post message to server
    async function postMessage(role, content, metadata = {}) {
        const sid = await ensureServerSession();
        try {
            await axios.post(`${server}/v1/sessions/${sid}/plaintext-messages`, {
                role, content, metadata,
            }, {
                headers: { Authorization: `Bearer ${authToken}` },
                timeout: 10000,
            });
        } catch (e) {
            // Log to file instead of stdout to avoid mixing with claude TUI
            const logFile = path.join(os.homedir(), '.ccd', 'node-ccd.log');
            fs.appendFileSync(logFile, `${new Date().toISOString()} postMessage error: ${e.message}\n`);
        }
    }

    // Get claude sessionId from the latest JSONL file
    function getClaudeSessionId() {
        const jsonlPath = findLatestJsonl(cwd);
        if (!jsonlPath) return null;
        const fname = path.basename(jsonlPath, '.jsonl');
        return fname;
    }

    // Spawn local claude TUI with full profile env
    const env = {
        ...process.env,
        ...profile.env,
        ...(profile.model ? { ANTHROPIC_MODEL: profile.model } : {}),
        ...(profile.base_url ? { ANTHROPIC_BASE_URL: profile.base_url } : {}),
    };
    const claudeArgs = [];
    if (profile.model) claudeArgs.push('--model', profile.model);
    if (profile.skip_permissions) claudeArgs.push('--dangerously-skip-permissions');
    if (profile.extra_args && profile.extra_args.length) claudeArgs.push(...profile.extra_args);

    // Use @anthropic-ai/claude-code bin directly to avoid cmux wrapper interference
    const claudeBin = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const claude = spawn(claudeBin, claudeArgs, { env, stdio: 'inherit' });
    // Don't log after spawning claude — it conflicts with claude's TUI output

    // Monitor JSONL for claude messages
    let lastJsonlPath = null;
    let lastOffset = 0;
    const jsonlWatcher = setInterval(() => {
        const jsonlPath = findLatestJsonl(cwd);
        if (!jsonlPath) return;
        if (jsonlPath !== lastJsonlPath) {
            lastJsonlPath = jsonlPath;
            lastOffset = 0;
        }
        const stats = fs.statSync(jsonlPath);
        if (stats.size <= lastOffset) return;
        const content = fs.readFileSync(jsonlPath, 'utf-8');
        const lines = content.slice(lastOffset).split('\n').filter(l => l.trim());
        lastOffset = stats.size;

        for (const line of lines) {
            try {
                const msg = JSON.parse(line);
                const role = msg.type;
                if (msg.isMeta || msg.isCompactSummary) continue;

                const text = extractMessageText(msg);
                if (!text.trim()) continue;

                const metadata = {};
                if (msg.message?.usage) {
                    metadata.tokens = {
                        input: (msg.message.usage.input_tokens || 0) + (msg.message.usage.cache_creation_input_tokens || 0) + (msg.message.usage.cache_read_input_tokens || 0),
                        output: msg.message.usage.output_tokens || 0,
                    };
                }
                if (msg.message?.content) {
                    const content = msg.message.content;
                    if (Array.isArray(content)) {
                        const toolCalls = content.filter(b => b.type === 'tool_use').map(b => ({
                            name: b.name,
                            args: b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {},
                            result: content.find(r => r.type === 'tool_result' && r.tool_use_id === b.id)?.content || null,
                        }));
                        if (toolCalls.length) metadata.toolCalls = toolCalls;
                    }
                }

                postMessage(role, text, metadata).catch(e => console.error('ccd-node: post error:', e.message));
            } catch (e) {
                // ignore parse errors
            }
        }
    }, 500);

    // Handle webui messages via Socket.IO
    let queryInProgress = false;
    const messageQueue = [];

    async function processMessageQueue() {
        if (queryInProgress || messageQueue.length === 0) return;
        queryInProgress = true;
        const msg = messageQueue.shift();
        try {
            const claudeSessionId = getClaudeSessionId();
            const q = query({
                prompt: msg.content,
                options: {
                    cwd,
                    env: {
                        ...process.env,
                        ...profile.env,
                        ...(profile.model ? { ANTHROPIC_MODEL: profile.model } : {}),
                        ...(profile.base_url ? { ANTHROPIC_BASE_URL: profile.base_url } : {}),
                    },
                    resume: claudeSessionId || undefined,
                },
            });

            let fullText = '';
            let metadata = {};
            for await (const event of q) {
                if (event.type === 'assistant') {
                    const text = event.message.content
                        .filter(b => b.type === 'text')
                        .map(b => b.text)
                        .join('');
                    fullText += text;
                } else if (event.type === 'result') {
                    metadata = {
                        tokens: event.usage,
                        cost: event.total_cost_usd,
                    };
                    if (fullText.trim() === '') {
                        fullText = event.result;
                    }
                }
            }

            await postMessage('assistant', fullText, metadata);
        } catch (e) {
            const logFile = path.join(os.homedir(), '.ccd', 'node-ccd.log');
            fs.appendFileSync(logFile, `${new Date().toISOString()} query error: ${e.message}\n`);
            await postMessage('assistant', `[error] ${e.message}`);
        } finally {
            queryInProgress = false;
            processMessageQueue();
        }
    }

    socket.on('update', async (payload) => {
        if (!payload.body || payload.body.t !== 'plaintext-message') return;
        if (payload.body.sid !== serverSessionId) return;
        const msg = payload.body.message;
        if (msg.role !== 'user') return;
        messageQueue.push(msg);
        processMessageQueue();
    });

    // Keep process alive
    process.on('SIGINT', () => {
        clearInterval(jsonlWatcher);
        claude.kill();
        socket.disconnect();
        process.exit(0);
    });
}

main().catch(e => { console.error(e); process.exit(1); });
