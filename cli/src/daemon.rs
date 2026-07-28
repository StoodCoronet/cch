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
                        // Spawn bridge in background before exec replaces this process
                        let exe = env::current_exe()?;
                        let _ = Command::new(&exe).arg("bridge")
                            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                            .spawn()?;
                        let err = cct::launch::exec_claude_ccd(&app.profiles[app.selected], false);
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
