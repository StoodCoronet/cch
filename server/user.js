var TOKEN = localStorage.getItem("cch_token") || "";
var ACCOUNT_ID = localStorage.getItem("cch_account_id") || "";
var SERVER = localStorage.getItem("cch_server") || window.location.origin;
var $ = function(id) { return document.getElementById(id); };

var refreshTimer = null;

// ---- Dashboard API ----

function api(method, path) {
    return fetch(SERVER + path, {
        method: method,
        headers: { "Authorization": "Bearer " + TOKEN }
    }).then(function(r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
    });
}

function loadSessions() {
    api("GET", "/v2/sessions/active?limit=50").then(function(data) {
        var tbody = $("sessions-tbody");
        tbody.innerHTML = "";
        $("session-count").textContent = "(" + data.sessions.length + ")";
        if (data.sessions.length === 0) {
            $("sessions-empty").classList.remove("hidden");
            return;
        }
        $("sessions-empty").classList.add("hidden");
        data.sessions.forEach(function(s) {
            var tr = document.createElement("tr");
            tr.innerHTML =
                "<td><code>" + s.id.slice(0, 12) + "</code></td>" +
                "<td><span class=\"badge " + (s.active ? "badge-active" : "badge-off") + "\">" + (s.active ? "Active" : "Idle") + "</span></td>" +
                "<td>" + ago(s.activeAt) + "</td>" +
                "<td>" + fmt(s.createdAt) + "</td>";
            tbody.appendChild(tr);
        });
    }).catch(function(e) {
        if (e.message === "401") disconnect();
    });
}

function loadMachines() {
    api("GET", "/v1/machines").then(function(data) {
        var tbody = $("machines-tbody");
        tbody.innerHTML = "";
        var machines = Array.isArray(data) ? data : [];
        if (machines.length === 0) {
            $("machines-empty").classList.remove("hidden");
            return;
        }
        $("machines-empty").classList.add("hidden");
        machines.forEach(function(m) {
            var tr = document.createElement("tr");
            tr.innerHTML =
                "<td><code>" + esc(m.id) + "</code></td>" +
                "<td><span class=\"badge " + (m.active ? "badge-active" : "badge-off") + "\">" + (m.active ? "Online" : "Offline") + "</span></td>" +
                "<td>" + ago(m.activeAt) + "</td>";
            tbody.appendChild(tr);
        });
    }).catch(function(e) {
        if (e.message === "401") disconnect();
    });
}

function refresh() {
    loadSessions();
    loadMachines();
}

// ---- Connect flow ----

function connect() {
    var input = $("connect-input").value.trim();
    if (!input) return;

    // Parse token from connection string or raw token
    var token = input;
    if (input.indexOf("?token=") !== -1) {
        token = input.split("?token=")[1];
        // Also extract server from the URL if present
        if (input.indexOf("://") !== -1) {
            var schemeEnd = input.indexOf("://");
            var hostStart = schemeEnd + 3;
            var pathStart = input.indexOf("/", hostStart);
            SERVER = input.substring(0, pathStart);
            localStorage.setItem("cch_server", SERVER);
        }
    }
    // Clean token (remove trailing spaces, quotes, etc)
    token = token.replace(/[\s"']/g, "");

    $("connect-error").textContent = "";
    $("connect-btn").textContent = "Connecting...";
    $("connect-btn").disabled = true;

    fetch(SERVER + "/v1/auth/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token, hostname: "web" })
    }).then(function(r) {
        if (!r.ok) {
            return r.json().then(function(e) { throw new Error(e.error || "Invalid token"); });
        }
        return r.json();
    }).then(function(data) {
        TOKEN = data.token;
        ACCOUNT_ID = data.accountId;
        localStorage.setItem("cch_token", TOKEN);
        localStorage.setItem("cch_account_id", ACCOUNT_ID);
        localStorage.setItem("cch_server", SERVER);
        showDashboard();
    }).catch(function(e) {
        $("connect-error").textContent = e.message;
        $("connect-btn").textContent = "Connect";
        $("connect-btn").disabled = false;
    });
}

function showDashboard() {
    $("connect-screen").classList.add("hidden");
    $("dashboard-screen").classList.remove("hidden");
    $("account-display").textContent = ACCOUNT_ID.slice(0, 12) + "...";
    refresh();
    refreshTimer = setInterval(refresh, 30000);
}

function disconnect() {
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

// ---- Helpers ----

function esc(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmt(ms) {
    return new Date(ms).toLocaleString();
}

function ago(ms) {
    var diff = Date.now() - ms;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
}

// ---- Event handlers ----

$("connect-btn").onclick = connect;
$("connect-input").onkeydown = function(e) { if (e.key === "Enter") connect(); };
$("refresh-btn").onclick = refresh;
$("disconnect-btn").onclick = disconnect;

// ---- Init ----

if (TOKEN) {
    showDashboard();
}

// Pre-fill connect input if URL has ?token= parameter
var urlParams = new URLSearchParams(window.location.search);
var urlToken = urlParams.get("token");
if (urlToken) {
    $("connect-input").value = window.location.href;
}
