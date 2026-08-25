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

// Live terminal overlay state (xterm.js over Socket.IO relay)
var term = null;            // xterm Terminal instance while the overlay is open
var termFit = null;         // FitAddon instance
var termRO = null;          // ResizeObserver on the terminal container
var termResizeTimer = null; // debounce timer for fit/resize
var termOpen = false;       // whether the overlay is currently shown
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
    if (e.key !== "Escape") return;
    if ($("connect-modal").classList.contains("open")) closeModal();
    if ($("add-modal").classList.contains("open")) closeAddModal();
    if ($("settings-modal").classList.contains("open")) closeSettings();
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

// Deleting a session (single or Clear) hard-deletes the server row. The row
// reappears when the host becomes active again (daemon re-registers on write
// failures, and resume recreates it via tag alignment).
function loadSessions() {
    return api("GET", "/v1/sessions").then(function(data) {
        console.log("loadSessions response:", data);
        allSessions = data.sessions || [];
        $("scount").textContent = allSessions.length;
        renderSessions(allSessions);
    }).catch(function(e) { console.error("loadSessions error:", e); });
}

// Group key for the sidebar: prefer the daemon-reported cwd; otherwise strip
// the trailing "-<8hex>"/"-pending-<id8>" suffix from the tag to recover the
// project directory slug.
function sessionGroup(s) {
    var meta = sessionMeta[s.id] || {};
    if (meta.cwd) {
        var parts = meta.cwd.split("/").filter(Boolean);
        return { key: "cwd:" + meta.cwd, label: parts.length ? parts[parts.length - 1] : meta.cwd };
    }
    var tag = s.tag || "";
    if (tag) {
        var slug = tag.replace(/-pending-[^-]+$/i, "").replace(/-[0-9a-f]{8}$/i, "");
        var segs = slug.split("-").filter(Boolean);
        var label = segs.length ? segs[segs.length - 1] : slug;
        // Hyphenated directory names (e.g. "node-ccd") end in a short suffix
        // segment; fold it back onto the previous one for a readable label.
        if (label.length <= 3 && segs.length > 1) {
            label = segs[segs.length - 2] + "-" + label;
        }
        return { key: "slug:" + slug, label: label || slug };
    }
    return { key: "ungrouped", label: "ungrouped" };
}

function getCollapsedGroups() {
    try { return JSON.parse(localStorage.getItem("cch_group_collapsed") || "{}") || {}; } catch (e) { return {}; }
}
function toggleGroup(key) {
    var collapsed = getCollapsedGroups();
    if (collapsed[key]) delete collapsed[key]; else collapsed[key] = true;
    localStorage.setItem("cch_group_collapsed", JSON.stringify(collapsed));
    renderSessions(allSessions);
}

function groupLastActive(g) {
    var t = 0;
    g.items.forEach(function(s) { if ((s.activeAt || 0) > t) t = s.activeAt || 0; });
    return t;
}

// Title shown in the sidebar: live socket meta > persisted row meta > tag.
// The persisted meta (daemon PATCHes it onto the row) is what makes
// conversation names survive a page refresh.
function sessionDisplayTitle(s) {
    var live = (sessionMeta[s.id] || {}).title;
    if (live) return live;
    try {
        var persisted = JSON.parse(s.metadata || "{}");
        if (persisted && persisted.title) return persisted.title;
    } catch (e) { /* metadata may be a plain hostname string */ }
    return null;
}

function renderSessionItem(s) {
    var el = document.createElement("div");
    var st = sessionStates[s.id];
    el.className = "session-item" + (s.id === currentSessionId ? " selected" : "") + (st && st.state === "exited" ? " exited" : "");
    var meta = sessionMeta[s.id] || {};
    var title = (sessionDisplayTitle(s) || s.tag || s.id.slice(0, 10)).replace(/[&<>]/g, "");
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
    return el;
}

function renderSessions(sessions) {
    var q = $("session-search").value.trim().toLowerCase();
    var filtered = sessions.filter(function(s) {
        var t = (s.tag || s.id).toLowerCase();
        return t.indexOf(q) !== -1;
    });
    var div = $("slist");
    div.innerHTML = filtered.length ? "" : '<div class="empty">' + (q ? "No matching sessions" : "No sessions yet") + '</div>';
    // Searching degrades to a flat list; empty query restores grouping.
    if (q) {
        filtered.forEach(function(s) { div.appendChild(renderSessionItem(s)); });
        return;
    }
    var groups = {};
    var order = [];
    filtered.forEach(function(s) {
        var g = sessionGroup(s);
        if (!groups[g.key]) { groups[g.key] = { label: g.label, items: [] }; order.push(g.key); }
        groups[g.key].items.push(s);
    });
    order.sort(function(a, b) {
        if (a === "ungrouped") return 1;
        if (b === "ungrouped") return -1;
        return groupLastActive(groups[b]) - groupLastActive(groups[a]);
    });
    var collapsed = getCollapsedGroups();
    order.forEach(function(key) {
        var g = groups[key];
        g.items.sort(function(a, b) { return (b.activeAt || 0) - (a.activeAt || 0); });
        var head = document.createElement("div");
        head.className = "group-header" + (collapsed[key] ? " collapsed" : "");
        head.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
            '<span class="group-name" title="' + esc(key) + '">' + esc(g.label) + '</span>' +
            '<span class="group-count">' + g.items.length + '</span>';
        head.onclick = function() { toggleGroup(key); };
        div.appendChild(head);
        if (collapsed[key]) return;
        g.items.forEach(function(s) { div.appendChild(renderSessionItem(s)); });
    });
}

function clearAllSessions() {
    var n = allSessions.length;
    if (!n) return;
    if (!confirm("Delete all " + n + " sessions from the server? Local conversations on your devices are NOT affected. Running sessions will reappear if their host posts again.")) return;
    api("DELETE", "/v1/sessions").then(function(res) {
        closeTerminal(true);
        currentSessionId = null;
        currentSession = null;
        $("messages").classList.add("hidden");
        $("input-area").classList.add("hidden");
        $("term-toggle-btn").classList.add("hidden");
        $("term-title").textContent = "Select a session";
        $("term-device").textContent = "";
        setTermState(null);
        $("placeholder").classList.remove("hidden");
        loadSessions();
        var deleted = res && res.deleted != null ? res.deleted : n;
        $("term-state-text").textContent = "Cleared " + deleted + " sessions";
    }).catch(function(e) { alert(e.message); });
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
    if (termOpen) closeTerminal(true);
    currentSessionId = s.id;
    currentSession = s;
    renderSessions(allSessions);
    $("placeholder").classList.add("hidden");
    $("messages").classList.remove("hidden");
    $("input-area").classList.remove("hidden");
    $("term-toggle-btn").classList.remove("hidden");
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

// Delete a session's server record. Same semantics as Clear: it comes back
// when the host resumes/reactivates that conversation.
function deleteSession(id, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (!confirm("Delete this session from the server? The conversation on the device is NOT affected — it comes back when resumed.")) return;
    api("DELETE", "/v1/sessions/" + id).then(function() {
        allSessions = allSessions.filter(function(s) { return s.id !== id; });
        $("scount").textContent = allSessions.length;
        if (currentSessionId === id) {
            closeTerminal(true);
            currentSessionId = null;
            currentSession = null;
            $("messages").classList.add("hidden");
            $("input-area").classList.add("hidden");
            $("term-toggle-btn").classList.add("hidden");
            $("term-title").textContent = "Select a session";
            $("term-device").textContent = "";
            setTermState(null);
            $("placeholder").classList.remove("hidden");
        }
        renderSessions(allSessions);
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
    if (resumeSendBusy) return; // the resume flow owns the controls
    var input = $("msg-input");
    input.disabled = false;
    input.placeholder = termState === "running"
        ? "Send a message..."
        : "session not running — sending a message will resume it";
    $("send-btn").disabled = !input.value.trim();
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
    renderSessions(allSessions); // exited sessions render greyed in the sidebar
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

    if (meta.command && meta.command.name) {
        // Slash command record (e.g. /clear, /rename) — subtle command line
        var cmd = document.createElement("div");
        cmd.className = "entry-line entry-command";
        var cmdPrompt = document.createElement("span");
        cmdPrompt.className = "entry-prompt command";
        cmdPrompt.textContent = "❯";
        var cmdText = document.createElement("span");
        cmdText.className = "command-text";
        cmdText.textContent = meta.command.name + (meta.command.args ? " " + meta.command.args : "");
        cmd.appendChild(cmdPrompt);
        cmd.appendChild(cmdText);
        entry.appendChild(cmd);
    } else if (role === "system") {
        // Command stdout (e.g. "Session renamed to: ...") — small gray ⎿ line
        var sys = document.createElement("div");
        sys.className = "entry-line entry-system";
        sys.textContent = "⎿  " + (m.content || "");
        entry.appendChild(sys);
    } else if (hasToolResults) {
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
// pushes it back as a plaintext-message update. When the session is not
// running, sending first resumes it (spawn with resumeId) and then delivers.
function sendMessage() {
    var input = $("msg-input");
    var text = input.value.trim();
    if (!text || !currentSessionId || !socket || resumeSendBusy) return;
    if (termState === "running") {
        socket.emit("term:input", { sessionId: currentSessionId, data: text + "\r" });
        input.value = "";
        input.style.height = "auto";
        $("send-btn").disabled = true;
        setInputError("");
        return;
    }
    resumeAndSend(text);
}

// Input-area error line (reuses the hint row under the textarea).
function setInputError(msg) {
    var el = $("input-hint");
    if (msg) {
        el.style.color = "var(--red)";
        el.textContent = msg;
    } else {
        el.style.color = "";
        el.textContent = "Press Enter to send, Shift+Enter for new line";
    }
}

var resumeSendBusy = false;

function setInputBusy(busy) {
    $("msg-input").disabled = busy;
    $("send-btn").disabled = busy;
    if (busy) $("msg-input").placeholder = "resuming session...";
}

// Wait until the session's terminal reports running. Two paths, both covered:
// (1) listen for terminal-state events (ephemeral fan-out + direct room event)
// (2) poll term:query-state once a second — catches the state even if the
//     event was missed. Gives up after 10s.
function waitForRunning(sessionId) {
    return new Promise(function(resolve, reject) {
        var done = false;
        var timeout = null;
        var poll = null;
        function finish(ok, err) {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            clearInterval(poll);
            socket.off("ephemeral", onEphemeral);
            socket.off("term:state", onState);
            if (ok) resolve(); else reject(err);
        }
        function onEphemeral(p) {
            if (p && p.type === "terminal-state" && p.sessionId === sessionId && p.state === "running") finish(true);
        }
        function onState(m) {
            if (m && m.sessionId === sessionId && m.state === "running") finish(true);
        }
        socket.on("ephemeral", onEphemeral);
        socket.on("term:state", onState);
        poll = setInterval(function() {
            socket.emit("term:query-state", { sessionId: sessionId }, function(ack) {
                if (ack && ack.ok && ack.state === "running") finish(true);
            });
        }, 1000);
        timeout = setTimeout(function() { finish(false, new Error("resume timed out")); }, 10000);
    });
}

function resumeAndSend(text) {
    var meta = sessionMeta[currentSessionId] || {};
    var claudeSessionId = meta.claudeSessionId;
    var cwd = meta.cwd;
    if (!claudeSessionId || !cwd) {
        setInputError("cannot resume: no claude session id");
        return;
    }
    resumeSendBusy = true;
    setInputBusy(true);
    setInputError("");
    var machineId = meta.deviceName || undefined;
    kvGet("profile:conv:" + claudeSessionId).then(function(v) {
        if (v) return v;
        return kvGet("profile:last").then(function(v2) { return v2 || "default"; });
    }).then(function(profileName) {
        return ccdRpc("spawn", { cwd: cwd, profileName: profileName, resumeId: claudeSessionId }, machineId);
    }).then(function(res) {
        // Tag dedup on the server usually returns the same sessionId
        var sid = (res && res.sessionId) || currentSessionId;
        return waitForRunning(sid).then(function() { return sid; });
    }).then(function(sid) {
        socket.emit("term:input", { sessionId: sid, data: text + "\r" });
        var input = $("msg-input");
        input.value = "";
        input.style.height = "auto";
        resumeSendBusy = false;
        setInputBusy(false);
        updateInputState();
        if (sid !== currentSessionId) loadSessions(); // server may have re-keyed the session
    }).catch(function(e) {
        // Keep the typed text intact on failure
        resumeSendBusy = false;
        setInputBusy(false);
        updateInputState();
        setInputError(spawnErrorText(e));
    });
}

// Textarea auto-resize
$("msg-input").addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(180, this.scrollHeight) + "px";
    $("send-btn").disabled = !this.value.trim();
    setInputError("");
});
$("msg-input").addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
$("send-btn").onclick = sendMessage;

// ===== Permission approval cards (floating, bottom-right) =====

var permCards = {}; // reqId -> {el, timer}

// Key-argument summary for a tool call (Bash → command, Read/Edit → file_path,
// else the first string arg), truncated for the card.
function permKeyArg(toolName, input) {
    if (!input || typeof input !== "object") return "";
    var v = input[TOOL_ARG_KEYS[toolName]];
    if (typeof v !== "string") {
        for (var k in input) {
            if (typeof input[k] === "string") { v = input[k]; break; }
        }
    }
    if (typeof v !== "string") return "";
    v = v.replace(/\s+/g, " ").trim();
    return v.length > 100 ? v.slice(0, 100) + "…" : v;
}

function permSessionTitle(sessionId) {
    var meta = sessionMeta[sessionId] || {};
    if (meta.title) return meta.title;
    var found = null;
    allSessions.forEach(function(s) { if (s.id === sessionId) found = s; });
    return (found && (found.tag || found.id.slice(0, 10))) || (sessionId || "").slice(0, 10);
}

function addPermCard(req) {
    if (!req || !req.reqId || permCards[req.reqId]) return;
    var box = $("perm-cards");
    var el = document.createElement("div");
    el.className = "perm-card";
    var arg = permKeyArg(req.toolName, req.input);
    el.innerHTML =
        '<div class="perm-title">Permission required</div>' +
        '<div class="perm-tool">' + esc(req.toolName || "tool") + (arg ? '<span class="perm-arg">(' + esc(arg) + ")</span>" : "") + '</div>' +
        '<div class="perm-session" title="Open session">' + esc(permSessionTitle(req.sessionId)) + '</div>' +
        '<div class="perm-actions">' +
            '<button class="perm-allow">Allow</button>' +
            '<button class="perm-deny">Deny</button>' +
        '</div>';
    el.querySelector(".perm-allow").onclick = function() { respondPerm(req.reqId, "allow"); };
    el.querySelector(".perm-deny").onclick = function() { respondPerm(req.reqId, "deny"); };
    el.querySelector(".perm-session").onclick = function() {
        var found = null;
        allSessions.forEach(function(s) { if (s.id === req.sessionId) found = s; });
        if (found) selectSession(found);
    };
    // Newest on top
    box.insertBefore(el, box.firstChild);
    permCards[req.reqId] = { el: el, timer: null };
}

function removePermCard(reqId) {
    var card = permCards[reqId];
    if (!card) return;
    if (card.timer) clearTimeout(card.timer);
    card.el.remove();
    delete permCards[reqId];
}

function respondPerm(reqId, decision) {
    var card = permCards[reqId];
    if (!card || card.timer) return; // already sending
    if (socket) socket.emit("perm:respond", { reqId: reqId, decision: decision });
    // Sending state until permission-resolved arrives (3s fallback)
    card.el.classList.add("sending");
    card.el.querySelectorAll("button").forEach(function(b) { b.disabled = true; });
    card.timer = setTimeout(function() { removePermCard(reqId); }, 3000);
}

// ===== Live terminal overlay (xterm.js over Socket.IO relay) =====
//
// Fallback for claude TUI interactions the transcript cannot show (e.g.
// /resume pickers, permission prompts). Covers the transcript area, relays
// keystrokes into the daemon PTY via term:input and renders term:output.
// While open, the host PTY follows the web terminal size (term:resize), so
// a local TUI attached to the same session may briefly look garbled — a
// known and accepted trade-off.

var XTERM_THEME = {
    background: "#0d0d0d",
    foreground: "#e6e6e6",
    cursor: "#aeafad",
    cursorAccent: "#0d0d0d",
    selectionBackground: "#3a3d41",
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
    brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
    brightCyan: "#29b8db", brightWhite: "#ffffff"
};

function disposeTerminal() {
    if (termRO) { termRO.disconnect(); termRO = null; }
    if (termResizeTimer) { clearTimeout(termResizeTimer); termResizeTimer = null; }
    if (term) { term.dispose(); term = null; }
    termFit = null;
}

function scheduleTermFit() {
    if (termResizeTimer) clearTimeout(termResizeTimer);
    termResizeTimer = setTimeout(function() {
        termResizeTimer = null;
        if (!term || !termFit || !currentSessionId) return;
        try { termFit.fit(); } catch (e) { return; }
        if (socket) {
            socket.emit("term:resize", { sessionId: currentSessionId, cols: term.cols, rows: term.rows });
        }
    }, 200);
}

function openTerminal() {
    if (!currentSessionId || !socket || termOpen) return;
    termOpen = true;
    $("term-overlay").classList.remove("hidden");
    joinTerminal(currentSessionId);
}

function closeTerminal(skipReload) {
    if (!termOpen) return;
    termOpen = false;
    if (socket && currentSessionId) {
        socket.emit("term:leave", { sessionId: currentSessionId });
    }
    disposeTerminal();
    $("term-overlay").classList.add("hidden");
    // The terminal session may have produced new messages; refresh the
    // transcript underneath.
    if (!skipReload && currentSessionId) loadMessages();
}

function joinTerminal(sessionId) {
    socket.emit("term:join", { sessionId: sessionId }, function(ack) {
        // The user may have switched sessions or closed the overlay while
        // the join was in flight.
        if (sessionId !== currentSessionId || !termOpen) {
            socket.emit("term:leave", { sessionId: sessionId });
            return;
        }
        if (!ack || !ack.ok) {
            closeTerminal(true);
            $("term-state-text").textContent = (ack && ack.error) ? String(ack.error) : "failed to join terminal";
            return;
        }
        disposeTerminal();
        term = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: "Menlo, monospace",
            theme: XTERM_THEME
        });
        termFit = new FitAddon.FitAddon();
        term.loadAddon(termFit);
        term.open($("term-container"));
        try { termFit.fit(); } catch (e) {}
        if (ack.scrollback) term.write(ack.scrollback);
        if (ack.meta) applySessionMeta(sessionId, ack.meta);
        if (ack.state) applySessionState(sessionId, ack.state, ack.exitCode);
        term.onData(function(data) {
            if (termState !== "running" || sessionId !== currentSessionId || !socket) return;
            socket.emit("term:input", { sessionId: sessionId, data: data });
        });
        termRO = new ResizeObserver(scheduleTermFit);
        termRO.observe($("term-container"));
        // Sync the initial size so the host PTY matches the web terminal
        if (termState === "running") {
            socket.emit("term:resize", { sessionId: sessionId, cols: term.cols, rows: term.rows });
        }
    });
}

$("term-toggle-btn").onclick = function() {
    if (termOpen) closeTerminal(); else openTerminal();
};
$("term-close-btn").onclick = function() { closeTerminal(); };

window.addEventListener("resize", scheduleTermFit);

// Login

function finishLogin(d) {
    TOKEN = d.token; ACCOUNT_ID = d.accountId;
    localStorage.setItem("cch_token", TOKEN);
    localStorage.setItem("cch_account_id", ACCOUNT_ID);
    if (d.mustChangePassword) {
        // Forced first-login password change — no skip, no dashboard access
        $("connect-screen").style.display = "none";
        $("change-screen").style.display = "flex";
        $("cp-current").focus();
        return;
    }
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
        err.style.color = "";
        err.textContent = e.message; btn.textContent = "Sign In"; btn.disabled = false;
    });
}

// ===== Password reset + Google sign-in (login card extras) =====

// Unauthenticated POST helper; surfaces rate limiting and backend error text.
function publicPost(path, body) {
    return fetch(SERVER + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    }).then(function(r) {
        if (r.status === 429) {
            throw new Error("Too many requests — please try again later");
        }
        return r.json().catch(function() {
            throw new Error(r.statusText || "Request failed");
        }).then(function(d) {
            if (!r.ok) throw new Error(d.error || r.statusText || "Request failed");
            return d;
        });
    });
}

$("forgot-link").onclick = function() {
    $("password-form").classList.remove("active");
    $("reset-form").classList.add("active");
    $("reset-step1").classList.remove("hidden");
    $("reset-step2").classList.add("hidden");
    $("reset-error").textContent = "";
    $("reset-email").focus();
};

$("reset-back").onclick = function() {
    $("reset-form").classList.remove("active");
    $("password-form").classList.add("active");
};

function sendResetCode() {
    var email = $("reset-email").value.trim();
    if (!email) { $("reset-error").textContent = "Please enter your email"; return; }
    $("reset-error").textContent = "";
    var btn = $("reset-send-btn");
    btn.disabled = true;
    btn.textContent = "Sending...";
    // Always {ok:true} server-side (no account enumeration)
    publicPost("/v1/auth/request-reset", { email: email }).then(function(d) {
        btn.disabled = false;
        btn.textContent = "Send reset code";
        $("reset-step1").classList.add("hidden");
        $("reset-step2").classList.remove("hidden");
        $("reset-info").textContent = "Code sent to " + email;
        var dev = $("reset-dev-code");
        if (d && d.devCode) {
            dev.textContent = "Dev code: " + d.devCode;
            dev.classList.remove("hidden");
        } else {
            dev.classList.add("hidden");
        }
        $("reset-code").focus();
    }).catch(function(e) {
        $("reset-error").textContent = e.message;
        btn.disabled = false;
        btn.textContent = "Send reset code";
    });
}

function submitReset() {
    var email = $("reset-email").value.trim();
    var code = $("reset-code").value.trim();
    var password = $("reset-password").value;
    if (!/^\d{6}$/.test(code)) { $("reset-error").textContent = "Please enter the 6-digit code"; return; }
    if (password.length < 8) { $("reset-error").textContent = "Password must be at least 8 characters"; return; }
    $("reset-error").textContent = "";
    var btn = $("reset-submit-btn");
    btn.disabled = true;
    btn.textContent = "Resetting...";
    publicPost("/v1/auth/reset", { email: email, code: code, password: password }).then(function() {
        btn.disabled = false;
        btn.textContent = "Reset password";
        $("reset-back").onclick();
        var le = $("login-error");
        le.style.color = "var(--green)";
        le.textContent = "Password reset — sign in with your new password";
    }).catch(function(e) {
        $("reset-error").textContent = e.message;
        btn.disabled = false;
        btn.textContent = "Reset password";
    });
}

$("reset-send-btn").onclick = sendResetCode;
$("reset-email").onkeydown = function(e) { if (e.key === "Enter") sendResetCode(); };
$("reset-submit-btn").onclick = submitReset;
$("reset-password").onkeydown = function(e) { if (e.key === "Enter") submitReset(); };
$("reset-code").onkeydown = function(e) { if (e.key === "Enter") submitReset(); };

// Show the Google button only when OAuth is configured (501 = not configured).
(function probeGoogle() {
    fetch(SERVER + "/v1/auth/google", { redirect: "manual" }).then(function(r) {
        if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) {
            $("google-btn").classList.remove("hidden");
        }
    }).catch(function() {});
})();
$("google-btn").onclick = function() {
    window.location.href = SERVER + "/v1/auth/google";
};

// ===== Change password (forced first-login screen + settings modal) =====

// Authed POST that treats 401 as a normal error ("invalid current password")
// instead of logging out like api() does.
function doChangePassword(curId, newId, confirmId, errId, btn, onSuccess) {
    var oldPw = $(curId).value;
    var newPw = $(newId).value;
    var confirm = $(confirmId).value;
    var err = $(errId);
    err.style.color = "";
    if (newPw.length < 8) { err.textContent = "New password must be at least 8 characters"; return; }
    if (newPw !== confirm) { err.textContent = "Passwords do not match"; return; }
    err.textContent = "";
    btn.disabled = true;
    btn.textContent = "Changing...";
    fetch(SERVER + "/v1/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw })
    }).then(function(r) {
        if (r.status === 429) throw new Error("Too many requests — please try again later");
        return r.json().catch(function() { throw new Error(r.statusText || "Request failed"); }).then(function(d) {
            if (!r.ok) throw new Error(d.error || (r.status === 401 ? "invalid current password" : r.statusText));
            return d;
        });
    }).then(function() {
        btn.disabled = false;
        btn.textContent = "Change password";
        onSuccess();
    }).catch(function(e) {
        err.textContent = e.message;
        btn.disabled = false;
        btn.textContent = "Change password";
    });
}

function openSettings() {
    ["sp-current", "sp-new", "sp-confirm"].forEach(function(id) { $(id).value = ""; });
    var msg = $("sp-msg");
    msg.style.color = "";
    msg.textContent = "";
    $("settings-modal").classList.add("open");
    $("sp-current").focus();
}
function closeSettings() {
    $("settings-modal").classList.remove("open");
}

$("open-settings").onclick = openSettings;
$("close-settings").onclick = closeSettings;
$("settings-modal").onclick = function(e) {
    if (e.target === $("settings-modal")) closeSettings();
};
$("sp-btn").onclick = function() {
    doChangePassword("sp-current", "sp-new", "sp-confirm", "sp-msg", this, function() {
        ["sp-current", "sp-new", "sp-confirm"].forEach(function(id) { $(id).value = ""; });
        var msg = $("sp-msg");
        msg.style.color = "var(--green)";
        msg.textContent = "Password changed";
    });
};
["sp-current", "sp-new", "sp-confirm"].forEach(function(id) {
    $(id).onkeydown = function(e) { if (e.key === "Enter") $("sp-btn").click(); };
});

$("cp-btn").onclick = function() {
    doChangePassword("cp-current", "cp-new", "cp-confirm", "cp-error", this, function() {
        $("change-screen").style.display = "none";
        showDashboard();
    });
};
["cp-current", "cp-new", "cp-confirm"].forEach(function(id) {
    $(id).onkeydown = function(e) { if (e.key === "Enter") $("cp-btn").click(); };
});

// Connect
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
        // Room membership is gone too; re-join the live terminal overlay.
        if (termOpen && currentSessionId) {
            disposeTerminal();
            joinTerminal(currentSessionId);
        }
        // Restore pending permission cards (page reloads/reconnects lose them)
        socket.emit("perm:list", {}, function(ack) {
            if (!ack || !ack.ok || !Array.isArray(ack.requests)) return;
            ack.requests.forEach(addPermCard);
        });
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
        if (!payload) return;
        if (payload.type === 'permission-request') {
            addPermCard(payload);
            return;
        }
        if (payload.type === 'permission-resolved') {
            removePermCard(payload.reqId);
            return;
        }
        if (!payload.sessionId) return;
        if (payload.type === 'terminal-state') {
            applySessionState(payload.sessionId, payload.state, payload.exitCode);
        } else if (payload.type === 'terminal-meta') {
            applySessionMeta(payload.sessionId, payload.meta);
        }
    });

    socket.on('perm:request', function(msg) {
        if (!msg || !msg.reqId) return;
        addPermCard(msg);
    });

    socket.on('term:output', function(msg) {
        if (!msg || msg.sessionId !== currentSessionId || !term) return;
        term.write(msg.data);
    });

    socket.on('term:state', function(msg) {
        if (!msg || !msg.sessionId) return;
        applySessionState(msg.sessionId, msg.state, msg.exitCode);
    });

    socket.on('term:meta', function(msg) {
        if (!msg || !msg.sessionId) return;
        applySessionMeta(msg.sessionId, msg.meta);
    });

    socket.on('ccd:rpc-result', handleRpcResult);

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
                    // cch/ccd (rust CLI) hidden — node-ccd is the only CLI now
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
    return "ccd connect " + shellQuote(conn) + " && ccd";
}

// ===== Session spawn modals (daemon RPC over the ccd:rpc relay) =====

var rpcSeq = 0;
var rpcPending = {};      // reqId -> {resolve, reject}

function ccdRpc(method, params, machineId) {
    return new Promise(function(resolve, reject) {
        if (!socket || !socket.connected) {
            reject(new Error("no daemon online"));
            return;
        }
        var reqId = "rpc-" + Date.now() + "-" + (++rpcSeq) + "-" + Math.random().toString(36).slice(2, 8);
        rpcPending[reqId] = { resolve: resolve, reject: reject };
        var payload = { reqId: reqId, method: method, params: params || {} };
        if (machineId) payload.machineId = machineId; // top-level, per relay protocol
        socket.emit("ccd:rpc", payload);
        // The server answers with an error after 30s when no daemon responds.
    });
}

function handleRpcResult(msg) {
    if (!msg || !msg.reqId) return;
    var p = rpcPending[msg.reqId];
    if (!p) return;
    delete rpcPending[msg.reqId];
    if (msg.error) {
        p.reject(new Error(typeof msg.error === "string" ? msg.error : (msg.error.message || "rpc error")));
    } else {
        p.resolve(msg.result);
    }
}

function spawnErrorText(e) {
    var msg = (e && e.message) || String(e);
    if (msg.indexOf("no daemon online") !== -1) return "No daemon online — connect a device first";
    return msg;
}

// Profile memory: GET/PUT /v1/kv/:key, values are plain profile-name strings.
function kvGet(key) {
    return api("GET", "/v1/kv/" + encodeURIComponent(key))
        .then(function(d) { return (d && d.value) || null; })
        .catch(function() { return null; });
}
function kvPut(key, value) {
    return api("PUT", "/v1/kv/" + encodeURIComponent(key), { value: value })
        .catch(function(e) { console.error("kvPut", key, e); });
}

function projectLabel(cwd) {
    if (!cwd) return "unknown";
    var parts = String(cwd).split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cwd;
}

// After a successful spawn: refresh the sidebar and open the new session.
function openSpawnedSession(sid) {
    if (!sid) return;
    loadSessions().then(function() {
        var found = null;
        allSessions.forEach(function(x) { if (x.id === sid) found = x; });
        // The daemon may not have created the server session yet; fall back
        // to a minimal record so the view still opens.
        selectSession(found || { id: sid, tag: null, createdAt: Date.now(), activeAt: Date.now(), msgCount: 0 });
    });
}

// List machines and probe each daemon with list-sessions; resolves to the
// ids of machines whose daemon answered (offline ones are dropped).
function probeOnlineDevices() {
    return api("GET", "/v1/machines").then(function(data) {
        var ms = Array.isArray(data) ? data : (data.machines || []);
        return Promise.all(ms.map(function(m) {
            return ccdRpc("list-sessions", {}, m.id)
                .then(function() { return m.id; })
                .catch(function() { return null; });
        }));
    }).then(function(ids) {
        return ids.filter(Boolean);
    });
}

// ----- Add session modal (new + resume in one) -----

var addDevices = [];        // online machine ids probed for the Add modal
var addAllConvs = [];       // prefetched global conversations: [{machineId, conversations}]
var addAllConvsLoaded = false;
var addDirConvs = [];       // conversations in the current Directory (default view)
var addShowAll = false;     // "show all N" expanded for the default view
var addBusy = false;        // a start/resume spawn is in flight
var cwdCommon = [];         // common dirs for the cwd autocomplete (from list-sessions)
var cwdSuggestItems = [];   // currently shown autocomplete entries
var cwdSuggestIndex = -1;   // keyboard-highlighted entry, -1 = none
var cwdSuggestTimer = null; // debounce timer for list-directories
var addDirTimer = null;     // debounce timer for list-conversations

function convTime(c) {
    var t = typeof c.updatedAt === "number" ? c.updatedAt : Date.parse(c.updatedAt);
    return isNaN(t) ? 0 : t;
}

function openAddModal() {
    $("add-modal").classList.add("open");
    $("add-error").textContent = "";
    $("add-search").value = "";
    $("add-profile").innerHTML = "";
    $("add-device").innerHTML = '<option value="">Loading devices...</option>';
    addDevices = [];
    addAllConvs = [];
    addAllConvsLoaded = false;
    addDirConvs = [];
    addShowAll = false;
    addBusy = false;
    cwdCommon = [];
    hideCwdSuggest();
    setConvStatus("Loading devices...");
    renderAddConvs();
    updateAddSubmit();
    loadAddDevices();
    // Prefill the current session's cwd so its conversations show up directly
    var meta = sessionMeta[currentSessionId] || {};
    $("add-cwd").value = meta.cwd || "";
    if (meta.cwd) scheduleAddDirConvs();
    $("add-cwd").focus();
}

function closeAddModal() {
    $("add-modal").classList.remove("open");
}

function setConvStatus(text) {
    $("add-conv-status").textContent = text;
}

function loadAddDevices() {
    probeOnlineDevices().then(function(online) {
        addDevices = online;
        var sel = $("add-device");
        sel.innerHTML = "";
        if (!online.length) {
            setConvStatus("No devices online");
            return;
        }
        online.forEach(function(id) {
            var opt = document.createElement("option");
            opt.value = id;
            opt.textContent = id;
            sel.appendChild(opt);
        });
        selectAddDevice(sel.value);
        // Prefetch global conversations so search mode filters locally
        if (!$("add-cwd").value.trim()) setConvStatus("Loading conversations...");
        Promise.all(online.map(function(id) {
            return ccdRpc("list-all-conversations", {}, id).then(function(res) {
                return { machineId: id, conversations: (res && res.conversations) || [] };
            }).catch(function() { return { machineId: id, conversations: [] }; });
        })).then(function(rows) {
            addAllConvs = rows;
            addAllConvsLoaded = true;
            setConvStatus("");
            renderAddConvs();
        });
    }).catch(function(e) {
        $("add-device").innerHTML = "";
        setConvStatus(spawnErrorText(e));
    });
}

function currentAddDevice() {
    return $("add-device").value || null;
}

function selectAddDevice(machineId) {
    if (!machineId) return;
    hideCwdSuggest();
    cwdCommon = [];
    addDirConvs = [];
    addShowAll = false;
    renderAddConvs();
    // Common directories = unique cwds of this device's sessions
    ccdRpc("list-sessions", {}, machineId).then(function(res) {
        var sessions = (res && res.sessions) || [];
        var seen = {};
        cwdCommon = [];
        sessions.forEach(function(s) {
            if (!s.cwd || seen[s.cwd]) return;
            seen[s.cwd] = true;
            cwdCommon.push(s.cwd);
        });
    }).catch(function(e) {
        $("add-error").textContent = spawnErrorText(e);
    });
    ccdRpc("list-profiles", {}, machineId).then(function(res) {
        var profiles = (res && res.profiles) || [];
        var sel = $("add-profile");
        sel.innerHTML = "";
        profiles.forEach(function(p) {
            var opt = document.createElement("option");
            opt.value = p.name;
            var extra = p.description || p.model || p.backend || "";
            opt.textContent = p.name + (extra ? " — " + extra : "");
            sel.appendChild(opt);
        });
        if (!profiles.length) {
            var opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(no profiles)";
            sel.appendChild(opt);
        }
        updateAddSubmit();
        // Default to the last used profile when this device offers it
        kvGet("profile:last").then(function(last) {
            if (!last) return;
            for (var i = 0; i < sel.options.length; i++) {
                if (sel.options[i].value === last) { sel.value = last; break; }
            }
            updateAddSubmit();
        });
    }).catch(function(e) {
        $("add-error").textContent = spawnErrorText(e);
    });
    scheduleAddDirConvs();
}

// Conversations of the current Directory (default view of the conv area)
function scheduleAddDirConvs() {
    if (addDirTimer) clearTimeout(addDirTimer);
    addDirTimer = setTimeout(function() {
        addDirTimer = null;
        fetchAddDirConvs();
    }, 500);
}

function fetchAddDirConvs() {
    var cwd = $("add-cwd").value.trim();
    var machineId = currentAddDevice();
    if (!cwd || !machineId) {
        addDirConvs = [];
        renderAddConvs();
        return;
    }
    ccdRpc("list-conversations", { cwd: cwd }, machineId).then(function(res) {
        // Drop stale results if the directory changed meanwhile
        if ($("add-cwd").value.trim() !== cwd) return;
        addDirConvs = (res && res.conversations) || [];
        renderAddConvs();
    }).catch(function() { /* keep previous cards on rpc failure */ });
}

function renderConvCard(c, machineId, cwd) {
    var el = document.createElement("div");
    el.className = "cwd-conv-card";
    var t = convTime(c);
    el.innerHTML =
        '<div class="conv-title">' + esc(c.title || (c.claudeSessionId || "").slice(0, 8)) + '</div>' +
        (t ? '<div class="conv-time">' + esc(ago(t)) + '</div>' : '');
    el.onclick = function() { resumeFromAddModal(el, machineId, cwd, c); };
    return el;
}

function renderAddConvs() {
    var box = $("add-conv-list");
    box.innerHTML = "";
    box.classList.toggle("busy", addBusy);
    var q = $("add-search").value.trim().toLowerCase();
    if (q) { renderAddSearchResults(box, q); return; }
    // Default mode: "new session" card first, then this directory's history
    var newCard = document.createElement("div");
    newCard.className = "cwd-conv-card new-card";
    newCard.innerHTML = '<div class="conv-title">✚ New session</div>';
    newCard.onclick = function() { if (!addBusy) submitAdd(); };
    box.appendChild(newCard);
    var showCount = addShowAll ? addDirConvs.length : Math.min(5, addDirConvs.length);
    var cwd = $("add-cwd").value.trim();
    addDirConvs.slice(0, showCount).forEach(function(c) {
        box.appendChild(renderConvCard(c, currentAddDevice(), cwd));
    });
    if (!addShowAll && addDirConvs.length > 5) {
        var more = document.createElement("div");
        more.className = "cwd-conv-card more";
        more.textContent = "show all " + addDirConvs.length;
        more.onclick = function() {
            addShowAll = true;
            renderAddConvs();
        };
        box.appendChild(more);
    }
}

function renderAddSearchResults(box, q) {
    if (!addAllConvsLoaded) return; // status line already says "Loading..."
    var any = false;
    addAllConvs.forEach(function(dev) {
        var matches = dev.conversations.filter(function(c) {
            var hay = ((c.title || "") + " " + (c.cwd || "") + " " + (c.claudeSessionId || "")).toLowerCase();
            return hay.indexOf(q) !== -1;
        });
        if (!matches.length) return;
        any = true;
        var devHead = document.createElement("div");
        devHead.className = "add-device-head";
        devHead.innerHTML = '<span>' + esc(dev.machineId) + '</span><span class="count">' + matches.length + '</span>';
        box.appendChild(devHead);
        // Second level: group by project (cwd last segment)
        var groups = {};
        var order = [];
        matches.forEach(function(c) {
            var proj = projectLabel(c.cwd);
            if (!groups[proj]) { groups[proj] = []; order.push(proj); }
            groups[proj].push(c);
        });
        order.sort(function(a, b) {
            var ta = 0, tb = 0;
            groups[a].forEach(function(c) { if (convTime(c) > ta) ta = convTime(c); });
            groups[b].forEach(function(c) { if (convTime(c) > tb) tb = convTime(c); });
            return tb - ta;
        });
        order.forEach(function(proj) {
            var items = groups[proj];
            items.sort(function(a, b) { return convTime(b) - convTime(a); });
            var pHead = document.createElement("div");
            pHead.className = "add-proj-head";
            pHead.textContent = proj;
            box.appendChild(pHead);
            items.forEach(function(c) {
                box.appendChild(renderConvCard(c, dev.machineId, c.cwd));
            });
        });
    });
    if (!any) {
        var empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No matching conversations";
        box.appendChild(empty);
    }
}

// Resume a conversation from a card (default or search mode alike): profile
// comes from the modal dropdown when loaded, otherwise the kv memory chain.
function resumeFromAddModal(cardEl, machineId, cwd, conv) {
    if (addBusy) return;
    addBusy = true;
    $("add-conv-list").classList.add("busy");
    cardEl.classList.add("loading");
    var timeEl = cardEl.querySelector(".conv-time");
    if (timeEl) timeEl.textContent = "starting...";
    var id = conv.claudeSessionId;
    var profileName = $("add-profile").value;
    var profilePromise = profileName
        ? Promise.resolve(profileName)
        : kvGet("profile:conv:" + id).then(function(v) {
            if (v) return v;
            return kvGet("profile:last").then(function(v2) { return v2 || "default"; });
        });
    profilePromise.then(function(name) {
        return ccdRpc("spawn", { cwd: cwd, profileName: name, resumeId: id }, machineId).then(function(res) {
            kvPut("profile:conv:" + id, name);
            kvPut("profile:last", name);
            return res;
        });
    }).then(function(res) {
        addBusy = false;
        closeAddModal();
        openSpawnedSession(res && res.sessionId);
    }).catch(function(e) {
        addBusy = false;
        renderAddConvs();
        $("add-error").textContent = spawnErrorText(e);
    });
}

// ----- Start button (new session in Directory) -----

function updateAddSubmit() {
    var btn = $("add-submit");
    if (btn.textContent === "Starting...") return; // submit in flight
    btn.disabled = addBusy || !currentAddDevice() || !$("add-cwd").value.trim() || !$("add-profile").value;
}

function submitAdd() {
    var machineId = currentAddDevice();
    var cwd = $("add-cwd").value.trim();
    var profileName = $("add-profile").value;
    if (!machineId || !cwd || !profileName || addBusy) return;
    addBusy = true;
    var btn = $("add-submit");
    btn.disabled = true;
    btn.textContent = "Starting...";
    ccdRpc("spawn", { cwd: cwd, profileName: profileName }, machineId).then(function(res) {
        kvPut("profile:last", profileName);
        closeAddModal();
        openSpawnedSession(res && res.sessionId);
    }).catch(function(e) {
        $("add-error").textContent = spawnErrorText(e);
    }).then(function() {
        addBusy = false;
        btn.textContent = "Start";
        updateAddSubmit();
    });
}

// ----- Directory autocomplete (list-directories RPC) -----

function hideCwdSuggest() {
    if (cwdSuggestTimer) { clearTimeout(cwdSuggestTimer); cwdSuggestTimer = null; }
    cwdSuggestItems = [];
    cwdSuggestIndex = -1;
    var box = $("add-cwd-suggest");
    box.classList.add("hidden");
    box.innerHTML = "";
}

function showCwdSuggest(items) {
    cwdSuggestItems = items || [];
    cwdSuggestIndex = -1;
    var box = $("add-cwd-suggest");
    box.innerHTML = "";
    if (!cwdSuggestItems.length) { box.classList.add("hidden"); return; }
    cwdSuggestItems.forEach(function(dir) {
        var el = document.createElement("div");
        el.className = "cwd-suggest-item";
        el.textContent = dir;
        el.title = dir;
        // mousedown (not click) + preventDefault: pick before the input blurs
        el.onmousedown = function(e) { e.preventDefault(); pickCwd(dir); };
        box.appendChild(el);
    });
    box.classList.remove("hidden");
}

function renderCwdSuggestActive() {
    var box = $("add-cwd-suggest");
    var kids = box.children;
    for (var i = 0; i < kids.length; i++) {
        kids[i].classList.toggle("active", i === cwdSuggestIndex);
    }
    if (cwdSuggestIndex >= 0 && kids[cwdSuggestIndex]) {
        kids[cwdSuggestIndex].scrollIntoView({ block: "nearest" });
    }
}

function pickCwd(dir) {
    // Programmatic value assignment fires no input event, so picking an entry
    // does not immediately retrigger completion.
    $("add-cwd").value = dir;
    hideCwdSuggest();
    updateAddSubmit();
    scheduleAddDirConvs();
    $("add-cwd").focus();
}

function scheduleCwdSuggest() {
    if (cwdSuggestTimer) clearTimeout(cwdSuggestTimer);
    cwdSuggestTimer = setTimeout(function() {
        cwdSuggestTimer = null;
        var text = $("add-cwd").value.trim();
        if (!text) { showCwdSuggest(cwdCommon); return; }
        var machineId = currentAddDevice();
        if (!machineId) { hideCwdSuggest(); return; }
        ccdRpc("list-directories", { prefix: text }, machineId).then(function(res) {
            // Drop stale results if the user kept typing meanwhile
            if ($("add-cwd").value.trim() !== text) return;
            var dirs = (res && res.dirs) || [];
            if (dirs.length) showCwdSuggest(dirs); else hideCwdSuggest();
        }).catch(function() { hideCwdSuggest(); });
    }, 300);
}

$("add-cwd").addEventListener("input", function() {
    updateAddSubmit();
    scheduleCwdSuggest();
    scheduleAddDirConvs();
});
$("add-cwd").addEventListener("focus", function() {
    if (!$("add-cwd").value.trim()) showCwdSuggest(cwdCommon);
});
$("add-cwd").addEventListener("keydown", function(e) {
    var open = !$("add-cwd-suggest").classList.contains("hidden");
    if (e.key === "Escape" && open) {
        // Close only the dropdown, not the whole modal
        e.preventDefault();
        e.stopPropagation();
        hideCwdSuggest();
        return;
    }
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var n = cwdSuggestItems.length;
        if (!n) return;
        cwdSuggestIndex = e.key === "ArrowDown"
            ? (cwdSuggestIndex + 1) % n
            : (cwdSuggestIndex - 1 + n) % n;
        renderCwdSuggestActive();
    } else if (e.key === "Enter" && cwdSuggestIndex >= 0 && cwdSuggestIndex < cwdSuggestItems.length) {
        e.preventDefault();
        pickCwd(cwdSuggestItems[cwdSuggestIndex]);
    }
});
document.addEventListener("mousedown", function(e) {
    if ($("add-cwd-suggest").classList.contains("hidden")) return;
    if (e.target.closest && e.target.closest(".cwd-field")) return;
    hideCwdSuggest();
});

// ----- Add modal wiring -----

$("open-add-modal").onclick = openAddModal;
$("close-add-modal").onclick = closeAddModal;
$("add-modal").onclick = function(e) {
    if (e.target === $("add-modal")) closeAddModal();
};
$("add-device").onchange = function() { selectAddDevice($("add-device").value); };
$("add-profile").onchange = updateAddSubmit;
$("add-submit").onclick = submitAdd;
$("add-search").addEventListener("input", function() {
    setConvStatus("");
    renderAddConvs();
});
$("add-search").addEventListener("keydown", function(e) {
    if (e.key === "Escape") {
        // Clear the search instead of closing the modal
        e.preventDefault();
        e.stopPropagation();
        this.value = "";
        renderAddConvs();
    }
});

// Events
$("login-btn").onclick = loginWithPassword;
$("login-password").onkeydown = function(e) { if (e.key === "Enter") loginWithPassword(); };
$("refresh-btn").onclick = refresh;
$("logout-btn").onclick = logout;
$("clear-sessions-btn").onclick = clearAllSessions;
$("gen-tk-btn").onclick = generateToken;
$("tk-label").onkeydown = function(e) { if (e.key === "Enter") generateToken(); };
// cch/ccd buttons commented out in the HTML (rust CLI out of scope)
// $("copy-cch-btn").onclick = function() { copyText(copyForCch($("new-conn").textContent)); };
// $("copy-ccd-btn").onclick = function() { copyText(copyForCcd($("new-conn").textContent)); };
$("copy-node-btn").onclick = function() { copyText(copyForNode($("new-conn").textContent)); };
$("copy-url-btn").onclick = function() { copyText($("new-conn").textContent); };

if (TOKEN) showDashboard();
