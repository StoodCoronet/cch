//! ccd — Claude Code Daemon
//! Background daemon: Socket.IO for real-time communication + JSONL sync for messages.

use anyhow::{Context, Result};
use cct::config;
use rust_socketio::asynchronous::ClientBuilder;
use serde_json::json;
use std::process::Command;
use std::time::Duration;
use std::{env, fs};
use tokio::time;

fn hostname() -> String {
    Command::new("hostname").output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}
fn token_cache_path() -> std::path::PathBuf { dirs::home_dir().unwrap_or_default().join(".cch").join("token") }
fn pid_file() -> std::path::PathBuf { dirs::home_dir().unwrap_or_default().join(".cch").join("ccd.pid") }

fn bootstrap(server: &str, token: &str) -> Result<String> {
    let client = reqwest::blocking::Client::builder().no_proxy().build().expect("reqwest");
    let resp = client.post(format!("{server}/v1/auth/bootstrap"))
        .json(&json!({ "token": token, "hostname": hostname() }))
        .timeout(Duration::from_secs(15)).send().context("bootstrap failed")?;
    anyhow::ensure!(resp.status().is_success(), "bootstrap returned {}", resp.status());
    Ok(resp.json::<serde_json::Value>()?["token"].as_str().unwrap().to_string())
}

fn get_or_bootstrap_auth(hc: &config::HappyConfig) -> Result<String> {
    match fs::read_to_string(token_cache_path()) {
        Ok(t) if t.starts_with(&hc.server) => Ok(t.split('|').nth(1).unwrap_or("").trim().to_string()),
        _ => {
            let tok = bootstrap(&hc.server, &hc.token)?;
            let _ = fs::create_dir_all(token_cache_path().parent().unwrap());
            let _ = fs::write(token_cache_path(), format!("{}|{}", hc.server, tok));
            Ok(tok)
        }
    }
}

fn unix_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 }

// —— daemon ——

async fn run_daemon() -> Result<()> {
    let hc = config::load_happy_config().context("Not connected. Run 'ccd connect <url>' first.")?;
    let auth_token = get_or_bootstrap_auth(&hc)?;
    let machine = hostname();

    // Kill proxy env that breaks localhost connections
    for k in &["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"] {
        env::remove_var(k);
    }

    let url = format!("{}/v1/updates", hc.server);
    let socket = ClientBuilder::new(url)
        .transport_type(rust_socketio::TransportType::Polling)
        .auth(json!({ "token": auth_token, "clientType": "machine-scoped", "machineId": machine }))
        .on("rpc-request", |payload, socket| {
            let sock = socket.clone();
            Box::pin(async move { handle_rpc(payload, sock).await; })
        })
        .connect().await.context("Socket.IO connect failed")?;

    // Register RPC + initial heartbeat
    let _ = socket.emit("rpc-register", json!({ "method": "bash" })).await;
    let _ = socket.emit("rpc-register", json!({ "method": "session-start" })).await;
    let _ = socket.emit("machine-alive", json!({ "machineId": machine, "time": unix_ms() })).await;

    println!("ccd: online — {}", machine);

    let mut heartbeat_tick = time::interval(Duration::from_secs(30));
    let mut monitor_tick = time::interval(Duration::from_secs(3));
    let server = hc.server.clone();
    let auth = auth_token.clone();

    loop {
        tokio::select! {
            _ = heartbeat_tick.tick() => {
                let _ = socket.emit("machine-alive", json!({ "machineId": machine, "time": unix_ms() })).await;
            }
            _ = monitor_tick.tick() => {
                let srv = server.clone(); let tok = auth.clone();
                tokio::task::spawn_blocking(move || sync_jsonl(&srv, &tok)).await.ok();
            }
        }
    }
}

fn sync_jsonl(server: &str, auth: &str) {
    let track_dir = dirs::home_dir().unwrap_or_default().join(".cch").join("sessions");
    if !track_dir.exists() { return; }
    let claude_dir = dirs::home_dir().unwrap_or_default().join(".claude").join("projects");
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();

    for entry in std::fs::read_dir(&track_dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().map_or(true, |e| e != "json") { continue; }
        let offset_path = path.with_extension("offset");

        let track: serde_json::Value = match fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()) {
            Some(v) => v, None => continue
        };
        let session_id = track["sessionId"].as_str().unwrap_or("");
        let cwd = track["cwd"].as_str().unwrap_or("");
        if session_id.is_empty() || cwd.is_empty() { continue; }

        let proj_name = cwd.replace('/', "-");
        let mut jsonls: Vec<_> = std::fs::read_dir(claude_dir.join(&proj_name)).into_iter().flatten()
            .filter_map(|e| e.ok()).filter(|e| e.path().extension().map_or(false, |e| e == "jsonl")).collect();
        jsonls.sort_by_key(|e| std::fs::metadata(e.path()).ok().and_then(|m| m.modified().ok()).unwrap_or(std::time::UNIX_EPOCH));
        jsonls.reverse();
        let jsonl = match jsonls.first() { Some(j) => j.path(), None => continue };

        let offset: u64 = fs::read_to_string(&offset_path).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        if let Ok(meta) = jsonl.metadata() {
            let size = meta.len();
            if size > offset {
                if let Ok(content) = fs::read(&jsonl) {
                    for line in content[offset as usize..].split(|&b| b == b'\n') {
                        if line.is_empty() { continue; }
                        if let Ok(msg) = serde_json::from_slice::<serde_json::Value>(line) {
                            let role = msg["type"].as_str().unwrap_or("");
                            let text = msg["message"]["content"].as_array()
                                .map(|p| p.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(""))
                                .unwrap_or_default();
                            if !text.is_empty() && (role == "user" || role == "assistant") {
                                let _ = client
                                    .post(format!("{server}/v1/sessions/{session_id}/plaintext-messages"))
                                    .header("Authorization", format!("Bearer {auth}"))
                                    .json(&json!({ "role": role, "content": text })).send();
                            }
                        }
                    }
                    let _ = fs::write(&offset_path, size.to_string());
                }
            }
        }
        if Command::new("pgrep").arg("-f").arg(cwd).output().map(|o| !o.status.success()).unwrap_or(true) {
            let _ = fs::remove_file(&path); let _ = fs::remove_file(&offset_path);
        }
    }
}

async fn handle_rpc(payload: rust_socketio::Payload, socket: rust_socketio::asynchronous::Client) {
    let data: serde_json::Value = match payload {
        rust_socketio::Payload::Text(v) => v.first().cloned().unwrap_or(serde_json::Value::Null),
        _ => return,
    };
    let method = data["method"].as_str().unwrap_or("");
    let params = &data["params"];
    let result = match method {
        "bash" => {
            let cmd = params["cmd"].as_str().unwrap_or("echo ok");
            match Command::new("bash").arg("-c").arg(cmd).output() {
                Ok(out) => json!({ "ok": true, "stdout": String::from_utf8_lossy(&out.stdout), "stderr": String::from_utf8_lossy(&out.stderr), "exitCode": out.status.code().unwrap_or(-1) }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "session-start" => {
            let cwd = params["cwd"].as_str().unwrap_or(".");
            let prompt = params["prompt"].as_str().unwrap_or("");
            let mut cmd = Command::new("claude"); cmd.current_dir(cwd);
            if !prompt.is_empty() { cmd.arg(prompt); }
            match cmd.spawn() { Ok(_) => json!({ "ok": true }), Err(e) => json!({ "ok": false, "error": e.to_string() }) }
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
        if !pid.is_empty() && Command::new("kill").arg("-0").arg(&pid).status().map(|s| s.success()).unwrap_or(false) {
            println!("ccd: already running (PID: {pid})"); return Ok(());
        }
    }
    let exe = env::current_exe()?;
    let child = Command::new(&exe).arg("foreground")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn()?;
    let _ = fs::create_dir_all(pp.parent().unwrap());
    fs::write(&pp, child.id().to_string())?;
    println!("ccd: started (PID: {})", child.id());
    Ok(())
}

fn stop_daemon() -> Result<()> {
    let pp = pid_file();
    if !pp.exists() { println!("ccd: not running"); return Ok(()); }
    let pid = fs::read_to_string(&pp).unwrap_or_default().trim().to_string();
    if !pid.is_empty() { let _ = Command::new("kill").arg(&pid).status(); let _ = fs::remove_file(&pp); println!("ccd: stopped"); }
    Ok(())
}

fn show_status() -> Result<()> {
    match config::load_happy_config() {
        Some(hc) => { let m = if hc.token.len() > 8 { format!("{}...{}", &hc.token[..4], &hc.token[hc.token.len()-4..]) } else { "****".into() }; println!("Server: {}\nToken:  {m}", hc.server); }
        None => println!("Server: not configured"),
    }
    let pp = pid_file();
    if !pp.exists() { println!("Daemon: not running"); return Ok(()); }
    let pid = fs::read_to_string(&pp).unwrap_or_default().trim().to_string();
    if Command::new("kill").arg("-0").arg(&pid).status().map(|s| s.success()).unwrap_or(false) {
        println!("Daemon: running (PID: {pid})\nMachine: {}", hostname());
    } else { println!("Daemon: stopped (stale PID)"); let _ = fs::remove_file(&pp); }
    Ok(())
}

fn do_connect(url: &str) -> Result<()> {
    let (server, token) = cct::launch::parse_connection_url(url)?;
    cct::config::write_happy_config(&server, &token)?;
    println!("Connected to {server}"); Ok(())
}

fn run_profile(name: Option<&str>) -> Result<()> {
    cct::config::ensure_default_config()?;
    let profiles = cct::config::load_profiles()?;
    let profile = match name {
        Some(n) => cct::config::find_profile_by_name(n)?.ok_or_else(|| anyhow::anyhow!("Profile '{}' not found", n))?,
        None => profiles.into_iter().next().ok_or_else(|| anyhow::anyhow!("No profiles. Run 'ccd add' first."))?,
    };
    let err = cct::launch::exec_claude(&profile, false);
    eprintln!("Error: {err:#}"); std::process::exit(1);
}

fn run_tui() -> Result<()> {
    use crossterm::{event::{self,Event,KeyCode,KeyModifiers},execute,terminal::{enable_raw_mode,EnterAlternateScreen}};
    use ratatui::{backend::CrosstermBackend,Terminal};
    use cct::app::{App,AppMode};
    cct::config::ensure_default_config()?;
    let _ = cct::config::ensure_codex_profile(); let _ = cct::config::ensure_kimi_profile();
    let _ = cct::launch::ensure_claude_onboarding();
    if !cct::launch::check_claude_installed() { cct::launch::prompt_install()?; }
    let profiles = cct::config::load_profiles()?;
    enable_raw_mode()?; let mut stdout = std::io::stdout(); execute!(stdout, EnterAlternateScreen)?;
    let mut tui = Terminal::new(CrosstermBackend::new(stdout))?;
    let mut app = App::new(profiles);
    loop {
        tui.draw(|f| cct::ui::draw(&app, f))?;
        if let Event::Key(key) = event::read()? {
            match &app.mode {
                AppMode::Normal => match (key.code, key.modifiers) {
                    (KeyCode::Char('q'), _)|(KeyCode::Char('c'), KeyModifiers::CONTROL) => { cct::launch::restore_terminal(); return Ok(()); }
                    (KeyCode::Down, _)|(KeyCode::Char('j'), _) => app.next(),
                    (KeyCode::Up, _)|(KeyCode::Char('k'), _) => app.prev(),
                    (KeyCode::Enter, _) if !app.profiles.is_empty() => {
                        cct::launch::restore_terminal();
                        let err = cct::launch::exec_claude(&app.profiles[app.selected], false);
                        eprintln!("Error: {err:#}"); std::process::exit(1);
                    }
                    _ => {}
                },
                AppMode::AddForm(_) => { if key.code == KeyCode::Esc { app.mode = AppMode::Normal; } }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let sub = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let result = match sub {
        "connect" => do_connect(args.get(2).unwrap_or_else(|| { eprintln!("Usage: ccd connect <url>"); std::process::exit(1); })),
        "disconnect" => cct::config::remove_happy_config().context("disconnect failed"),
        "run" => run_profile(args.get(2).map(|s| s.as_str())),
        "add" => { let be = args.get(2).and_then(|b| if b=="codex" { Some(cct::config::Backend::Codex) } else if b=="kimi" { Some(cct::config::Backend::Kimi) } else { None }); cct::cli::run_add(None, be.map(|b| format!("{:?}",b).to_lowercase())) },
        "edit" => { let p = cct::config::config_path(); cct::launch::open_editor(&p) },
        "start" => start_background(),
        "foreground" => { let rt = tokio::runtime::Runtime::new().unwrap(); rt.block_on(run_daemon()) },
        "stop" => stop_daemon(),
        "status" => show_status(),
        "" => run_tui(),
        _ => { println!("ccd <connect|disconnect|run|add|edit|start|stop|status>"); Ok(()) }
    };
    if let Err(e) = result { eprintln!("ccd: {e:#}"); std::process::exit(1); }
}
