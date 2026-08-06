//! ccd — Claude Code Daemon (interactive bidirectional mode)
//! TUI profile picker + daemon commands (start/stop/status) with bridge enabled.

use anyhow::{Context, Result};
use cct::daemon_control;
use std::process::Command;
use std::env;

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
    // Spawn bridge in background before exec replaces this process
    let exe = env::current_exe()?;
    let _ = Command::new(&exe).arg("bridge")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn()?;
    let err = cct::launch::exec_claude_ccd(&profile, false);
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
                        let profile = &app.profiles[app.selected];
                        let rt = tokio::runtime::Runtime::new().unwrap();
                        if let Err(e) = rt.block_on(run_interactive(profile)) {
                            eprintln!("Error: {e:#}");
                            std::process::exit(1);
                        }
                        return Ok(());
                    }
                    _ => {}
                },
                AppMode::AddForm(_) => { if key.code == KeyCode::Esc { app.mode = AppMode::Normal; } }
            }
        }
    }
}

/// Run claude with spawn-based pipes and bridge bidirectional sync.
/// This is the interactive mode for ccd: spawns claude as a child process,
/// holds stdin/stdout pipes, and forwards webui messages to claude.
async fn run_interactive(profile: &cct::config::Profile) -> Result<()> {
    use cct::claude_process::ClaudeProcess;
    use cct::daemon_control;

    let hc = cct::config::load_happy_config().context("Not connected. Run 'ccd connect <url>' first.")?;
    let auth = daemon_control::get_or_bootstrap_auth(&hc)?;
    let cwd = env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let hostname = daemon_control::hostname();

    // Report machine
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let _ = client.post(format!("{}/v1/machines/{hostname}/heartbeat", hc.server))
        .header("Authorization", format!("Bearer {auth}"))
        .timeout(std::time::Duration::from_secs(5)).send();

    // Spawn claude with pipes
    let cwd = env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let mut claude = ClaudeProcess::spawn(profile, &cwd, None)?;
    println!("ccd: claude spawned, starting interactive bridge...");

    // Create server session lazily on first message
    let mut server_session_id = String::new();
    let mut last_message_id = String::new();

    let server = hc.server.clone();
    let auth_tok = auth.clone();
    let mut poll_tick = tokio::time::interval(std::time::Duration::from_secs(2));
    let mut activity_tick = tokio::time::interval(std::time::Duration::from_secs(30));

    loop {
        tokio::select! {
            _ = poll_tick.tick() => {
                if server_session_id.is_empty() {
                    // Wait for first user message to create session
                    continue;
                }
                let srv = server.clone();
                let tok = auth_tok.clone();
                let sid = server_session_id.clone();
                let last = last_message_id.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let url = format!("{srv}/v1/sessions/{sid}/plaintext-messages?role=user&limit=50");
                    let url = if last.is_empty() { url } else { format!("{url}&after={last}") };
                    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
                    let resp = client.get(&url)
                        .header("Authorization", format!("Bearer {tok}"))
                        .timeout(std::time::Duration::from_secs(10))
                        .send()?;
                    let data: serde_json::Value = resp.json()?;
                    Ok::<_, anyhow::Error>(data["messages"].as_array().cloned().unwrap_or_default())
                }).await;
                match result {
                    Ok(Ok(messages)) => {
                        for msg in messages {
                            let id = msg["id"].as_str().unwrap_or("").to_string();
                            let content = msg["content"].as_str().unwrap_or("");
                            if id.is_empty() || content.is_empty() { continue; }
                            eprintln!("ccd: webui → claude: {}", &content[..content.len().min(80)]);
                            if let Err(e) = claude.send_message(content) {
                                eprintln!("ccd: send to claude failed: {e}");
                            }
                            last_message_id = id;
                        }
                    }
                    Ok(Err(e)) => eprintln!("ccd: fetch messages error: {e}"),
                    Err(e) => eprintln!("ccd: task error: {e}"),
                }
            }
            _ = activity_tick.tick() => {
                if !server_session_id.is_empty() {
                    let srv = server.clone();
                    let tok = auth_tok.clone();
                    let sid = server_session_id.clone();
                    tokio::task::spawn_blocking(move || {
                        let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
                        let _ = client.post(format!("{srv}/v1/sessions/{sid}/activity"))
                            .header("Authorization", format!("Bearer {tok}"))
                            .timeout(std::time::Duration::from_secs(3)).send();
                    }).await.ok();
                }
            }
        }

        // Read claude response and post to server
        if let Ok(Some((text, metadata))) = claude.read_response() {
            if !text.trim().is_empty() {
                eprintln!("ccd: claude → server: {}", &text[..text.len().min(80)]);
                if server_session_id.is_empty() {
                    // Create session on first message
                    match daemon_control::report_session_lazy(&server, &auth_tok, &cwd, &hostname, &claude.session_id) {
                        Ok(id) => server_session_id = id,
                        Err(e) => { eprintln!("ccd: session report failed: {e}"); continue; }
                    }
                }
                let srv = server.clone();
                let tok = auth_tok.clone();
                let sid = server_session_id.clone();
                let resp = text.clone();
                let meta = metadata.clone();
                tokio::task::spawn_blocking(move || {
                    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
                    let _ = client.post(format!("{srv}/v1/sessions/{sid}/plaintext-messages"))
                        .header("Authorization", format!("Bearer {tok}"))
                        .json(&serde_json::json!({ "role": "assistant", "content": resp, "metadata": meta }))
                        .timeout(std::time::Duration::from_secs(10)).send();
                }).await.ok();
            }
        }

        if !claude.is_running() {
            eprintln!("ccd: claude exited");
            break;
        }
    }

    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let sub = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let result = match sub {
        "connect" => do_connect(args.get(2).unwrap_or_else(|| { eprintln!("Usage: ccd connect <url>"); std::process::exit(1); })),
        "disconnect" => cct::config::remove_happy_config().context("disconnect failed"),
        "run" => run_profile(args.get(2).map(|s| s.as_str())),
        "add" => { let be = args.get(2).and_then(|b| if b=="codex"{Some(cct::config::Backend::Codex)}else if b=="kimi"{Some(cct::config::Backend::Kimi)}else{None}); cct::cli::run_add(None, be.map(|b| format!("{:?}",b).to_lowercase())) },
        "edit" => { let p = cct::config::config_path(); cct::launch::open_editor(&p) },
        "start" => daemon_control::start_background(true, ".ccd/ccd_sessions"),
        "foreground" => {
            let interactive = args.iter().any(|a| a == "--interactive");
            let session_dir = args.iter().position(|a| a == "--session-dir")
                .and_then(|i| args.get(i + 1))
                .map(|s| s.as_str())
                .unwrap_or(".ccd/ccd_sessions");
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(daemon_control::run_daemon(interactive, session_dir))
        },
        "bridge" => { let rt = tokio::runtime::Runtime::new().unwrap(); rt.block_on(cct::bridge::run_bridge()) },
        "stop" => daemon_control::stop_daemon(),
        "status" => daemon_control::show_status(),
        "tui" => run_tui(),
        "" => run_tui(),
        _ => { println!("ccd <connect|disconnect|run|add|edit|start|stop|status|tui>"); Ok(()) }
    };
    if let Err(e) = result { eprintln!("ccd: {e:#}"); std::process::exit(1); }
}
