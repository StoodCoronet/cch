var TOKEN = localStorage.getItem("cch_token") || "";
var ACCOUNT_ID = localStorage.getItem("cch_account_id") || "";
var SERVER = localStorage.getItem("cch_server") || window.location.origin;
var THEME = localStorage.getItem("cch_theme") || "light";
var currentSessionId = null;
var currentSession = null;
var allSessions = [];
var refreshTimer = null;
var socket = null;

// Transcript view state
var termState = null;       // running | exited | offline | null (unknown)
var sessionStates = {};     // sessionId -> {state, exitCode} remembered across switches
var sessionMeta = {};       // sessionId -> {title, deviceName, cwd, claudeSessionId} from term:meta
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
        var t = (s.tag || s.id).toLowerCase();
        return t.indexOf(q) !== -1;
    });
    var div = $("slist");
    div.innerHTML = filtered.length ? "" : '<div class="empty">' + (q ? "No matching sessions" : "No sessions yet") + '</div>';
    filtered.forEach(function(s) {
        var el = document.createElement("div");
        el.className = "session-item" + (s.id === currentSessionId ? " selected" : "");
        var meta = sessionMeta[s.id] || {};
        var title = (meta.title || s.tag || s.id.slice(0, 10)).replace(/[&<>]/g, "");
        var device = meta.deviceName || s.machineName || "";
        el.innerHTML =
            '<div class="title">' +
                '<span class="dot ' + (s.active ? "active" : "idle") + '"></span>' +
                esc(title) +
            '</div>' +
            '<div class="meta">' +
                (device ? '<span>' + esc(device) + '</span><span>·</span>' : '') +
                '<span>' + (s.msgCount || 0) + ' msgs</span>' +
                '<span>·</span>' +
                '<span>' + ago(s.activeAt) + '</span>' +
                '<button class="delete-btn" onclick="deleteSession(\'' + s.id.replace(/'/g, "\\'") + '\', event)">×</button>' +
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
    $("input-area").classList.remove("hidden");
    updateTermHeader();
    var stored = sessionStates[s.id] || {};
    setTermState(stored.state || null, stored.exitCode);
    // Ask the daemon-side registry for the live state — cached state may be
    // stale or missing entirely when the web page opens after the daemon.
    if (socket && socket.connected) {
        socket.emit("term:query-state", { sessionId: s.id }, function(ack) {
            if (s.id !== currentSessionId) return;
            if (ack && ack.ok) {
                setTermState(ack.state, ack.exitCode);
                if (ack.meta) applySessionMeta(s.id, ack.meta);
            }
        });
    }
    $("messages-inner").innerHTML = '<div class="empty">Loading messages...</div>';
    loadMessages();
}

function deleteSession(id, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (!confirm("Delete this session? It will reappear if the host restarts claude.")) return;
    api("DELETE", "/v1/sessions/" + id).then(function() {
        if (currentSessionId === id) {
            currentSessionId = null;
            currentSession = null;
            $("messages").classList.add("hidden");
            $("input-area").classList.add("hidden");
            $("term-title").textContent = "Select a session";
            $("term-device").textContent = "";
            setTermState(null);
            $("placeholder").classList.remove("hidden");
        }
        loadSessions();
    }).catch(function(e) { alert(e.message); });
}

// ===== Transcript view (plaintext messages over REST + Socket.IO) =====

function setTermState(state, exitCode) {
    termState = state;
    if (currentSessionId) {
        sessionStates[currentSessionId] = { state: state, exitCode: exitCode };
    }
    var dot = $("term-dot");
    dot.className = "term-dot" + (state ? " " + state : " hidden");
    var txt = $("term-state-text");
    if (state === "exited") {
        txt.textContent = "session exited" + (exitCode != null ? " (code " + exitCode + ")" : "") + " — input disabled";
    } else if (state === "offline") {
        txt.textContent = "device offline — input disabled";
    } else if (state === "running") {
        txt.textContent = "";
    } else {
        txt.textContent = "session not running";
    }
    updateInputState();
}

function updateInputState() {
    var running = termState === "running";
    var input = $("msg-input");
    input.disabled = !running;
    input.placeholder = running ? "Send a message..." : "session not running";
    $("send-btn").disabled = !running || !input.value.trim();
}

function updateTermHeader() {
    if (!currentSession) return;
    var meta = sessionMeta[currentSessionId] || {};
    $("term-title").textContent = meta.title || currentSession.tag || currentSession.id.slice(0, 12);
    $("term-device").textContent = meta.deviceName || currentSession.machineName || "";
}

function applySessionMeta(sessionId, meta) {
    if (!meta) return;
    var merged = sessionMeta[sessionId] || {};
    for (var k in meta) merged[k] = meta[k];
    sessionMeta[sessionId] = merged;
    if (sessionId === currentSessionId) updateTermHeader();
    renderSessions(allSessions);
}

function applySessionState(sessionId, state, exitCode) {
    if (!sessionId || !state) return;
    sessionStates[sessionId] = { state: state, exitCode: exitCode };
    if (sessionId === currentSessionId) setTermState(state, exitCode);
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
        messages.forEach(function(m) { renderMessage(container, m); });
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

function appendMessage(m, autoScroll) {
    var container = $("messages-inner");
    var empty = container.querySelector(".empty");
    if (empty) empty.remove();
    renderMessage(container, m);
    if (autoScroll) scrollToBottom();
}

function renderMessage(container, m) {
    var role = m.role;
    var meta = m.metadata || {};
    var hasToolResults = role === "user" && Array.isArray(meta.toolResults) && meta.toolResults.length > 0;

    var entry = document.createElement("div");
    entry.className = "entry";

    if (hasToolResults) {
        // Tool results travel as role=user messages; render them as indented
        // ⎿ blocks without the ❯ user prompt.
        meta.toolResults.forEach(function(tr) {
            entry.appendChild(renderToolResult(tr));
        });
    } else {
        if (role === "assistant" && meta.thinking) {
            entry.appendChild(renderThinkingBlock(meta.thinking));
        }
        if (m.content && m.content.trim()) {
            entry.appendChild(renderTextLine(role, m.content));
        }
        if (role === "assistant" && Array.isArray(meta.toolCalls)) {
            meta.toolCalls.forEach(function(tc) {
                entry.appendChild(renderToolCall(tc));
            });
        }
        if (role === "assistant" && meta.tokens && (meta.tokens.input || meta.tokens.output)) {
            var tok = document.createElement("div");
            tok.className = "tokens-line";
            tok.textContent = "✻ " + (meta.tokens.input || 0) + "↑ " + (meta.tokens.output || 0) + "↓";
            entry.appendChild(tok);
        }
    }

    if (m.createdAt) {
        var time = document.createElement("div");
        time.className = "entry-time";
        time.textContent = fmt(m.createdAt);
        entry.appendChild(time);
    }
    container.appendChild(entry);
}

function renderTextLine(role, content) {
    var line = document.createElement("div");
    line.className = "entry-line " + (role === "user" ? "user" : "assistant");
    var prompt = document.createElement("div");
    prompt.className = "entry-prompt";
    prompt.textContent = role === "user" ? "❯" : "⏺";
    var body = document.createElement("div");
    body.className = "entry-content";
    body.innerHTML = formatContent(content);
    line.appendChild(prompt);
    line.appendChild(body);
    return line;
}

// Plain text + fenced code blocks (<pre>); no full markdown.
function formatContent(text) {
    var codeBlocks = [];
    // esc() first; extracted code chunks are already escaped, do not re-escape
    var html = esc(text);
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code) {
        var placeholder = "\x00CODEBLOCK_" + codeBlocks.length + "\x00";
        codeBlocks.push("<pre><code>" + code.trim() + "</code></pre>");
        return placeholder;
    });
    var parts = html.split(/\n\n+/);
    html = parts.map(function(p) {
        if (p.indexOf("\x00CODEBLOCK_") !== -1) return p;
        return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("");
    html = html.replace(/\x00CODEBLOCK_(\d+)\x00/g, function(_, i) {
        return codeBlocks[parseInt(i, 10)];
    });
    return html;
}

function renderThinkingBlock(thinking) {
    var wrap = document.createElement("div");
    wrap.className = "thinking-block";
    var header = document.createElement("div");
    header.className = "thinking-toggle";
    header.textContent = "Thought for a while (click to expand)";
    var body = document.createElement("div");
    body.className = "thinking-body";
    body.textContent = thinking;
    header.onclick = function() {
        var open = wrap.classList.toggle("open");
        header.textContent = "Thought for a while " + (open ? "(click to collapse)" : "(click to expand)");
    };
    wrap.appendChild(header);
    wrap.appendChild(body);
    return wrap;
}

var TOOL_ARG_KEYS = {
    Bash: "command", Read: "file_path", Write: "file_path", Edit: "file_path",
    MultiEdit: "file_path", NotebookEdit: "notebook_path", Glob: "pattern",
    Grep: "pattern", LS: "path", WebFetch: "url", WebSearch: "query",
    Task: "description"
};

function toolCallKeyArg(name, args) {
    if (!args || typeof args !== "object") return "";
    var v = args[TOOL_ARG_KEYS[name]];
    if (typeof v !== "string") {
        for (var k in args) {
            if (typeof args[k] === "string") { v = args[k]; break; }
        }
    }
    if (typeof v !== "string") return "";
    v = v.replace(/\s+/g, " ").trim();
    return v.length > 80 ? v.slice(0, 80) + "…" : v;
}

function renderToolCall(tc) {
    var wrap = document.createElement("div");
    wrap.className = "tool-call";
    var summary = document.createElement("div");
    summary.className = "tool-call-summary";
    var arg = toolCallKeyArg(tc.name, tc.args);
    summary.innerHTML =
        '<span class="entry-prompt">⏺</span>' +
        '<span class="tool-call-text">' + esc(tc.name || "tool") + "(" + esc(arg) + ")</span>";
    wrap.appendChild(summary);
    var argsText = "";
    if (tc.args) {
        try { argsText = JSON.stringify(tc.args, null, 2); } catch (e) { argsText = String(tc.args); }
    }
    if (argsText) {
        var pre = document.createElement("pre");
        pre.className = "tool-call-args";
        pre.textContent = argsText;
        wrap.appendChild(pre);
        summary.title = "Click to expand args";
        summary.onclick = function() { wrap.classList.toggle("open"); };
    }
    return wrap;
}

var RESULT_COLLAPSE_LINES = 10;

function renderToolResult(tr) {
    var wrap = document.createElement("div");
    wrap.className = "tool-result" + (tr && tr.isError ? " error" : "");
    var prompt = document.createElement("span");
    prompt.className = "result-prompt";
    prompt.textContent = "⎿";
    var right = document.createElement("div");
    right.className = "result-right";
    var body = document.createElement("div");
    body.className = "result-body";
    var text = tr && tr.content != null ? String(tr.content) : "";
    var lines = text.split("\n");
    if (lines.length > RESULT_COLLAPSE_LINES) {
        var head = lines.slice(0, RESULT_COLLAPSE_LINES).join("\n");
        body.textContent = head;
        var hidden = lines.length - RESULT_COLLAPSE_LINES;
        var toggle = document.createElement("div");
        toggle.className = "result-collapse-toggle";
        toggle.textContent = "… +" + hidden + " lines (click to expand)";
        var expanded = false;
        toggle.onclick = function() {
            expanded = !expanded;
            body.textContent = expanded ? text : head;
            toggle.textContent = expanded ? "▾ collapse" : "… +" + hidden + " lines (click to expand)";
        };
        right.appendChild(body);
        right.appendChild(toggle);
    } else {
        body.textContent = text;
        right.appendChild(body);
    }
    wrap.appendChild(prompt);
    wrap.appendChild(right);
    return wrap;
}

// Send user input into the claude PTY via the daemon relay. No optimistic
// render and no REST POST: the message reappears once the jsonl watcher
// pushes it back as a plaintext-message update.
function sendMessage() {
    var input = $("msg-input");
    var text = input.value.trim();
    if (!text || !currentSessionId || termState !== "running" || !socket) return;
    socket.emit("term:input", { sessionId: currentSessionId, data: text + "\r" });
    input.value = "";
    input.style.height = "auto";
    $("send-btn").disabled = true;
}

// Textarea auto-resize
$("msg-input").addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(180, this.scrollHeight) + "px";
    $("send-btn").disabled = termState !== "running" || !this.value.trim();
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
        var target = $(tab.dataset.target);
        target.classList.add("active");
        // Clear errors and focus first input
        document.querySelectorAll(".connect-form .error").forEach(function(e) { e.textContent = ""; });
        var firstInput = target.querySelector("input");
        if (firstInput) firstInput.focus();
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
    initSocket();
    refreshTimer = setInterval(refresh, 30000);
}

function initSocket() {
    if (socket) return;
    console.log('Initializing Socket.IO with token:', TOKEN ? 'present' : 'missing');
    socket = io(SERVER, {
        path: '/v1/updates',
        auth: { token: TOKEN, clientType: 'user-scoped' },
        transports: ['websocket', 'polling'],
    });

    socket.on('connect', function() {
        console.log('Socket.IO connected');
        // After a reconnect, any plaintext messages pushed while offline were
        // missed; reload the open transcript from REST.
        if (currentSessionId) loadMessages();
    });

    socket.on('connect_error', function(err) {
        console.error('Socket.IO connect error:', err);
    });

    socket.on('update', function(payload) {
        if (!payload || !payload.body || payload.body.t !== 'plaintext-message') return;
        if (payload.body.sid !== currentSessionId) return;
        appendMessage(payload.body.message, true);
    });

    // Session lifecycle/meta (term:state/term:meta) are fanned out to
    // user-scoped connections as ephemeral events (no room join required).
    socket.on('ephemeral', function(payload) {
        if (!payload || !payload.sessionId) return;
        if (payload.type === 'terminal-state') {
            applySessionState(payload.sessionId, payload.state, payload.exitCode);
        } else if (payload.type === 'terminal-meta') {
            applySessionMeta(payload.sessionId, payload.meta);
        }
    });

    socket.on('term:state', function(msg) {
        if (!msg || !msg.sessionId) return;
        applySessionState(msg.sessionId, msg.state, msg.exitCode);
    });

    socket.on('term:meta', function(msg) {
        if (!msg || !msg.sessionId) return;
        applySessionMeta(msg.sessionId, msg.meta);
    });

    socket.on('disconnect', function() {
        console.log('Socket.IO disconnected');
    });
}

function logout() {
    ["cch_token", "cch_account_id"].forEach(function(k) { localStorage.removeItem(k); });
    TOKEN = ""; ACCOUNT_ID = ""; currentSessionId = null; currentSession = null; allSessions = [];
    location.reload();
}

function refresh() {
    loadSessions();
    loadMachines();
    loadTokens();
}

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
                    '<button onclick="copyText(copyForCcd(\'' + conn.replace(/'/g, "\\'") + '\'))">ccd</button>' +
                    '<button onclick="copyText(copyForNode(\'' + conn.replace(/'/g, "\\'") + '\'))">node</button>';
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

function shellQuote(s) {
    if (s.indexOf("'") === -1) return "'" + s + "'";
    if (s.indexOf('"') === -1) return '"' + s + '"';
    return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function copyForCch(conn) {
    return "./target/release/cch connect " + shellQuote(conn);
}
function copyForCcd(conn) {
    return "./target/release/ccd connect " + shellQuote(conn);
}
function copyForNode(conn) {
    return "node index.js connect " + shellQuote(conn) + " && node index.js";
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
$("copy-node-btn").onclick = function() { copyText(copyForNode($("new-conn").textContent)); };
$("copy-url-btn").onclick = function() { copyText($("new-conn").textContent); };

var ut = new URLSearchParams(window.location.search).get("token");
if (ut) $("connect-input").value = window.location.href;
if (TOKEN) showDashboard();
