var P = localStorage.getItem("happy_admin_password") || "";
var srv = window.location.origin;
var $ = function(id) { return document.getElementById(id); };

$("server-url-display").textContent = srv;

function api(method, path, body) {
    var headers = { "Content-Type": "application/json", "Authorization": "Bearer " + P };
    var opts = { method: method, headers: headers };
    if (body) { opts.body = JSON.stringify(body); }
    return fetch(srv + path, opts).then(function(r) {
        if (!r.ok) {
            return r.json().catch(function() {
                return { error: r.statusText };
            }).then(function(e) {
                throw new Error(e.error || r.statusText);
            });
        }
        return r.json();
    });
}

function setError(id, msg) {
    var el = $(id);
    if (el) { el.textContent = msg; setTimeout(function() { el.textContent = ""; }, 5000); }
}

function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(d) { return new Date(d).toLocaleString(); }

function loadAccounts() {
    api("GET", "/v1/admin/accounts").then(function(data) {
        var tbody = $("accounts-tbody");
        tbody.innerHTML = "";
        var accounts = data.accounts || [];
        if (accounts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty">No accounts yet</td></tr>';
            return;
        }
        var maxSessions = Math.max(1, accounts.reduce(function(m, a) { return Math.max(m, a.sessionCount || 0); }, 0));
        accounts.forEach(function(a) {
            var name = a.username || a.firstName || a.id.slice(0, 8);
            var pct = Math.round(((a.sessionCount || 0) / maxSessions) * 100);
            var row = document.createElement("tr");
            row.innerHTML =
                "<td>" +
                    '<div class="user-name">' + esc(name) + '</div>' +
                    '<div class="user-id">' + esc(a.id.slice(0, 12)) + '</div>' +
                "</td>" +
                "<td>" + (a.sessionCount || 0) + "</td>" +
                '<td>' +
                    '<div class="meter"><div class="meter-fill" style="width:' + pct + '%"></div></div>' +
                '</td>' +
                "<td>" + fmt(a.createdAt) + "</td>" +
                '<td><button class="delete-btn" onclick="deleteAccount(\'' + a.id.replace(/'/g, "\\'") + '\')">Delete</button></td>';
            tbody.appendChild(row);
        });
    }).catch(function(e) { console.error(e); });
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
    var password = $("new-account-password").value;
    if (!name) return;
    var body = { username: name };
    if (password) body.password = password;
    api("POST", "/v1/admin/accounts", body).then(function() {
        $("new-account-name").value = "";
        $("new-account-password").value = "";
        loadAccounts();
        loadStats();
    }).catch(function(e) { setError("account-error", e.message); });
}

function deleteAccount(id) {
    if (!confirm("Delete this account and all its data?")) return;
    api("DELETE", "/v1/admin/accounts/" + id).then(function() {
        loadAccounts();
        loadStats();
    }).catch(function(e) { alert(e.message); });
}

function loadStats() {
    api("GET", "/v1/admin/stats").then(function(data) {
        $("stat-accounts").textContent = data.accounts;
        $("stat-active").textContent = data.activeSessions;
        $("stat-total").textContent = data.totalSessions;
    }).catch(function(e) { console.error(e); });
}

$("login-btn").onclick = login;
$("password-input").onkeydown = function(e) { if (e.key === "Enter") login(); };
$("create-account-btn").onclick = createAccount;
$("new-account-name").onkeydown = function(e) { if (e.key === "Enter") createAccount(); };
$("new-account-password").onkeydown = function(e) { if (e.key === "Enter") createAccount(); };

// ===== Invites =====

function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt);
    var ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    return Promise.resolve();
}

function inviteLink(inv) {
    if (inv.url) return inv.url;
    if (inv.token) return srv + "/register?token=" + inv.token;
    return "";
}

function inviteStatus(inv) {
    if (inv.revokedAt || inv.revoked) return "revoked";
    if (inv.expired || (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now())) return "expired";
    if (inv.maxUses != null && (inv.usedCount || 0) >= inv.maxUses) return "exhausted";
    return "active";
}

function loadInvites() {
    api("GET", "/v1/admin/invites").then(function(data) {
        var tbody = $("invites-tbody");
        tbody.innerHTML = "";
        var invites = data.invites || [];
        if (invites.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty">No invites yet</td></tr>';
            return;
        }
        invites.forEach(function(inv) {
            var status = inviteStatus(inv);
            var link = inviteLink(inv);
            var row = document.createElement("tr");
            row.innerHTML =
                "<td>" +
                    '<div class="user-name">' + esc(inv.label || "—") + '</div>' +
                    '<div class="user-id">' + esc(String(inv.id).slice(0, 12)) + '</div>' +
                "</td>" +
                "<td>" + fmt(inv.createdAt) + "</td>" +
                "<td>" + (inv.expiresAt ? fmt(inv.expiresAt) : "never") + "</td>" +
                "<td>" + (inv.usedCount || 0) + " / " + (inv.maxUses != null ? inv.maxUses : "∞") + "</td>" +
                '<td><span class="status-badge status-' + status + '">' + status + "</span></td>" +
                '<td style="white-space:nowrap">' +
                    (link ? '<button class="copy-btn" data-link="' + esc(link) + '">Copy link</button>' : '') +
                    (status === "active" ? '<button class="revoke-btn" data-id="' + esc(String(inv.id)) + '">Revoke</button>' : '') +
                "</td>";
            tbody.appendChild(row);
        });
        tbody.querySelectorAll(".copy-btn").forEach(function(btn) {
            btn.onclick = function() {
                copyText(btn.dataset.link).then(function() {
                    btn.textContent = "Copied!";
                    setTimeout(function() { btn.textContent = "Copy link"; }, 2000);
                });
            };
        });
        tbody.querySelectorAll(".revoke-btn").forEach(function(btn) {
            btn.onclick = function() { revokeInvite(btn.dataset.id); };
        });
    }).catch(function(e) { console.error(e); });
}

function createInvite() {
    var label = $("invite-label").value.trim();
    var expires = parseInt($("invite-expires").value, 10);
    var maxUses = parseInt($("invite-max-uses").value, 10);
    var body = {};
    if (label) body.label = label;
    if (expires > 0) body.expiresInHours = expires;
    if (maxUses > 0) body.maxUses = maxUses;
    api("POST", "/v1/admin/invites", body).then(function(data) {
        $("invite-label").value = "";
        var link = inviteLink(data);
        if (link) {
            $("new-invite-url").textContent = link;
            $("new-invite-area").classList.remove("hidden");
        }
        loadInvites();
    }).catch(function(e) { setError("invite-error", e.message); });
}

function revokeInvite(id) {
    if (!confirm("Revoke this invite? It can no longer be used to register.")) return;
    api("POST", "/v1/admin/invites/" + id + "/revoke").then(loadInvites).catch(function(e) { alert(e.message); });
}

$("create-invite-btn").onclick = createInvite;
$("invite-label").onkeydown = function(e) { if (e.key === "Enter") createInvite(); };
$("copy-invite-btn").onclick = function() {
    var btn = this;
    copyText($("new-invite-url").textContent).then(function() {
        btn.textContent = "Copied!";
        setTimeout(function() { btn.textContent = "Copy link"; }, 2000);
    });
};

if (P) {
    $("login-screen").classList.add("hidden");
    $("main-screen").classList.remove("hidden");
    loadAccounts();
    loadStats();
    loadInvites();
    setInterval(loadStats, 30000);
}
