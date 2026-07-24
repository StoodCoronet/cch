var TOKEN = localStorage.getItem("cch_token") || "";
var ACCOUNT_ID = localStorage.getItem("cch_account_id") || "";
var SERVER = localStorage.getItem("cch_server") || window.location.origin;
var THEME = localStorage.getItem("cch_theme") || "light";
var currentSessionId = null;
var currentSession = null;
var allSessions = [];
var refreshTimer = null;
var $ = function(id) { return document.getElementById(id); };

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

// Resizable sidebar
(function initResizer() {
    var saved = parseInt(localStorage.getItem("cch_sidebar_width") || "", 10);
    if (saved >= 220 && saved <= 500) setSidebarWidth(saved);
    var resizer = $("resizer");
    var app = $("app");
    var startX, startWidth, dragging = false;
    function onMove(e) {
        if (!dragging) return;
        var w = Math.max(220, Math.min(500, startWidth + e.clientX - startX));
        setSidebarWidth(w);
    }
    function onUp() {
        dragging = false;
        resizer.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        var w = parseInt(getComputedStyle(app).getPropertyValue("--sidebar-width"), 10);
        localStorage.setItem("cch_sidebar_width", w);
    }
    resizer.addEventListener("mousedown", function(e) {
        e.preventDefault();
        dragging = true;
        resizer.classList.add("dragging");
        startX = e.clientX;
        startWidth = parseInt(getComputedStyle(app).getPropertyValue("--sidebar-width"), 10);
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
})();
function setSidebarWidth(w) {
    $("app").style.setProperty("--sidebar-width", w + "px");
}

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
    if (d < 3600000) return Math.floor(d / 60000) + "m";
    if (d < 86400000) return Math.floor(d / 3600000) + "h";
    return Math.floor(d / 86400000) + "d";
}
function fmt(ms) { return new Date(ms).toLocaleString(); }
function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Panels
function initPanels() {
    document.querySelectorAll(".panel-header").forEach(function(h) {
        h.onclick = function() {
            var body = $(this.dataset.target);
            var open = body.classList.toggle("open");
            this.classList.toggle("open", open);
        };
    });
}
initPanels();

// Modal
function openModal() {
    $("connect-modal").classList.add("open");
    $("tk-label").focus();
}
function closeModal() {
    $("connect-modal").classList.remove("open");
}
$("open-connect-modal").onclick = openModal;
$("close-connect-modal").onclick = closeModal;
$("connect-modal").onclick = function(e) {
    if (e.target === $("connect-modal")) closeModal();
};
document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && $("connect-modal").classList.contains("open")) closeModal();
});

// Search
$("session-search").oninput = function() {
    renderSessions(allSessions);
};

// Mobile menu
$("menu-btn").onclick = function() {
    $("sidebar").classList.toggle("open");
};
function closeSidebar() {
    $("sidebar").classList.remove("open");
}

function loadSessions() {
    api("GET", "/v1/sessions").then(function(data) {
        console.log("loadSessions response:", data);
        allSessions = data.sessions || [];
        $("scount").textContent = allSessions.length;
        renderSessions(allSessions);
    }).catch(function(e) { console.error("loadSessions error:", e); });
}

function renderSessions(sessions) {
    var q = $("session-search").value.trim().toLowerCase();
    var filtered = sessions.filter(function(s) {
        var t = (s.metadata || s.id).toLowerCase();
        return t.indexOf(q) !== -1;
    });
    var div = $("slist");
    div.innerHTML = filtered.length ? "" : '<div class="empty">' + (q ? "No matching sessions" : "No sessions yet") + '</div>';
    filtered.forEach(function(s) {
        var el = document.createElement("div");
        el.className = "session-item" + (s.id === currentSessionId ? " selected" : "");
        var title = (s.metadata || s.id.slice(0, 10)).replace(/[&<>]/g, "");
        el.innerHTML =
            '<div class="title">' +
                '<span class="dot ' + (s.active ? "active" : "idle") + '"></span>' +
                esc(title) +
            '</div>' +
            '<div class="meta">' +
                '<span>' + (s.msgCount || 0) + ' msgs</span>' +
                '<span>·</span>' +
                '<span>' + ago(s.activeAt) + '</span>' +
            '</div>';
        el.onclick = function() { selectSession(s); closeSidebar(); };
        div.appendChild(el);
    });
}

function loadMachines() {
    api("GET", "/v1/machines").then(function(data) {
        var ms = Array.isArray(data) ? data : (data.machines || []);
        $("mcount").textContent = ms.length;
        var body = $("machines-body");
        body.innerHTML = ms.length ? "" : '<div class="empty">No machines yet</div>';
        ms.forEach(function(m) {
            var el = document.createElement("div");
            el.className = "machine-item";
            el.innerHTML = '<div class="name">' + esc(m.id) + '</div><div class="time">' + ago(m.activeAt) + '</div>';
            body.appendChild(el);
        });
    }).catch(function(e) { console.error(e); });
}

function selectSession(s) {
    currentSessionId = s.id;
    currentSession = s;
    renderSessions(allSessions);
    $("placeholder").classList.add("hidden");
    $("messages").classList.remove("hidden");
    $("input-area").classList.toggle("hidden", !s.isPlaintext);
    $("chat-title").textContent = esc(s.metadata || s.id.slice(0, 12));
    $("chat-meta").textContent = "Created " + fmt(s.createdAt) + (s.machineName ? " · " + esc(s.machineName) : "");
    $("messages-inner").innerHTML = '<div class="empty">Loading messages...</div>';
    loadMessages();
}

function loadMessages() {
    if (!currentSessionId) return;
    api("GET", "/v1/sessions/" + currentSessionId + "/plaintext-messages").then(function(data) {
        var container = $("messages-inner");
        var messages = data.messages || [];
        if (messages.length === 0) {
            container.innerHTML = '<div class="empty">No messages yet.</div>';
            return;
        }
        container.innerHTML = "";
        messages.forEach(function(m) { appendMessageToDOM(m.role, m.content, false); });
        scrollToBottom();
    }).catch(function(e) {
        $("messages-inner").innerHTML = '<div class="empty">Cannot load messages.</div>';
        console.error(e);
    });
}

function scrollToBottom() {
    var m = $("messages");
    m.scrollTop = m.scrollHeight;
}

function formatContent(text) {
    var html = esc(text);
    // Code blocks
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
        return '<pre><button class="copy-code">Copy</button><code>' + esc(code.trim()) + '</code></pre>';
    });
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Paragraphs
    var parts = html.split(/\n\n+/);
    return parts.map(function(p) {
        if (p.indexOf("<pre") === 0 || p.indexOf("<div") === 0) return p;
        return '<p>' + p.replace(/\n/g, "<br>") + '</p>';
    }).join("");
}

function appendMessageToDOM(role, content, autoScroll) {
    var container = $("messages-inner");
    var empty = container.querySelector(".empty");
    if (empty) empty.remove();
    var msg = document.createElement("div");
    msg.className = "message " + role;
    var avatar = role === "user" ? "Y" : "AI";
    msg.innerHTML =
        '<div class="avatar">' + avatar + '</div>' +
        '<div class="content">' +
            '<div class="role">' + esc(role || "unknown") + '</div>' +
            '<div class="bubble">' + formatContent(content) + '</div>' +
        '</div>';
    container.appendChild(msg);
    msg.querySelectorAll(".copy-code").forEach(function(btn) {
        btn.onclick = function() {
            var code = this.nextElementSibling.textContent;
            copyText(code).then(function() {
                btn.textContent = "Copied!";
                setTimeout(function() { btn.textContent = "Copy"; }, 2000);
            });
        };
    });
    if (autoScroll) scrollToBottom();
}

function sendMessage() {
    var input = $("msg-input");
    var text = input.value.trim();
    if (!text || !currentSessionId) return;
    input.value = "";
    input.style.height = "auto";
    $("send-btn").disabled = true;
    appendMessageToDOM("user", text, true);
    api("POST", "/v1/sessions/" + currentSessionId + "/plaintext-messages", { role: "user", content: text })
        .then(function() { if (currentSessionId) loadMessages(); })
        .catch(function(e) { console.error(e); });
}

// Textarea auto-resize
$("msg-input").addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(180, this.scrollHeight) + "px";
    $("send-btn").disabled = !this.value.trim();
});
$("msg-input").addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
$("send-btn").onclick = sendMessage;

// Login tabs
document.querySelectorAll(".connect-tab").forEach(function(tab) {
    tab.onclick = function() {
        document.querySelectorAll(".connect-tab").forEach(function(t) { t.classList.remove("active"); });
        document.querySelectorAll(".connect-form").forEach(function(f) { f.classList.remove("active"); });
        tab.classList.add("active");
        $(tab.dataset.target).classList.add("active");
    };
});

function finishLogin(d) {
    TOKEN = d.token; ACCOUNT_ID = d.accountId;
    localStorage.setItem("cch_token", TOKEN);
    localStorage.setItem("cch_account_id", ACCOUNT_ID);
    showDashboard();
}

function loginWithPassword() {
    var username = $("login-username").value.trim();
    var password = $("login-password").value;
    if (!username || !password) return;
    var btn = $("login-btn"), err = $("login-error");
    err.textContent = ""; btn.textContent = "Signing in..."; btn.disabled = true;

    fetch(SERVER + "/v1/auth/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, password: password })
    }).then(function(r) {
        if (!r.ok) return r.json().then(function(e) { throw new Error(e.error || "Invalid"); });
        return r.json();
    }).then(finishLogin).catch(function(e) {
        err.textContent = e.message; btn.textContent = "Sign In"; btn.disabled = false;
    });
}

// Connect
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
    }).then(finishLogin).catch(function(e) {
        err.textContent = e.message; btn.textContent = "Connect"; btn.disabled = false;
    });
}

function showDashboard() {
    $("connect-screen").style.display = "none";
    loadSessions(); loadMachines(); loadTokens();
    refreshTimer = setInterval(refresh, 30000);
}

function logout() {
    ["cch_token", "cch_account_id"].forEach(function(k) { localStorage.removeItem(k); });
    TOKEN = ""; ACCOUNT_ID = ""; currentSessionId = null; currentSession = null; allSessions = [];
    location.reload();
}

function refresh() { loadSessions(); loadMachines(); loadTokens(); if (currentSessionId) loadMessages(); }

// Tokens
function generateToken() {
    var label = $("tk-label").value.trim(), body = {};
    if (label) body.label = label;
    $("tk-error").textContent = "";
    api("POST", "/v1/bootstrap-tokens", body).then(function(data) {
        $("new-conn").textContent = data.record.connectionUrl;
        $("new-tk-area").classList.remove("hidden");
        $("tk-label").value = "";
        loadTokens();
    }).catch(function(e) { $("tk-error").textContent = e.message; });
}

function loadTokens() {
    api("GET", "/v1/bootstrap-tokens").then(function(data) {
        var active = (data.tokens || []).filter(function(t) { return !t.revokedAt; });
        var div = $("tk-list");
        div.innerHTML = active.length ? "" : '<div class="empty">No tokens yet</div>';
        active.forEach(function(t) {
            var row = document.createElement("div");
            row.className = "token-list-item";
            var conn = t.connectionUrl || "";
            var label = t.label || "—";
            var actions = '<button onclick="startEditLabel(this.parentElement.previousElementSibling.querySelector(\'.name\'), \'' + t.id.replace(/'/g, "\\'") + '\', \'' + label.replace(/'/g, "\\'") + '\')">Edit</button>';
            if (conn) {
                actions +=
                    '<button onclick="copyText(\'' + conn.replace(/'/g, "\\'") + '\')">Copy link</button>' +
                    '<button onclick="copyText(copyForCch(\'' + conn.replace(/'/g, "\\'") + '\'))">cch</button>' +
                    '<button onclick="copyText(copyForCcd(\'' + conn.replace(/'/g, "\\'") + '\'))">ccd</button>';
            }
            actions += '<button class="revoke" onclick="revokeToken(\'' + t.id.replace(/'/g, "\\'") + '\')">Revoke</button>';
            row.innerHTML =
                '<div class="info">' +
                    '<div class="name" onclick="startEditLabel(this, \'' + t.id.replace(/'/g, "\\'") + '\', \'' + label.replace(/'/g, "\\'") + '\')">' + esc(label) + '</div>' +
                    '<div class="time">' + fmt(t.createdAt) + '</div>' +
                '</div>' +
                '<div class="actions">' + actions + '</div>';
            div.appendChild(row);
        });
    }).catch(function(e) { console.error(e); });
}

function revokeToken(id) { if (confirm("Revoke this token?")) api("POST", "/v1/bootstrap-tokens/" + id + "/revoke").then(loadTokens); }

function updateTokenLabel(id, label) {
    if (!label.trim()) return;
    api("PATCH", "/v1/bootstrap-tokens/" + id, { label: label.trim() }).then(loadTokens).catch(function(e) { alert(e.message); });
}

function startEditLabel(el, id, current) {
    var parent = el.parentElement;
    parent.innerHTML = '<input type="text" class="name-edit" value="' + esc(current) + '" />';
    var input = parent.querySelector(".name-edit");
    input.focus();
    input.select();
    function save() {
        updateTokenLabel(id, input.value);
    }
    input.onkeydown = function(e) {
        if (e.key === "Enter") save();
        if (e.key === "Escape") loadTokens();
    };
    input.onblur = save;
}

function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt);
    var ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    return Promise.resolve();
}

function terminalQuote(s) {
    if (s.indexOf("'") === -1) return "'" + s + "'";
    if (s.indexOf('"') === -1) return '"' + s + '"';
    return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function copyForCch(conn) {
    return "./target/release/cch connect " + terminalQuote(conn);
}
function copyForCcd(conn) {
    return "./target/release/ccd connect " + terminalQuote(conn);
}

// Events
$("connect-btn").onclick = connect;
$("connect-input").onkeydown = function(e) { if (e.key === "Enter") connect(); };
$("login-btn").onclick = loginWithPassword;
$("login-password").onkeydown = function(e) { if (e.key === "Enter") loginWithPassword(); };
$("refresh-btn").onclick = refresh;
$("logout-btn").onclick = logout;
$("gen-tk-btn").onclick = generateToken;
$("tk-label").onkeydown = function(e) { if (e.key === "Enter") generateToken(); };
$("copy-cch-btn").onclick = function() { copyText(copyForCch($("new-conn").textContent)); };
$("copy-ccd-btn").onclick = function() { copyText(copyForCcd($("new-conn").textContent)); };
$("copy-url-btn").onclick = function() { copyText($("new-conn").textContent); };

var ut = new URLSearchParams(window.location.search).get("token");
if (ut) $("connect-input").value = window.location.href;
if (TOKEN) showDashboard();
