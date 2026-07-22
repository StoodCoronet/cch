import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import * as privacyKit from "privacy-kit";
import {
    createBootstrapToken,
    listBootstrapTokens,
    revokeBootstrapToken,
} from "@/app/auth/bootstrapToken";

function adminAuth(request: any, reply: any): boolean {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) {
        reply.code(403).send({ error: 'Admin password not configured. Set ADMIN_PASSWORD env var.' });
        return false;
    }
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Authentication required' });
        return false;
    }
    const supplied = authHeader.substring(7);
    if (supplied !== password) {
        reply.code(401).send({ error: 'Invalid admin password' });
        return false;
    }
    return true;
}

export function adminRoutes(app: Fastify) {

    // Create an account (admin-only — generates keypair server-side)
    app.post('/v1/admin/accounts', {
        schema: {
            body: z.object({ username: z.string().min(1).max(64) }),
        },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const tweetnacl = (await import("tweetnacl")).default;
        const keypair = tweetnacl.box.keyPair();
        const publicKeyHex = privacyKit.encodeHex(keypair.publicKey);

        const existing = await db.account.findUnique({
            where: { username: request.body.username },
        });
        if (existing) {
            return reply.code(409).send({ error: 'Username already taken' });
        }

        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                username: request.body.username,
            },
        });

        return reply.send({
            accountId: account.id,
            username: account.username,
            createdAt: account.createdAt,
        });
    });

    // List accounts with session counts
    app.get('/v1/admin/accounts', {
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const accounts = await db.account.findMany({
            select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                createdAt: true,
                _count: { select: { Session: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        return reply.send({
            accounts: accounts.map((a) => ({
                id: a.id,
                username: a.username,
                firstName: a.firstName,
                lastName: a.lastName,
                createdAt: a.createdAt,
                sessionCount: a._count.Session,
            })),
        });
    });

    // Generate a bootstrap token for an account
    app.post('/v1/admin/bootstrap-tokens', {
        schema: {
            body: z.object({
                accountId: z.string(),
                label: z.string().optional(),
            }),
        },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const { accountId, label } = request.body;
        const account = await db.account.findUnique({ where: { id: accountId } });
        if (!account) {
            return reply.code(404).send({ error: 'Account not found' });
        }

        const result = await createBootstrapToken({ accountId, label });
        return reply.send({
            token: result.plaintext,
            record: {
                id: result.record.id,
                label: result.record.label,
                createdAt: result.record.createdAt,
            },
        });
    });

    // List bootstrap tokens for an account
    app.get('/v1/admin/bootstrap-tokens/:accountId', {
        schema: {
            params: z.object({ accountId: z.string() }),
        },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const tokens = await listBootstrapTokens(request.params.accountId);
        return reply.send({ tokens });
    });

    // Revoke a bootstrap token
    app.post('/v1/admin/bootstrap-tokens/:id/revoke', {
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const success = await revokeBootstrapToken(request.params.id);
        if (!success) {
            return reply.code(404).send({ error: 'Token not found' });
        }
        return reply.send({ success: true });
    });

    // Inline admin dashboard HTML
    app.get('/admin', async (_request, reply) => {
        reply.type('text/html').send(getAdminHtml());
    });
}

function getAdminHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Happy Server Admin</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; max-width: 900px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 22px; margin-bottom: 8px; }
h2 { font-size: 16px; margin: 24px 0 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
input, button, select { font-size: 14px; padding: 8px 12px; border-radius: 6px; border: 1px solid #30363d; background: #161b22; color: #e1e4e8; }
button { cursor: pointer; background: #238636; border-color: #238636; font-weight: 600; }
button:hover { background: #2ea043; }
button.danger { background: #da3633; border-color: #da3633; }
button.danger:hover { background: #f85149; }
button.small { font-size: 12px; padding: 4px 8px; }
.row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
.grow { flex: 1; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.token-highlight { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; word-break: break-all; margin: 8px 0; }
.conn-string { background: #0d1117; border: 1px solid #238636; border-radius: 6px; padding: 12px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; word-break: break-all; color: #7ee787; margin: 8px 0; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; }
th { color: #8b949e; font-weight: 600; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
.badge-active { background: #238636; color: #fff; }
.badge-revoked { background: #30363d; color: #8b949e; }
.hidden { display: none !important; }
.error { color: #f85149; font-size: 13px; margin-top: 4px; }
#login-screen { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 60vh; }
#login-screen .card { width: 100%; max-width: 360px; }
#main-screen.hidden, #login-screen.hidden { display: none; }
</style>
</head>
<body>
<div id="login-screen">
    <div class="card">
        <h1>Happy Server Admin</h1>
        <div class="row" style="margin-top:16px">
            <input id="password-input" type="password" placeholder="Admin password" class="grow" />
            <button id="login-btn">Login</button>
        </div>
        <p class="error" id="login-error"></p>
    </div>
</div>
<div id="main-screen" class="hidden">
    <h1>Happy Server Admin</h1>
    <div class="row">
        <span style="color:#8b949e">Server:</span>
        <span id="server-url-display"></span>
    </div>

    <h2>Accounts</h2>
    <div class="card">
        <div class="row">
            <input id="new-account-name" type="text" placeholder="Username" class="grow" />
            <button id="create-account-btn">Create Account</button>
        </div>
        <p class="error" id="account-error"></p>
        <table id="accounts-table" style="margin-top:12px">
            <thead><tr><th>Username</th><th>Sessions</th><th>Created</th><th></th></tr></thead>
            <tbody id="accounts-tbody"></tbody>
        </table>
    </div>

    <h2>Bootstrap Tokens</h2>
    <div class="card">
        <div class="row">
            <select id="token-account-select" class="grow"><option value="">Select an account...</option></select>
            <input id="token-label" type="text" placeholder="Label (optional)" style="width:180px" />
            <button id="generate-token-btn">Generate Token</button>
        </div>
        <p class="error" id="token-error"></p>
        <div id="new-token-display" class="hidden" style="margin-top:12px">
            <p style="color:#7ee787;font-weight:600">Token created! Save it now — it won't be shown again.</p>
            <div class="token-highlight" id="new-token-value"></div>
            <p style="color:#8b949e;margin-top:8px">Connection string (copy & paste into cct):</p>
            <div class="conn-string" id="new-conn-string"></div>
            <button id="copy-conn-btn" class="small" style="margin-top:8px">Copy Connection String</button>
        </div>
        <table id="tokens-table" style="margin-top:12px">
            <thead><tr><th>Label</th><th>Created</th><th>Status</th><th></th></tr></thead>
            <tbody id="tokens-tbody"></tbody>
        </table>
        <p style="color:#8b949e;font-size:12px;margin-top:8px">Tokens for: <span id="selected-account-label">—</span></p>
    </div>
</div>
<script>
const P = localStorage.getItem('happy_admin_password') || '';
let srv = window.location.origin;

document.getElementById('server-url-display').textContent = srv;

async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + P } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(srv + path, opts);
    if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || r.statusText);
    }
    return r.json();
}

function setError(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; setTimeout(() => el.textContent = '', 5000); } }

async function login() {
    const pw = document.getElementById('password-input').value;
    if (!pw) return;
    try {
        const r = await fetch(srv + '/v1/admin/accounts', { headers: { 'Authorization': 'Bearer ' + pw } });
        if (!r.ok) throw new Error('Invalid password');
        localStorage.setItem('happy_admin_password', pw);
        location.reload();
    } catch (e) {
        setError('login-error', e.message);
    }
}

async function loadAccounts() {
    const data = await api('GET', '/v1/admin/accounts');
    const tbody = document.getElementById('accounts-tbody');
    const sel = document.getElementById('token-account-select');
    sel.innerHTML = '<option value="">Select an account...</option>';
    tbody.innerHTML = '';
    for (const a of data.accounts) {
        tbody.innerHTML += '<tr><td>' + h(a.username || a.firstName || a.id.slice(0,8)) + '</td><td>' + a.sessionCount + '</td><td>' + fmt(a.createdAt) + '</td><td><button class="small" onclick="selectAccount(\'' + a.id + '\',\'' + h(a.username || a.id.slice(0,8)) + '\')">Select</button></td></tr>';
        sel.innerHTML += '<option value="' + a.id + '">' + h(a.username || a.firstName || a.id.slice(0,8)) + '</option>';
    }
}

async function createAccount() {
    const name = document.getElementById('new-account-name').value.trim();
    if (!name) return;
    try {
        await api('POST', '/v1/admin/accounts', { username: name });
        document.getElementById('new-account-name').value = '';
        loadAccounts();
    } catch (e) { setError('account-error', e.message); }
}

async function generateToken() {
    const sel = document.getElementById('token-account-select');
    const accountId = sel.value;
    const label = document.getElementById('token-label').value.trim() || null;
    if (!accountId) { setError('token-error', 'Select an account first'); return; }
    try {
        const data = await api('POST', '/v1/admin/bootstrap-tokens', { accountId, label });
        document.getElementById('new-token-value').textContent = data.token;
        document.getElementById('new-conn-string').textContent = srv + '/connect?token=' + data.token;
        document.getElementById('new-token-display').classList.remove('hidden');
        document.getElementById('token-label').value = '';
        loadTokens(accountId);
    } catch (e) { setError('token-error', e.message); }
}

async function loadTokens(accountId) {
    document.getElementById('selected-account-label').textContent = accountId ? 'account ' + accountId.slice(0,8) + '...' : '—';
    if (!accountId) { document.getElementById('tokens-tbody').innerHTML = ''; return; }
    const data = await api('GET', '/v1/admin/bootstrap-tokens/' + accountId);
    const tbody = document.getElementById('tokens-tbody');
    tbody.innerHTML = '';
    for (const t of data.tokens) {
        const revoked = t.revokedAt !== null;
        tbody.innerHTML += '<tr><td>' + h(t.label || '—') + '</td><td>' + fmt(t.createdAt) + '</td><td><span class="badge ' + (revoked ? 'badge-revoked' : 'badge-active') + '">' + (revoked ? 'Revoked' : 'Active') + '</span></td><td>' + (revoked ? '' : '<button class="small danger" onclick="revokeToken(\'' + t.id + '\',\'' + accountId + '\')">Revoke</button>') + '</td></tr>';
    }
}

async function revokeToken(id, accountId) {
    if (!confirm('Revoke this token? It will stop working immediately.')) return;
    await api('POST', '/v1/admin/bootstrap-tokens/' + id + '/revoke');
    loadTokens(accountId);
}

function selectAccount(id, name) {
    document.getElementById('token-account-select').value = id;
    document.getElementById('selected-account-label').textContent = name;
    loadTokens(id);
}

function h(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(d) { return new Date(d).toLocaleString(); }

document.getElementById('login-btn').onclick = login;
document.getElementById('password-input').onkeydown = function(e) { if (e.key === 'Enter') login(); };
document.getElementById('create-account-btn').onclick = createAccount;
document.getElementById('new-account-name').onkeydown = function(e) { if (e.key === 'Enter') createAccount(); };
document.getElementById('generate-token-btn').onclick = generateToken;
document.getElementById('copy-conn-btn').onclick = function() {
    const txt = document.getElementById('new-conn-string').textContent;
    navigator.clipboard.writeText(txt).then(() => {
        const btn = document.getElementById('copy-conn-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy Connection String', 2000);
    });
};

if (P) {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('main-screen').classList.remove('hidden');
    loadAccounts();
}
</script>
</body>
</html>`;
}
