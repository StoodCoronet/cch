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
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(keypair.publicKey));

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
<title>CCH Server Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f1117;color:#e1e4e8;max-width:900px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin-bottom:8px}
h2{font-size:16px;margin:24px 0 12px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
input,button,select{font-size:14px;padding:8px 12px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#e1e4e8}
button{cursor:pointer;background:#238636;border-color:#238636;font-weight:600}
button:hover{background:#2ea043}
button.danger{background:#da3633;border-color:#da3633}
button.danger:hover{background:#f85149}
button.small{font-size:12px;padding:4px 8px}
.row{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.grow{flex:1}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.token-highlight{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;margin:8px 0}
.conn-string{background:#0d1117;border:1px solid #238636;border-radius:6px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;color:#7ee787;margin:8px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:600}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.badge-active{background:#238636;color:#fff}
.badge-revoked{background:#30363d;color:#8b949e}
.hidden{display:none!important}
.error{color:#f85149;font-size:13px;margin-top:4px}
#login-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh}
#login-screen .card{width:100%;max-width:360px}
</style>
</head>
<body>
<div id="login-screen">
    <div class="card">
        <h1>CCH Server Admin</h1>
        <div class="row" style="margin-top:16px">
            <input id="password-input" type="password" placeholder="Admin password" class="grow" />
            <button id="login-btn">Login</button>
        </div>
        <p class="error" id="login-error"></p>
    </div>
</div>
<div id="main-screen" class="hidden">
    <h1>CCH Server Admin</h1>
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
            <p style="color:#7ee787;font-weight:600">Token created. Save it now.</p>
            <div class="token-highlight" id="new-token-value"></div>
            <p style="color:#8b949e;margin-top:8px">Connection string (copy and paste into cch):</p>
            <div class="conn-string" id="new-conn-string"></div>
            <button id="copy-conn-btn" class="small" style="margin-top:8px">Copy Connection String</button>
        </div>
        <table id="tokens-table" style="margin-top:12px">
            <thead><tr><th>Label</th><th>Created</th><th>Status</th><th></th></tr></thead>
            <tbody id="tokens-tbody"></tbody>
        </table>
        <p style="color:#8b949e;font-size:12px;margin-top:8px">Tokens: <span id="selected-account-label">—</span></p>
    </div>
</div>
<script>
(function(){
var P = localStorage.getItem("happy_admin_password") || "";
var srv = window.location.origin;
var $ = function(id){ return document.getElementById(id); };

$("server-url-display").textContent = srv;

function api(method, path, body) {
    var headers = { "Content-Type": "application/json", "Authorization": "Bearer " + P };
    var opts = { method: method, headers: headers };
    if (body) { opts.body = JSON.stringify(body); }
    return fetch(srv + path, opts).then(function(r) {
        if (!r.ok) {
            return r.json().catch(function(){ return { error: r.statusText }; }).then(function(e) {
                throw new Error(e.error || r.statusText);
            });
        }
        return r.json();
    });
}

function setError(id, msg) {
    var el = $(id);
    if (el) { el.textContent = msg; setTimeout(function(){ el.textContent = ""; }, 5000); }
}

function h(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmt(d) { return new Date(d).toLocaleString(); }

function loadAccounts() {
    api("GET", "/v1/admin/accounts").then(function(data) {
        var tbody = $("accounts-tbody");
        var sel = $("token-account-select");
        sel.innerHTML = "<option value=\"\">Select an account...</option>";
        tbody.innerHTML = "";
        data.accounts.forEach(function(a) {
            var name = a.username || a.firstName || a.id.slice(0,8);
            tbody.innerHTML += "<tr><td>" + h(name) + "</td><td>" + a.sessionCount + "</td><td>" + fmt(a.createdAt) + "</td><td><button class=\"small\" data-select=\"" + a.id + "|" + h(name) + "\">Select</button></td></tr>";
            sel.innerHTML += "<option value=\"" + a.id + "\">" + h(name) + "</option>";
        });
        document.querySelectorAll("[data-select]").forEach(function(btn) {
            btn.onclick = function() {
                var parts = this.getAttribute("data-select").split("|");
                selectAccount(parts[0], parts[1]);
            };
        });
    }).catch(function(e){ console.error(e); });
}

function loadTokens(accountId) {
    $("selected-account-label").textContent = accountId ? accountId.slice(0,8) + "..." : "—";
    if (!accountId) { $("tokens-tbody").innerHTML = ""; return; }
    api("GET", "/v1/admin/bootstrap-tokens/" + accountId).then(function(data) {
        var tbody = $("tokens-tbody");
        tbody.innerHTML = "";
        data.tokens.forEach(function(t) {
            var revoked = t.revokedAt !== null;
            var revokeBtn = revoked ? "" : "<button class=\"small danger\" data-revoke=\"" + t.id + "|" + accountId + "\">Revoke</button>";
            tbody.innerHTML += "<tr><td>" + h(t.label || "—") + "</td><td>" + fmt(t.createdAt) + "</td><td><span class=\"badge " + (revoked ? "badge-revoked" : "badge-active") + "\">" + (revoked ? "Revoked" : "Active") + "</span></td><td>" + revokeBtn + "</td></tr>";
        });
        document.querySelectorAll("[data-revoke]").forEach(function(btn) {
            btn.onclick = function() {
                var parts = this.getAttribute("data-revoke").split("|");
                revokeToken(parts[0], parts[1]);
            };
        });
    }).catch(function(e){ console.error(e); });
}

function selectAccount(id, name) {
    $("token-account-select").value = id;
    $("selected-account-label").textContent = name;
    loadTokens(id);
}

function revokeToken(id, accountId) {
    if (!confirm("Revoke this token?")) return;
    api("POST", "/v1/admin/bootstrap-tokens/" + id + "/revoke").then(function() {
        loadTokens(accountId);
    });
}

function login() {
    var pw = $("password-input").value;
    if (!pw) return;
    fetch(srv + "/v1/admin/accounts", { headers: { "Authorization": "Bearer " + pw } }).then(function(r) {
        if (!r.ok) throw new Error("Invalid password");
        localStorage.setItem("happy_admin_password", pw);
        location.reload();
    }).catch(function(e) {
        setError("login-error", e.message);
    });
}

function createAccount() {
    var name = $("new-account-name").value.trim();
    if (!name) return;
    api("POST", "/v1/admin/accounts", { username: name }).then(function() {
        $("new-account-name").value = "";
        loadAccounts();
    }).catch(function(e) { setError("account-error", e.message); });
}

function generateToken() {
    var accountId = $("token-account-select").value;
    var label = $("token-label").value.trim() || null;
    if (!accountId) { setError("token-error", "Select an account first"); return; }
    api("POST", "/v1/admin/bootstrap-tokens", { accountId: accountId, label: label }).then(function(data) {
        $("new-token-value").textContent = data.token;
        $("new-conn-string").textContent = srv + "/connect?token=" + data.token;
        $("new-token-display").classList.remove("hidden");
        $("token-label").value = "";
        loadTokens(accountId);
    }).catch(function(e) { setError("token-error", e.message); });
}

$("login-btn").onclick = login;
$("password-input").onkeydown = function(e) { if (e.key === "Enter") login(); };
$("create-account-btn").onclick = createAccount;
$("new-account-name").onkeydown = function(e) { if (e.key === "Enter") createAccount(); };
$("generate-token-btn").onclick = generateToken;
$("copy-conn-btn").onclick = function() {
    var txt = $("new-conn-string").textContent;
    navigator.clipboard.writeText(txt).then(function() {
        var btn = $("copy-conn-btn");
        btn.textContent = "Copied!";
        setTimeout(function(){ btn.textContent = "Copy Connection String"; }, 2000);
    });
};

if (P) {
    $("login-screen").classList.add("hidden");
    $("main-screen").classList.remove("hidden");
    loadAccounts();
}
})();
</script>
</body>
</html>`;
}
