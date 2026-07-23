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
        var sel = $("token-account-select");
        sel.innerHTML = "<option value=\"\">Select an account...</option>";
        tbody.innerHTML = "";
        data.accounts.forEach(function(a) {
            var name = a.username || a.firstName || a.id.slice(0, 8);
            var row = document.createElement("tr");
            row.innerHTML =
                "<td>" + esc(name) + "</td>" +
                "<td>" + a.sessionCount + "</td>" +
                "<td>" + fmt(a.createdAt) + "</td>" +
                "<td></td>";
            var btn = document.createElement("button");
            btn.className = "small";
            btn.textContent = "Select";
            btn.onclick = (function(id, n) {
                return function() { selectAccount(id, n); };
            })(a.id, name);
            row.cells[3].appendChild(btn);
            tbody.appendChild(row);

            var opt = document.createElement("option");
            opt.value = a.id;
            opt.textContent = name;
            sel.appendChild(opt);
        });
    }).catch(function(e) { console.error(e); });
}

function loadTokens(accountId) {
    $("selected-account-label").textContent = accountId ? accountId.slice(0, 8) + "..." : "—";
    if (!accountId) { $("tokens-tbody").innerHTML = ""; return; }
    api("GET", "/v1/admin/bootstrap-tokens/" + accountId).then(function(data) {
        var tbody = $("tokens-tbody");
        tbody.innerHTML = "";
        var active = data.tokens.filter(function(t) { return t.revokedAt === null; });
        active.forEach(function(t) {
            var tr = document.createElement("tr");
            tr.innerHTML =
                "<td>" + esc(t.label || "—") + "</td>" +
                "<td>" + fmt(t.createdAt) + "</td>" +
                "<td><span class=\"badge badge-active\">Active</span></td>" +
                "<td></td>";
            var btn = document.createElement("button");
            btn.className = "small danger";
            btn.textContent = "Revoke";
            btn.onclick = (function(tid, aid) {
                return function() { revokeToken(tid, aid); };
            })(t.id, accountId);
            tr.cells[3].appendChild(btn);
            tbody.appendChild(tr);
        });
    }).catch(function(e) { console.error(e); });
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
    var label = $("token-label").value.trim();
    if (!accountId) { setError("token-error", "Select an account first"); return; }
    var body = { accountId: accountId };
    if (label) body.label = label;
    api("POST", "/v1/admin/bootstrap-tokens", body).then(function(data) {
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
        setTimeout(function() { btn.textContent = "Copy Connection String"; }, 2000);
    });
};

if (P) {
    $("login-screen").classList.add("hidden");
    $("main-screen").classList.remove("hidden");
    loadAccounts();
    loadStats();
    setInterval(loadStats, 30000);
}

function loadStats() {
    api("GET", "/v1/admin/stats").then(function(data) {
        $("stat-accounts").textContent = data.accounts;
        $("stat-active").textContent = data.activeSessions;
        $("stat-total").textContent = data.totalSessions;
    }).catch(function(e) { console.error(e); });
}
