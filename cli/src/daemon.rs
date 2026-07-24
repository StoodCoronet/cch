//! ccd — Claude Code Daemon
//!
//! Background daemon that connects to the cch-server via Socket.IO.
//! Handles machine heartbeats, RPC registration, and session monitoring.

use anyhow::{Context, Result};
use cct::config;
use rust_socketio::{
    asynchronous::ClientBuilder,
    Payload,
};
use serde_json::json;
use std::process::Command;
use std::time::Duration;
use std::{env, fs};
use tokio::time;

// —— helpers ——

fn hostname() -> String {
    Command::new("hostname")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

fn token_cache_path() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".cch").join("token")
}

fn pid_file() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".cch").join("ccd.pid")
}

fn bootstrap(server: &str, token: &str) -> Result<String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{server}/v1/auth/bootstrap"))
        .json(&json!({ "token": token, "hostname": hostname() }))
        .timeout(Duration::from_secs(15))
        .send()
        .context("bootstrap failed")?;
    anyhow::ensure!(resp.status().is_success(), "bootstrap returned {}", resp.status());
    let data: serde_json::Value = resp.json()?;
    Ok(data["token"].as_str().unwrap().to_string())
}

fn get_or_bootstrap_auth(hc: &config::HappyConfig) -> Result<String> {
    match fs::read_to_string(token_cache_path()) {
        Ok(t) if t.starts_with(&hc.server) => {
            Ok(t.split('|').nth(1).unwrap_or("").trim().to_string())
        }
        _ => {
            let tok = bootstrap(&hc.server, &hc.token)?;
            let _ = fs::create_dir_all(token_cache_path().parent().unwrap());
            let _ = fs::write(token_cache_path(), format!("{}|{}", hc.server, tok));
            Ok(tok)
        }
    }
}

// —— daemon ——

async fn run_daemon() -> Result<()> {
    let hc = config::load_happy_config()
        .context("Not connected. Run 'ccd connect <url>' first.")?;

    let auth_token = get_or_bootstrap_auth(&hc)?;
    let machine = hostname();
    println!("ccd: connecting to {} as {}", hc.server, machine);

    let socket = ClientBuilder::new(hc.server.clone())
        .namespace("/v1/updates")
        .transport_type(rust_socketio::TransportType::Websocket)
        .auth(json!({
            "token": auth_token,
            "clientType": "machine-scoped",
            "machineId": machine,
        }))
        .on("connect", |_, _| {
            Box::pin(async { println!("ccd: connected"); })
        })
        .on("rpc-request", |payload, socket| {
            let sock = socket.clone();
            Box::pin(async move {
                handle_rpc(payload, sock).await;
            })
        })
        .connect()
        .await
        .context("Socket.IO connect failed")?;

    // Register RPC methods
    let _ = socket.emit("rpc-register", json!({ "method": "bash" })).await;
    let _ = socket.emit("rpc-register", json!({ "method": "session-start" })).await;

    // Initial heartbeat
    let now = unix_ms();
    let _ = socket.emit("machine-alive", json!({ "machineId": machine, "time": now })).await;

    println!("ccd: daemon ready — {} online", machine);

    let mut heartbeat_tick = time::interval(Duration::from_secs(30));
    let mut monitor_tick = time::interval(Duration::from_secs(10));

    loop {
        tokio::select! {
            _ = heartbeat_tick.tick() => {
                let now = unix_ms();
                if let Err(e) = socket.emit("machine-alive", json!({ "machineId": machine, "time": now })).await {
                    eprintln!("ccd: heartbeat error: {e}");
                }
            }
            _ = monitor_tick.tick() => {
                let active = Command::new("pgrep").arg("-fl").arg("claude").output()
                    .map(|o| o.status.success() && !o.stdout.is_empty())
                    .unwrap_or(false);
                if let Err(e) = socket.emit("machine-update-state", json!({
                    "machineId": machine,
                    "daemonState": json!({ "hasClaude": active, "at": unix_ms() }).to_string(),
                    "expectedVersion": 0,
                })).await {
                    eprintln!("ccd: state update error: {e}");
                }
            }
        }
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

async fn handle_rpc(payload: Payload, socket: rust_socketio::asynchronous::Client) {
    let data: serde_json::Value = match &payload {
        Payload::Text(v) => v.first().cloned().unwrap_or(serde_json::Value::Null),
        Payload::Binary(b) => serde_json::from_slice(b).unwrap_or(serde_json::Value::Null),
        _ => serde_json::Value::Null,
    };
    let method = data["method"].as_str().unwrap_or("unknown");
    let params = &data["params"];

    let result = match method {
        "bash" => {
            let cmd = params["cmd"].as_str().unwrap_or("echo ok");
            match Command::new("bash").arg("-c").arg(cmd).output() {
                Ok(out) => json!({
                    "ok": true,
                    "stdout": String::from_utf8_lossy(&out.stdout).to_string(),
                    "stderr": String::from_utf8_lossy(&out.stderr).to_string(),
                    "exitCode": out.status.code().unwrap_or(-1),
                }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "session-start" => {
            let cwd = params["cwd"].as_str().unwrap_or(".");
            let prompt = params["prompt"].as_str().unwrap_or("");
            let mut cmd = Command::new("claude");
            cmd.current_dir(cwd);
            if !prompt.is_empty() { cmd.arg(prompt); }
            match cmd.spawn() {
                Ok(_) => json!({ "ok": true, "message": "session started" }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        _ => json!({ "ok": false, "error": format!("unknown: {method}") }),
    };

    let _ = socket.emit("rpc-response", result).await;
}

// —— CLI ——

fn start_background() -> Result<()> {
    let pp = pid_file();
    if pp.exists() {
        let pid = fs::read_to_string(&pp).unwrap_or_default().trim().to_string();
        if !pid.is_empty() {
            if Command::new("kill").arg("-0").arg(&pid).status().map(|s| s.success()).unwrap_or(false) {
                println!("ccd: already running (PID: {pid})");
                return Ok(());
            }
        }
    }
    let exe = env::current_exe()?;
    let child = Command::new(&exe)
        .arg("foreground")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let _ = fs::create_dir_all(pp.parent().unwrap());
    fs::write(&pp, child.id().to_string())?;
    println!("ccd: started (PID: {})", child.id());
    Ok(())
}

fn stop_daemon() -> Result<()> {
    let pp = pid_file();
    if !pp.exists() { println!("ccd: not running"); return Ok(()); }
    let pid = fs::read_to_string(&pp).unwrap_or_default().trim().to_string();
    if !pid.is_empty() {
        let _ = Command::new("kill").arg(&pid).status();
        let _ = fs::remove_file(&pp);
        println!("ccd: stopped");
    }
    Ok(())
}

fn show_status() -> Result<()> {
    match config::load_happy_config() {
        Some(hc) => {
            let masked = if hc.token.len() > 8 {
                format!("{}...{}", &hc.token[..4], &hc.token[hc.token.len() - 4..])
            } else { "****".into() };
            println!("Server: {}", hc.server);
            println!("Token:  {masked}");
        }
        None => println!("Server: not configured"),
    }
    let pp = pid_file();
    if !pp.exists() { println!("Daemon: not running"); return Ok(()); }
    let pid = fs::read_to_string(&pp).unwrap_or_default().trim().to_string();
    let running = Command::new("kill").arg("-0").arg(&pid).status().map(|s| s.success()).unwrap_or(false);
    if running {
        println!("Daemon: running (PID: {pid})");
        println!("Machine: {}", hostname());
    } else {
        println!("Daemon: stopped (stale PID)");
        let _ = fs::remove_file(&pp);
    }
    Ok(())
}

fn run_tui() -> Result<()> {
    use crossterm::{
        event::{self, Event, KeyCode, KeyModifiers},
        execute,
        terminal::{enable_raw_mode, EnterAlternateScreen},
    };
    use ratatui::backend::CrosstermBackend;
    use ratatui::Terminal;
    use std::io;
    use cct::app::{App, AppMode};

    cct::config::ensure_default_config()?;
    let _ = cct::config::ensure_codex_profile();
    let _ = cct::config::ensure_kimi_profile();
    let _ = cct::launch::ensure_claude_onboarding();

    if !cct::launch::check_claude_installed() {
        cct::launch::prompt_install()?;
    }

    let profiles = cct::config::load_profiles()?;
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let mut tui = Terminal::new(CrosstermBackend::new(stdout))?;
    let mut app = App::new(profiles);

    loop {
        tui.draw(|f| cct::ui::draw(&app, f))?;
        if let Event::Key(key) = event::read()? {
            match &app.mode {
                AppMode::Normal => match (key.code, key.modifiers) {
                    (KeyCode::Char('q'), _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => {
                        cct::launch::restore_terminal();
                        return Ok(());
                    }
                    (KeyCode::Down, _) | (KeyCode::Char('j'), _) => app.next(),
                    (KeyCode::Up, _) | (KeyCode::Char('k'), _) => app.prev(),
                    (KeyCode::Enter, _) if !app.profiles.is_empty() => {
                        cct::launch::restore_terminal();
                        let profile = &app.profiles[app.selected];
                        let err = cct::launch::exec_claude(profile, false);
                        eprintln!("Error: {err:#}");
                        std::process::exit(1);
                    }
                    _ => {}
                },
                AppMode::AddForm(_form) => {
                    // 'a' and 'e' handled by main.rs FormState logic
                    // Keep it simple for ccd — exit form on Esc
                    if key.code == KeyCode::Esc {
                        app.mode = AppMode::Normal;
                    }
                }
            }
        }
    }
}

fn run_profile(name: Option<&str>) -> Result<()> {
    cct::config::ensure_default_config()?;
    let profiles = cct::config::load_profiles()?;
    let profile = match name {
        Some(n) => cct::config::find_profile_by_name(n)?
            .ok_or_else(|| anyhow::anyhow!("Profile '{}' not found", n))?,
        None => profiles.into_iter().next()
            .ok_or_else(|| anyhow::anyhow!("No profiles. Run 'ccd add' first."))?,
    };
    let err = cct::launch::exec_claude(&profile, false);
    eprintln!("Error: {err:#}");
    std::process::exit(1);
}

fn do_connect(url: &str) -> Result<()> {
    let (server, token) = cct::launch::parse_connection_url(url)?;
    cct::config::write_happy_config(&server, &token)?;
    println!("Connected to {server}");
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let sub = args.get(1).map(|s| s.as_str()).unwrap_or("");

    let result = match sub {
        // —— cch-compatible commands ——
        "connect" => do_connect(args.get(2).unwrap_or_else(|| { eprintln!("Usage: ccd connect <url>"); std::process::exit(1); })),
        "disconnect" => cct::config::remove_happy_config().context("disconnect failed"),
        "run" => run_profile(args.get(2).map(|s| s.as_str())),
        "add" => {
            let backend = args.get(2).and_then(|b| {
                if b == "codex" { Some(cct::config::Backend::Codex) }
                else if b == "kimi" { Some(cct::config::Backend::Kimi) }
                else { None }
            });
            cct::cli::run_add(None, backend.map(|b| format!("{:?}", b).to_lowercase()))
        },
        "edit" => {
            let path = cct::config::config_path();
            cct::launch::open_editor(&path)
        },

        // —— daemon commands ——
        "start" => start_background(),
        "foreground" => {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(run_daemon())
        }
        "stop" => stop_daemon(),
        "status" => show_status(),

        // —— TUI mode (no args) ——
        "" => run_tui(),

        _ => {
            println!("ccd — Claude Code + Daemon");
            println!("  ccd                    TUI mode");
            println!("  ccd run [profile]      Launch session");
            println!("  ccd add [backend]      Add profile");
            println!("  ccd edit               Edit config");
            println!("  ccd connect <url>      Connect to server");
            println!("  ccd disconnect         Disconnect");
            println!("  ccd start              Start daemon");
            println!("  ccd stop               Stop daemon");
            println!("  ccd status             Show status");
            Ok(())
        }
    };

    if let Err(e) = result {
        eprintln!("ccd: {e:#}");
        std::process::exit(1);
    }
}
