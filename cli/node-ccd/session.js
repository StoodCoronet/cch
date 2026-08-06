const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// --- PTY backend ---
// Prefer node-pty; fall back to macOS script(1) which allocates a PTY for the child.
let nodePty = null;
try {
    nodePty = require('node-pty');
    // The prebuilt spawn-helper ships without the exec bit when npm install
    // scripts are blocked; posix_spawnp fails without it.
    const helper = path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    try {
        fs.accessSync(helper, fs.constants.X_OK);
    } catch (e) {
        try { fs.chmodSync(helper, 0o755); } catch (e2) { /* ignore */ }
    }
} catch (e) {
    nodePty = null;
}

function getPtyBackendName() {
    return nodePty ? 'node-pty' : 'script';
}

// Unified PTY interface: { write(data), resize(cols, rows), onData(cb), onExit(cb), kill() }
// onData always receives a string; onExit receives the numeric exit code.
function createPty(file, args, opts) {
    if (nodePty) {
        const p = nodePty.spawn(file, args, {
            name: 'xterm-256color',
            cols: opts.cols || 80,
            rows: opts.rows || 24,
            cwd: opts.cwd,
            env: opts.env,
        });
        return {
            write: (data) => p.write(data),
            resize: (cols, rows) => { try { p.resize(cols, rows); } catch (e) { /* ignore */ } },
            onData: (cb) => p.onData(cb),
            onExit: (cb) => p.onExit(({ exitCode }) => cb(exitCode)),
            kill: () => { try { p.kill(); } catch (e) { /* ignore */ } },
        };
    }
    // Fallback: script -q /dev/null <cmd...> runs the child under a PTY and
    // bridges it to our pipes. Resize is not supported and becomes a no-op.
    const child = spawn('script', ['-q', '/dev/null', file, ...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
        write: (data) => { try { child.stdin.write(data); } catch (e) { /* ignore */ } },
        resize: () => {},
        onData: (cb) => child.stdout.on('data', (d) => cb(d.toString('utf-8'))),
        onExit: (cb) => child.on('exit', (code) => cb(code == null ? -1 : code)),
        kill: () => { try { child.kill(); } catch (e) { /* ignore */ } },
    };
}

// --- Claude JSONL monitoring ---
function getClaudeProjectsDir() {
    return process.env.CCD_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

function getProjectDirName(cwd) {
    return cwd.replace(/\//g, '-').replace(/_/g, '-');
}

function findLatestJsonl(cwd, includeFile) {
    const projDir = path.join(getClaudeProjectsDir(), getProjectDirName(cwd));
    if (!fs.existsSync(projDir)) return null;
    const files = fs.readdirSync(projDir)
        .filter(f => f.endsWith('.jsonl') && (!includeFile || includeFile(f)))
        .map(f => ({ name: f, path: path.join(projDir, f), mtime: fs.statSync(path.join(projDir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].path : null;
}

function truncateForDisplay(s, maxLen) {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '… +' + (s.length - maxLen) + ' chars';
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

// Watches ~/.claude/projects/<projectDirName(cwd)>/ for the latest .jsonl file.
// The file name (without extension) is the claudeSessionId.
// Callbacks:
//   onClaudeSessionId(id)   — fired once when the jsonl file appears
//   onTitle(title)          — summary line or first user message excerpt
//   onMessage(role, text, metadata) — each new user/assistant message
class JsonlWatcher {
    constructor(cwd, callbacks, opts = {}) {
        this.cwd = cwd;
        this.onClaudeSessionId = callbacks.onClaudeSessionId || (() => {});
        this.onTitle = callbacks.onTitle || (() => {});
        this.onMessage = callbacks.onMessage || (() => {});
        // Files that already existed when this watcher was created. A new claude
        // conversation always writes a NEW jsonl file, so pre-existing files belong
        // to older conversations and must not be mistaken for ours. The one exception
        // is resume mode (expectedId): claude appends to that existing file.
        this.expectedId = opts.expectedId || null;
        this.preExisting = new Set();
        try {
            const projDir = path.join(getClaudeProjectsDir(), getProjectDirName(cwd));
            if (fs.existsSync(projDir)) {
                for (const f of fs.readdirSync(projDir)) {
                    if (f.endsWith('.jsonl')) this.preExisting.add(f);
                }
            }
        } catch (e) { /* ignore */ }
        this.lastJsonlPath = null;
        this.lastOffset = 0;
        this.timer = null;
        this.firstUserText = null;
    }

    start() {
        this.timer = setInterval(() => this.poll(), 500);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    poll() {
        try {
            this.pollUnsafe();
        } catch (e) {
            // ignore transient fs errors
        }
    }

    pollUnsafe() {
        const jsonlPath = findLatestJsonl(this.cwd, (f) => {
            if (this.expectedId) return f === `${this.expectedId}.jsonl`;
            return !this.preExisting.has(f);
        });
        if (!jsonlPath) return;
        if (jsonlPath !== this.lastJsonlPath) {
            this.lastJsonlPath = jsonlPath;
            this.lastOffset = 0;
            this.onClaudeSessionId(path.basename(jsonlPath, '.jsonl'));
        }
        const stats = fs.statSync(jsonlPath);
        if (stats.size <= this.lastOffset) return;
        // Read only the new bytes (old code sliced a full-file string by byte
        // offset, which corrupts multibyte characters).
        const fd = fs.openSync(jsonlPath, 'r');
        const buf = Buffer.alloc(stats.size - this.lastOffset);
        fs.readSync(fd, buf, 0, buf.length, this.lastOffset);
        fs.closeSync(fd);
        this.lastOffset = stats.size;

        const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
            let msg;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                continue;
            }
            if (msg.type === 'summary' && msg.summary) {
                this.onTitle(msg.summary);
                continue;
            }
            if (msg.isMeta || msg.isCompactSummary) continue;
            const role = msg.type;
            if (role !== 'user' && role !== 'assistant') continue;

            const text = extractMessageText(msg);
            if (!text.trim()) continue;

            if (role === 'user' && !this.firstUserText) {
                this.firstUserText = text;
                this.onTitle(truncateForDisplay(text.replace(/\s+/g, ' ').trim(), 60));
            }

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

            this.onMessage(role, text, metadata);
        }
    }
}

module.exports = {
    createPty,
    getPtyBackendName,
    JsonlWatcher,
    getClaudeProjectsDir,
    getProjectDirName,
    findLatestJsonl,
    extractMessageText,
    truncateForDisplay,
};
