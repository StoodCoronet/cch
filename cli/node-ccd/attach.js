// Local terminal attach: connects to the daemon IPC socket, switches the
// connection to raw byte stream mode, and bridges the local terminal to the
// session's PTY. Ctrl+\ (0x1c) detaches without killing the claude process.
const net = require('net');

const DETACH_BYTE = 0x1c; // Ctrl+\

// attach(sessionId) -> Promise<'detached' | 'exited' | 'closed'>
function attach(sessionId) {
    // Lazy access to avoid the index.js <-> attach.js circular require
    const { SOCK_FILE } = require('./index');
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(SOCK_FILE);
        let chunks = [];
        let ready = false;
        let settled = false;
        let resizeCtl = null;

        function cleanup(result) {
            if (settled) return;
            settled = true;
            if (process.stdin.isTTY) {
                try { process.stdin.setRawMode(false); } catch (e) { /* ignore */ }
                process.stdin.pause();
            }
            if (resizeCtl) { try { resizeCtl.destroy(); } catch (e) { /* ignore */ } }
            try { sock.destroy(); } catch (e) { /* ignore */ }
            resolve(result);
        }

        function enterRaw() {
            if (!process.stdin.isTTY) {
                console.error('attach requires a TTY');
                cleanup('closed');
                return;
            }
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', (d) => {
                const idx = d.indexOf(DETACH_BYTE);
                if (idx >= 0) {
                    // Forward bytes before the detach key, then detach
                    if (idx > 0) sock.write(d.slice(0, idx));
                    cleanup('detached');
                    return;
                }
                sock.write(d);
            });
            // Separate control connection for resize events
            resizeCtl = net.createConnection(SOCK_FILE);
            process.stdout.on('resize', () => {
                if (resizeCtl.destroyed) return;
                resizeCtl.write(JSON.stringify({
                    cmd: 'resize',
                    sessionId,
                    cols: process.stdout.columns,
                    rows: process.stdout.rows,
                }) + '\n');
            });
        }

        sock.on('connect', () => {
            sock.write(JSON.stringify({
                cmd: 'attach',
                sessionId,
                cols: process.stdout.columns || 80,
                rows: process.stdout.rows || 24,
            }) + '\n');
        });

        sock.on('data', (chunk) => {
            if (!ready) {
                chunks.push(chunk);
                const buf = Buffer.concat(chunks);
                const idx = buf.indexOf(0x0a);
                if (idx < 0) return;
                const line = buf.slice(0, idx).toString('utf-8').trim();
                const rest = buf.slice(idx + 1);
                let resp;
                try {
                    resp = JSON.parse(line);
                } catch (e) {
                    console.error('attach: invalid response from daemon');
                    cleanup('closed');
                    return;
                }
                if (!resp.ok) {
                    // Reject so the caller's catch prints the error and exits 1
                    // (resolving here would silently exit 0 after the print).
                    settled = true;
                    try { sock.destroy(); } catch (e) { /* ignore */ }
                    reject(new Error(resp.error || 'attach failed'));
                    return;
                }
                ready = true;
                enterRaw();
                if (rest.length) process.stdout.write(rest);
                return;
            }
            process.stdout.write(chunk);
        });

        sock.on('close', () => cleanup(settled ? undefined : 'exited'));
        sock.on('error', (e) => {
            if (!settled && !ready) {
                reject(new Error(`cannot connect to daemon (${SOCK_FILE}): ${e.message}`));
                settled = true;
                return;
            }
            cleanup('closed');
        });
    });
}

module.exports = { attach };
