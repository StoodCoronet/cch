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
            tbody.innerHTML = '<tr><td colspan="4" class="empty">No accounts yet</td></tr>';
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
                "<td>" + fmt(a.createdAt) + "</td>";
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

if (P) {
    $("login-screen").classList.add("hidden");
    $("main-screen").classList.remove("hidden");
    loadAccounts();
    loadStats();
    setInterval(loadStats, 30000);
}
