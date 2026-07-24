var TOKEN = localStorage.getItem("cch_token") || "";
var ACCOUNT_ID = localStorage.getItem("cch_account_id") || "";
var SERVER = localStorage.getItem("cch_server") || window.location.origin;
var THEME = localStorage.getItem("cch_theme") || "light";
var currentSessionId = null;
var refreshTimer = null;
var $ = function(id) { return document.getElementById(id); };

// theme
function applyTheme() {
    document.documentElement.setAttribute("data-theme", THEME);
    $("theme-btn").textContent = THEME === "dark" ? "☀" : "🌙";
}
applyTheme();
$("theme-btn").onclick = function() {
    THEME = THEME === "light" ? "dark" : "light";
    localStorage.setItem("cch_theme", THEME);
    applyTheme();
};

// api
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

// sessions & machines
function loadSessions() {
    api("GET", "/v1/sessions").then(function(data) {
        $("scount").textContent = data.sessions.length;
        var div = $("slist");
        div.innerHTML = data.sessions.length ? "" : "<div class=\"empty\">No sessions yet</div>";
        data.sessions.forEach(function(s) {
            var c = document.createElement("div");
            c.className = "card" + (s.id === currentSessionId ? " selected" : "");
            c.innerHTML =
                '<div class="title">' + (s.metadata || s.id.slice(0,10)).replace(/[&<>]/g,"") + '</div>' +
                '<div class="meta"><span class="badge ' + (s.active ? "badge-active" : "badge-idle") + '">' + (s.active ? "Active" : "Idle") + '</span> · ' + ago(s.activeAt) + '</div>';
            c.onclick = function() { selectSession(s.id); };
            div.appendChild(c);
        });
    });
}

function loadMachines() {
    api("GET", "/v1/machines").then(function(data) {
        var ms = Array.isArray(data) ? data : [];
        $("mcount").textContent = ms.length;
        var div = $("mlist");
        div.innerHTML = "";
        ms.forEach(function(m) {
            var c = document.createElement("div");
            c.className = "card";
            c.innerHTML = '<div class="title">' + m.id.replace(/[&<>]/g,"") + '</div><div class="meta">' + ago(m.activeAt) + '</div>';
            div.appendChild(c);
        });
    });
}

// session detail
function selectSession(id) {
    currentSessionId = id;
    $("no-selection").style.display = "none";
    $("term-container").classList.add("active");
    $("term-header").innerHTML = '<strong>Session</strong> <code style="font-size:12px">' + id.slice(0,12) + '</code>';
    $("term-body").innerHTML = '<span style="color:var(--fg2)">Loading...</span>';
    loadMessages();
    loadSessions();
}

function loadMessages() {
    if (!currentSessionId) return;
    api("GET", "/v1/sessions/" + currentSessionId + "/plaintext-messages").then(function(data) {
        var body = $("term-body");
        if (data.messages.length === 0) {
            body.innerHTML = '<span style="color:var(--fg2)">No messages yet.</span>';
            return;
        }
        body.innerHTML = "";
        data.messages.forEach(function(m) {
            var d = document.createElement("div");
            d.className = "msg " + m.role;
            d.innerHTML = '<div class="role">' + m.role + '</div><div class="content">' + esc(m.content) + '</div>';
            body.appendChild(d);
        });
        body.scrollTop = body.scrollHeight;
    }).catch(function(e) {
        $("term-body").innerHTML = '<span style="color:var(--fg2)">Cannot load messages.</span>';
    });
}

function sendMessage() {
    var input = $("msg-input");
    var text = input.value.trim();
    if (!text || !currentSessionId) return;
    input.value = "";
    var body = $("term-body");
    var d = document.createElement("div");
    d.className = "msg user";
    d.innerHTML = '<div class="role">user</div><div class="content">' + esc(text) + '</div>';
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
    api("POST", "/v1/sessions/" + currentSessionId + "/plaintext-messages", { role: "user", content: text }).catch(function(e) { console.error(e); });
}

// connect
function connect() {
    var input = $("connect-input").value.trim();
    if (!input) return;
    var token = input;
    if (input.indexOf("?token=") !== -1) {
        token = input.split("?token=")[1];
        if (input.indexOf("://") !== -1) {
            var s = input.indexOf("://") + 3, e = input.indexOf("/", s);
            SERVER = input.substring(0, e);
            localStorage.setItem("cch_server", SERVER);
        }
    }
    token = token.replace(/[\s\\"']/g, "");
    var btn = $("connect-btn"), err = $("connect-error");
    err.textContent = ""; btn.textContent = "Connecting..."; btn.disabled = true;

    fetch(SERVER + "/v1/auth/bootstrap", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token, hostname: "web" })
    }).then(function(r) {
        if (!r.ok) return r.json().then(function(e) { throw new Error(e.error || "Invalid"); });
        return r.json();
    }).then(function(d) {
        TOKEN = d.token; ACCOUNT_ID = d.accountId;
        localStorage.setItem("cch_token", TOKEN);
        localStorage.setItem("cch_account_id", ACCOUNT_ID);
        showDashboard();
    }).catch(function(e) {
        err.textContent = e.message; btn.textContent = "Connect"; btn.disabled = false;
    });
}

function showDashboard() {
    $("connect-screen").style.display = "none";
    $("dashboard").classList.remove("hidden");
    $("dashboard").style.display = "flex";
    $("acct-display").textContent = ACCOUNT_ID.slice(0,12) + "...";
    refresh(); refreshTimer = setInterval(refresh, 30000);
}

function logout() {
    ["cch_token","cch_account_id"].forEach(function(k) { localStorage.removeItem(k); });
    TOKEN = ""; ACCOUNT_ID = ""; currentSessionId = null;
    $("dashboard").classList.add("hidden"); $("connect-screen").style.display = "flex";
    $("connect-btn").textContent = "Connect"; $("connect-btn").disabled = false;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function refresh() { loadSessions(); loadMachines(); loadTokens(); if (currentSessionId) loadMessages(); }

// tokens
function generateToken() {
    var label = $("tk-label").value.trim(), body = {};
    if (label) body.label = label;
    $("tk-error").textContent = "";
    api("POST", "/v1/bootstrap-tokens", body).then(function(data) {
        var conn = SERVER + "/connect?token=" + data.token;
        $("new-conn").textContent = conn; $("new-tk-area").classList.remove("hidden");
        $("tk-label").value = "";
        var s = JSON.parse(localStorage.getItem("cch_tokens") || "{}");
        s[data.record.id] = conn; localStorage.setItem("cch_tokens", JSON.stringify(s));
        loadTokens();
    }).catch(function(e) { $("tk-error").textContent = e.message; });
}

function loadTokens() {
    api("GET", "/v1/bootstrap-tokens").then(function(data) {
        var active = (data.tokens||[]).filter(function(t){return !t.revokedAt;});
        var saved = JSON.parse(localStorage.getItem("cch_tokens")||"{}"), html = "";
        active.forEach(function(t) {
            html += '<div style="margin-top:4px">' + (t.label||"—") + " " + fmt(t.createdAt);
            if (saved[t.id]) html += ' <button style="font-size:11px;padding:2px 6px;border:1px solid var(--bd);border-radius:4px;cursor:pointer" onclick="copyText(\'' + saved[t.id].replace(/'/g,"\\'") + '\')">Copy</button>';
            html += ' <button style="font-size:11px;padding:2px 6px;border:1px solid var(--red);border-radius:4px;color:var(--red);cursor:pointer" onclick="revokeToken(\'' + t.id + '\')">×</button>';
            html += '</div>';
        });
        $("tk-list").innerHTML = html;
    }).catch(function(){});
}

function revokeToken(id) { if(confirm("Revoke?")) api("POST","/v1/bootstrap-tokens/"+id+"/revoke").then(loadTokens); }

function copyText(txt) {
    if (navigator.clipboard&&navigator.clipboard.writeText) return navigator.clipboard.writeText(txt);
    var ta=document.createElement("textarea");ta.value=txt;ta.style.position="fixed";ta.style.left="-9999px";
    document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);
    return Promise.resolve();
}

function esc(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// events
$("connect-btn").onclick = connect;
$("connect-input").onkeydown = function(e) { if (e.key==="Enter") connect(); };
$("refresh-btn").onclick = refresh;
$("logout-btn").onclick = logout;
$("gen-tk-btn").onclick = generateToken;
$("tk-label").onkeydown = function(e) { if (e.key==="Enter") generateToken(); };
$("copy-tk-btn").onclick = function() { copyText($("new-conn").textContent); };
$("send-btn").onclick = sendMessage;
$("msg-input").onkeydown = function(e) { if (e.key==="Enter") sendMessage(); };

var ut = new URLSearchParams(window.location.search).get("token");
if (ut) $("connect-input").value = window.location.href;
if (TOKEN) showDashboard();
