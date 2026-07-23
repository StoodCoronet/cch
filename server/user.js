var TOKEN = localStorage.getItem("cch_token") || "";
var ACCOUNT_ID = localStorage.getItem("cch_account_id") || "";
var SERVER = localStorage.getItem("cch_server") || window.location.origin;
var $ = function(id) { return document.getElementById(id); };
var refreshTimer = null;

function api(method, path, body) {
    var headers = { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN };
    var opts = { method: method, headers: headers };
    if (body) opts.body = JSON.stringify(body);
    return fetch(SERVER + path, opts).then(function(r) {
        if (!r.ok) {
            if (r.status === 401) { logout(); throw new Error("Session expired"); }
            return r.json().then(function(e) { throw new Error(e.error || r.statusText); });
        }
        return r.json();
    });
}

function ago(ms) {
    var diff = Date.now() - ms;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
}
function fmt(ms) { return new Date(ms).toLocaleString(); }

function connect() {
    var input = $("connect-input").value.trim();
    if (!input) return;
    var token = input;
    if (input.indexOf("?token=") !== -1) {
        token = input.split("?token=")[1];
        if (input.indexOf("://") !== -1) {
            var s = input.indexOf("://") + 3;
            var e = input.indexOf("/", s);
            SERVER = input.substring(0, e);
            localStorage.setItem("cch_server", SERVER);
        }
    }
    token = token.replace(/[\s"']/g, "");
    var btn = $("connect-btn");
    var err = $("connect-error");
    err.textContent = "";
    btn.textContent = "Connecting...";
    btn.disabled = true;

    fetch(SERVER + "/v1/auth/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token, hostname: "web" })
    }).then(function(r) {
        if (!r.ok) return r.json().then(function(e) { throw new Error(e.error || "Invalid token"); });
        return r.json();
    }).then(function(data) {
        TOKEN = data.token;
        ACCOUNT_ID = data.accountId;
        localStorage.setItem("cch_token", TOKEN);
        localStorage.setItem("cch_account_id", ACCOUNT_ID);
        $("connect-screen").classList.add("hidden");
        $("dashboard-screen").classList.remove("hidden");
        $("account-id-display").textContent = ACCOUNT_ID.slice(0, 12) + "...";
        refresh();
        refreshTimer = setInterval(refresh, 30000);
    }).catch(function(e) {
        err.textContent = e.message;
        btn.textContent = "Connect";
        btn.disabled = false;
    });
}

function logout() {
    localStorage.removeItem("cch_token");
    localStorage.removeItem("cch_account_id");
    TOKEN = "";
    ACCOUNT_ID = "";
    $("dashboard-screen").classList.add("hidden");
    $("connect-screen").classList.remove("hidden");
    $("connect-btn").textContent = "Connect";
    $("connect-btn").disabled = false;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function refresh() {
    loadSessions();
    loadMachines();
    loadTokens();
}

function loadSessions() {
    api("GET", "/v2/sessions/active?limit=50").then(function(data) {
        var tbody = $("sessions-tbody");
        tbody.innerHTML = "";
        $("session-count").textContent = "(" + data.sessions.length + ")";
        if (data.sessions.length === 0) {
            $("sessions-empty").classList.remove("hidden");
            $("sessions-table").classList.add("hidden");
            return;
        }
        $("sessions-empty").classList.add("hidden");
        $("sessions-table").classList.remove("hidden");
        data.sessions.forEach(function(s) {
            var tr = document.createElement("tr");
            tr.innerHTML =
                "<td><code>" + s.id.slice(0, 12) + "</code></td>" +
                "<td><span class=\"badge " + (s.active ? "badge-active" : "badge-off") + "\">" + (s.active ? "Active" : "Idle") + "</span></td>" +
                "<td>" + ago(s.activeAt) + "</td>" +
                "<td>" + fmt(s.createdAt) + "</td>";
            tbody.appendChild(tr);
        });
    }).catch(function(e) { console.error(e); });
}

function loadMachines() {
    api("GET", "/v1/machines").then(function(data) {
        var tbody = $("machines-tbody");
        tbody.innerHTML = "";
        var machines = Array.isArray(data) ? data : [];
        $("machine-count").textContent = "(" + machines.length + ")";
        if (machines.length === 0) {
            $("machines-empty").classList.remove("hidden");
            $("machines-table").classList.add("hidden");
            return;
        }
        $("machines-empty").classList.add("hidden");
        $("machines-table").classList.remove("hidden");
        machines.forEach(function(m) {
            var tr = document.createElement("tr");
            tr.innerHTML =
                "<td><code>" + (m.id || "").replace(/[&<>\"']/g, "") + "</code></td>" +
                "<td>" + ago(m.activeAt) + "</td>";
            tbody.appendChild(tr);
        });
    }).catch(function(e) { console.error(e); });
}

function generateToken() {
    var label = $("token-label-input").value.trim() || null;
    var body = {};
    if (label) body.label = label;
    $("gen-token-error").textContent = "";
    api("POST", "/v1/bootstrap-tokens", body).then(function(data) {
        var conn = SERVER + "/connect?token=" + data.token;
        $("new-conn-str").textContent = conn;
        $("new-token-area").classList.remove("hidden");
        $("token-label-input").value = "";
        // Save connection string so Copy button works after refresh
        var saved = JSON.parse(localStorage.getItem("cch_tokens") || "{}");
        saved[data.record.id] = conn;
        localStorage.setItem("cch_tokens", JSON.stringify(saved));
        loadTokens();
    }).catch(function(e) { $("gen-token-error").textContent = e.message; });
}

function loadTokens() {
    api("GET", "/v1/bootstrap-tokens").then(function(data) {
        var tbody = $("tokens-tbody");
        tbody.innerHTML = "";
        var active = (data.tokens || []).filter(function(t) { return t.revokedAt === null; });
        if (active.length === 0) {
            $("tokens-table").classList.add("hidden");
            return;
        }
        $("tokens-table").classList.remove("hidden");
        var saved = JSON.parse(localStorage.getItem("cch_tokens") || "{}");
        active.forEach(function(t) {
            var tr = document.createElement("tr");
            tr.innerHTML =
                "<td>" + (t.label || "—") + "</td>" +
                "<td>" + fmt(t.createdAt) + "</td>" +
                "<td><span class=\"badge badge-active\">Active</span></td>" +
                "<td></td>";
            var actions = tr.cells[3];
            var revokeBtn = document.createElement("button");
            revokeBtn.className = "small danger";
            revokeBtn.textContent = "Revoke";
            revokeBtn.onclick = (function(tid) { return function() { revokeToken(tid); }; })(t.id);
            actions.appendChild(revokeBtn);
            if (saved[t.id]) {
                var copyBtn = document.createElement("button");
                copyBtn.className = "small";
                copyBtn.textContent = "Copy";
                copyBtn.style.marginLeft = "4px";
                copyBtn.onclick = (function(conn) { return function() {
                    var btn = this;
                    copyText(conn).then(function() {
                        btn.textContent = "Copied!";
                        setTimeout(function() { btn.textContent = "Copy"; }, 2000);
                    });
                }; })(saved[t.id]);
                actions.appendChild(copyBtn);
            }
            tbody.appendChild(tr);
        });
    }).catch(function(e) { console.error(e); });
}

function revokeToken(id) {
    if (!confirm("Revoke this token?")) return;
    api("POST", "/v1/bootstrap-tokens/" + id + "/revoke").then(function() { loadTokens(); });
}

function copyText(txt) {
    // Fallback for HTTP origins where navigator.clipboard is unavailable
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(txt);
    }
    var ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
}

function copyToken() {
    var txt = $("new-conn-str").textContent;
    copyText(txt).then(function() {
        var btn = $("copy-token-btn");
        btn.textContent = "Copied!";
        setTimeout(function() { btn.textContent = "Copy"; }, 2000);
    });
}

$("connect-btn").onclick = connect;
$("connect-input").onkeydown = function(e) { if (e.key === "Enter") connect(); };
$("refresh-btn").onclick = refresh;
$("logout-btn").onclick = logout;
$("gen-token-btn").onclick = generateToken;
$("token-label-input").onkeydown = function(e) { if (e.key === "Enter") generateToken(); };
$("copy-token-btn").onclick = copyToken;

var urlToken = new URLSearchParams(window.location.search).get("token");
if (urlToken) { $("connect-input").value = window.location.href; }
if (TOKEN) {
    $("connect-screen").classList.add("hidden");
    $("dashboard-screen").classList.remove("hidden");
    $("account-id-display").textContent = ACCOUNT_ID.slice(0, 12) + "...";
    refresh();
    refreshTimer = setInterval(refresh, 30000);
}
