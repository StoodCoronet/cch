var srv = window.location.origin;
var $ = function(id) { return document.getElementById(id); };

var SCREENS = ["loading-screen", "invalid-screen", "form-screen", "success-screen"];

function show(id) {
    SCREENS.forEach(function(s) { $(s).classList.toggle("hidden", s !== id); });
}

function setError(msg) {
    $("form-error").textContent = msg || "";
}

// Unauthenticated POST helper; surfaces rate limiting and backend error text.
function post(path, body) {
    return fetch(srv + path, {
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

var token = new URLSearchParams(window.location.search).get("token") || "";

if (!token) {
    $("invalid-reason").textContent = "missing invite token";
    show("invalid-screen");
} else {
    post("/v1/invites/validate", { token: token }).then(function(d) {
        if (d && d.ok) {
            show("form-screen");
            $("email-input").focus();
        } else {
            $("invalid-reason").textContent = (d && d.error) || "";
            show("invalid-screen");
        }
    }).catch(function(e) {
        $("invalid-reason").textContent = e.message;
        show("invalid-screen");
    });
}

function validEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function register() {
    var email = $("email-input").value.trim();
    var password = $("password-input").value;
    var confirm = $("confirm-input").value;
    if (!validEmail(email)) { setError("Please enter a valid email address"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirm) { setError("Passwords do not match"); return; }
    setError("");
    var btn = $("register-btn");
    btn.disabled = true;
    btn.textContent = "Registering...";
    post("/v1/invites/consume", { token: token, email: email, password: password }).then(function() {
        show("success-screen");
    }).catch(function(e) {
        setError(e.message);
        btn.disabled = false;
        btn.textContent = "Register";
    });
}

$("register-btn").onclick = register;
["email-input", "password-input", "confirm-input"].forEach(function(id) {
    $(id).onkeydown = function(e) { if (e.key === "Enter") register(); };
});
