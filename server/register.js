var srv = window.location.origin;
var $ = function(id) { return document.getElementById(id); };

var SCREENS = ["loading-screen", "invalid-screen", "form-screen", "verify-screen", "success-screen"];

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
var regEmail = "";
var regPassword = "";
var resendTimer = null;

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
    post("/v1/invites/consume", { token: token, email: email, password: password }).then(function(d) {
        btn.disabled = false;
        btn.textContent = "Register";
        if (d && d.pending) {
            // Two-step registration: email code sent, account not created yet
            regEmail = email;
            regPassword = password;
            enterVerify(d.devCode);
        } else {
            show("success-screen");
        }
    }).catch(function(e) {
        setError(e.message);
        btn.disabled = false;
        btn.textContent = "Register";
    });
}

function enterVerify(devCode) {
    $("verify-email").textContent = regEmail;
    $("verify-error").textContent = "";
    $("code-input").value = "";
    showDevCode(devCode);
    show("verify-screen");
    startResendCooldown();
    $("code-input").focus();
}

function showDevCode(devCode) {
    var el = $("dev-code");
    if (devCode) {
        el.textContent = "Dev code: " + devCode;
        el.classList.remove("hidden");
    } else {
        el.classList.add("hidden");
    }
}

function startResendCooldown() {
    if (resendTimer) clearInterval(resendTimer);
    var link = $("resend-link");
    var left = 60;
    link.classList.add("disabled");
    link.textContent = "Resend code (" + left + "s)";
    resendTimer = setInterval(function() {
        left--;
        if (left <= 0) {
            clearInterval(resendTimer);
            resendTimer = null;
            link.classList.remove("disabled");
            link.textContent = "Resend code";
        } else {
            link.textContent = "Resend code (" + left + "s)";
        }
    }, 1000);
}

function verify() {
    var code = $("code-input").value.trim();
    if (!/^\d{6}$/.test(code)) {
        $("verify-error").textContent = "Please enter the 6-digit code";
        return;
    }
    $("verify-error").textContent = "";
    var btn = $("verify-btn");
    btn.disabled = true;
    btn.textContent = "Verifying...";
    post("/v1/invites/verify", { token: token, email: regEmail, code: code, password: regPassword }).then(function() {
        show("success-screen");
    }).catch(function(e) {
        $("verify-error").textContent = e.message;
        btn.disabled = false;
        btn.textContent = "Verify";
    });
}

$("register-btn").onclick = register;
["email-input", "password-input", "confirm-input"].forEach(function(id) {
    $(id).onkeydown = function(e) { if (e.key === "Enter") register(); };
});
$("verify-btn").onclick = verify;
$("code-input").onkeydown = function(e) { if (e.key === "Enter") verify(); };
$("resend-link").onclick = function() {
    // Resend = re-run consume with the same registration data
    post("/v1/invites/consume", { token: token, email: regEmail, password: regPassword }).then(function(d) {
        if (d && d.devCode) showDevCode(d.devCode);
        startResendCooldown();
    }).catch(function(e) {
        $("verify-error").textContent = e.message;
    });
};
