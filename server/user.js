var TOKEN = localStorage.getItem("cch_token") || "";
var ACCOUNT_ID = localStorage.getItem("cch_account_id") || "";
var SERVER = localStorage.getItem("cch_server") || window.location.origin;
var THEME = localStorage.getItem("cch_theme") || "light";
var currentSessionId = null;
var refreshTimer = null;

var $ = function(id) { return document.getElementById(id); };

// ---- theme ----

function applyTheme() {
    document.documentElement.setAttribute("data-theme", THEME);
    $("theme-btn").textContent = THEME === "dark" ? "☀" : "🌙";
}
function toggleTheme() {
    THEME = THEME === "light" ? "dark" : "light";
    localStorage.setItem("cch_theme", THEME);
    applyTheme();
}
applyTheme();

// ---- api ----

function api(method, path, body) {
    var h = { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN };
    var o = { method: method, headers: h };
    if (body) o.body = JSON.stringify(body);
    return fetch(SERVER + path, o).then(function(r) {
        if (r.status === 401) { logout(); throw new Error("expired"); }
        if (!r.ok) return r.json().then(function(e) { throw new Error(e.error || r.statusText); });
        return r.json();
    });
}

function ago(ms) {
    var d = Date.now() - ms;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
}
function fmt(ms) { return new Date(ms).toLocaleString(); }
function esc(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// ---- session list ----

function loadSessions() {
    api("GET", "/v1/sessions").then(function(data) {
        var div = $("slist");
        $("scount").textContent = data.sessions.length;
        div.innerHTML = "";
        if (data.sessions.length === 0) {
            div.innerHTML = "<div class=\"empty\">No sessions yet</div>";
            return;
        }
        data.sessions.forEach(function(s) {
            var el = document.createElement("div");
            el.className = "item" + (s.id === currentSessionId ? " active" : "");
            el.innerHTML =
                "<div><span class=\"badge " + (s.active ? "badge-active" : "badge-idle") + "\">" + (s.active ? "Active" : "Idle") + "</span> <span class=\"sub\">" + ago(s.activeAt) + "</span></div>" +
                "<div class=\"sub\">" + esc(s.metadata || "—") + " · " + s.id.slice(0,10) + "</div>";
            el.onclick = function() { selectSession(s.id); };
            div.appendChild(el);
        });
    });
}

function loadMachines() {
    api("GET", "/v1/machines").then(function(data) {
        var div = $("mlist");
        var ms = Array.isArray(data) ? data : [];
        $("mcount").textContent = ms.length;
        div.innerHTML = "";
        ms.forEach(function(m) {
            var el = document.createElement("div");
            el.className = "item";
            el.innerHTML = "<div>" + esc(m.id) + "</div><div class=\"sub\">" + ago(m.activeAt) + "</div>";
            div.appendChild(el);
        });
    });
}

// ---- session detail ----

function selectSession(id) {
    currentSessionId = id;
    $("no-selection").classList.add("hidden");
    $("detail-head").classList.remove("hidden");
    $("detail-head").innerHTML = "<strong>Session</strong> <code>" + id.slice(0,12) + "</code>";
    $("term").classList.add("active");
    $("term-input").classList.add("active");
    $("term").innerHTML = "<div style=\"color:var(--fg2)\">Loading messages...</div>";
    loadMessages();
    // Highlight sidebar
    document.querySelectorAll("#slist .item").forEach(function(el) { el.classList.remove("active"); });
    var match = document.querySelector("#slist .item");
    // re-render
    loadSessions();
}

function loadMessages() {
    if (!currentSessionId) return;
    api("GET", "/v1/sessions/" + currentSessionId + "/plaintext-messages").then(function(data) {
        var term = $("term");
        if (data.messages.length === 0) {
            term.innerHTML = "<div style=\"color:var(--fg2)\">No messages yet. Start a ccd session to see conversation here.</div>";
            return;
        }
        term.innerHTML = "";
        data.messages.forEach(function(m) {
            var div = document.createElement("div");
            div.className = "term-msg role-" + m.role;
            div.innerHTML = "<span style=\"color:var(--fg2);font-size:11px\">[" + m.role + "] " + fmt(m.createdAt) + "</span>\n" + esc(m.content);
            term.appendChild(div);
        });
        term.scrollTop = term.scrollHeight;
    }).catch(function(e) {
        $("term").innerHTML = "<div style=\"color:var(--fg2)\">Cannot load messages: " + e.message + "</div>";
    });
}

function sendMessage() {
    var input = $("msg-input");
    var text = input.value.trim();
    if (!text || !currentSessionId) return;
    input.value = "";
    // Show locally
    var term = $("term");
    var div = document.createElement("div");
    div.className = "term-msg role-user";
    div.innerHTML = "<span style=\"color:var(--fg2);font-size:11px\">[user] just now</span>\n" + esc(text);
    term.appendChild(div);
    term.scrollTop = term.scrollHeight;
    // Send to server
    api("POST", "/v1/sessions/" + currentSessionId + "/plaintext-messages", { role: "user", content: text }).catch(function(e) {
        console.error(e);
    });
}

// ---- connect / logout ----

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
    token = token.replace(/[\s\\"']/g, "");
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
        showDashboard();
    }).catch(function(e) {
        err.textContent = e.message;
        btn.textContent = "Connect";
        btn.disabled = false;
    });
}

function showDashboard() {
    $("connect-screen").style.display = "none";
    $("main-screen").style.display = "flex";
    $("acct-display").textContent = ACCOUNT_ID.slice(0, 12) + "...";
    refresh();
    refreshTimer = setInterval(refresh, 30000);
}

function logout() {
    localStorage.removeItem("cch_token");
    localStorage.removeItem("cch_account_id");
    TOKEN = ""; ACCOUNT_ID = ""; currentSessionId = null;
    $("main-screen").style.display = "none";
    $("connect-screen").style.display = "flex";
    $("connect-btn").textContent = "Connect";
    $("connect-btn").disabled = false;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function refresh() { loadSessions(); loadMachines(); loadTokens(); if (currentSessionId) loadMessages(); }

// ---- tokens ----

function generateToken() {
    var label = $("tk-label").value.trim();
    var body = {};
    if (label) body.label = label;
    $("tk-error").textContent = "";
    api("POST", "/v1/bootstrap-tokens", body).then(function(data) {
        var conn = SERVER + "/connect?token=" + data.token;
        $("new-conn").textContent = conn;
        $("new-tk-area").classList.remove("hidden");
        $("tk-label").value = "";
        var saved = JSON.parse(localStorage.getItem("cch_tokens") || "{}");
        saved[data.record.id] = conn;
        localStorage.setItem("cch_tokens", JSON.stringify(saved));
        loadTokens();
    }).catch(function(e) { $("tk-error").textContent = e.message; });
}

function loadTokens() {
    api("GET", "/v1/bootstrap-tokens").then(function(data) {
        var div = $("tk-list");
        var active = (data.tokens || []).filter(function(t) { return !t.revokedAt; });
        if (active.length === 0) { div.innerHTML = ""; return; }
        var saved = JSON.parse(localStorage.getItem("cch_tokens") || "{}");
        var html = "";
        active.forEach(function(t) {
            html += "<div style=\"font-size:11px;margin-top:4px\">" + esc(t.label||"—") + " " + fmt(t.createdAt);
            if (saved[t.id]) html += " <button class=\"btn-sm\" onclick=\"copyText('" + saved[t.id].replace(/'/g,"\\'") + "')\">Copy</button>";
            html += " <button class=\"btn-sm danger\" onclick=\"revokeToken('" + t.id + "')\">Revoke</button>";
            html += "</div>";
        });
        div.innerHTML = html;
    }).catch(function(){});
}

function revokeToken(id) {
    if (!confirm("Revoke this token?")) return;
    api("POST", "/v1/bootstrap-tokens/" + id + "/revoke").then(function() { loadTokens(); });
}

function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt);
    var ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    return Promise.resolve();
}

// ---- events ----

$("connect-btn").onclick = connect;
$("connect-input").onkeydown = function(e) { if (e.key === "Enter") connect(); };
$("theme-btn").onclick = toggleTheme;
$("refresh-btn").onclick = refresh;
$("logout-btn").onclick = logout;
$("gen-tk-btn").onclick = generateToken;
$("tk-label").onkeydown = function(e) { if (e.key === "Enter") generateToken(); };
$("copy-tk-btn").onclick = function() { copyText($("new-conn").textContent); };
$("send-btn").onclick = sendMessage;
$("msg-input").onkeydown = function(e) { if (e.key === "Enter") sendMessage(); };

var urlToken = new URLSearchParams(window.location.search).get("token");
if (urlToken) { $("connect-input").value = window.location.href; }
if (TOKEN) { showDashboard(); }
