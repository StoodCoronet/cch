#!/usr/bin/env node
// claude PreToolUse hook: bridges permission prompts to the ccd daemon.
// claude runs this before every tool use, passing JSON on stdin
// ({session_id, tool_name, tool_input, ...}). We forward it to the daemon
// over the IPC unix socket and print the decision as hook JSON on stdout:
//   allow/deny -> {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//                  "permissionDecision":..., "permissionDecisionReason":...}}
//   ask/timeout/any error -> no output, exit 0 (claude falls back to the
//   local TUI approval prompt).
// Must run under a bare node: built-in modules only, no node-ccd deps.
const net = require('net');
const os = require('os');
const path = require('path');

// Slightly under the 60s hook timeout configured in the generated settings.
const TIMEOUT_MS = 55000;
const SOCK_FILE = path.join(process.env.CCD_HOME || path.join(os.homedir(), '.ccd'), 'daemon.sock');

function finish(decision) {
    if (decision === 'allow' || decision === 'deny') {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: decision,
                permissionDecisionReason: decision === 'allow' ? 'approved via web' : 'denied via web',
            },
        }));
    }
    process.exit(0);
}

// Hard cap: never leave claude waiting on us
setTimeout(() => finish(null), TIMEOUT_MS).unref();

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('error', () => finish(null));
process.stdin.on('end', () => {
    let hookInput = {};
    try {
        hookInput = JSON.parse(input);
    } catch (e) { /* fall through with what we have */ }

    const sock = net.createConnection(SOCK_FILE);
    let buffer = '';
    let done = false;
    const settle = (decision) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch (e) { /* ignore */ }
        finish(decision);
    };

    sock.on('connect', () => {
        sock.write(JSON.stringify({
            cmd: 'permission',
            ccdSessionId: process.env.CCD_SESSION_ID || null,
            toolName: hookInput.tool_name || null,
            toolInput: hookInput.tool_input !== undefined ? hookInput.tool_input : null,
        }) + '\n');
    });
    sock.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        let resp = {};
        try {
            resp = JSON.parse(buffer.slice(0, idx).trim());
        } catch (e) { /* settle below with ask */ }
        settle(resp && resp.ok ? resp.decision : null);
    });
    sock.on('error', () => settle(null));
});
