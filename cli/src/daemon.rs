//! ccd — Claude Code Daemon
//! Background process that keeps the machine "online" on the server via heartbeats.
//! Later: receives remote commands from the mobile app.
//!
//! Usage:
//!   ccd start     Start daemon (background)
//!   ccd stop      Stop daemon
//!   ccd status    Check if running

use anyhow::{Context, Result};
use std::process::Command;
use std::{env, fs, thread, time::Duration};

use cct::config;

fn pid_file() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".cch").join("ccd.pid")
}

fn token_cache_path() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".cch").join("token")
}

fn hostname() -> String {
    Command::new("hostname")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

fn bootstrap(server: &str, token: &str) -> Result<String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{server}/v1/auth/bootstrap"))
        .json(&serde_json::json!({ "token": token, "hostname": hostname() }))
        .timeout(Duration::from_secs(15))
        .send()
        .context("bootstrap failed")?;
    anyhow::ensure!(resp.status().is_success(), "bootstrap returned {}", resp.status());
    let data: serde_json::Value = resp.json()?;
    Ok(data["token"].as_str().unwrap().to_string())
}

fn heartbeat(server: &str, auth_token: &str, machine: &str) {
    match reqwest::blocking::Client::new()
        .post(format!("{server}/v1/machines/{machine}/heartbeat"))
        .header("Authorization", format!("Bearer {auth_token}"))
        .timeout(Duration::from_secs(10))
        .send()
    {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => eprintln!("ccd: heartbeat failed: {}", r.status()),
        Err(e) => eprintln!("ccd: heartbeat error: {e}"),
    }
}

fn run_daemon() -> Result<()> {
    let hc = config::load_happy_config()
        .context("Not connected. Run 'cch connect <url>' first.")?;

    let auth = match fs::read_to_string(token_cache_path()) {
        Ok(t) if t.starts_with(&hc.server) => {
            t.split('|').nth(1).unwrap_or("").trim().to_string()
        }
        _ => {
            let tok = bootstrap(&hc.server, &hc.token)?;
            let _ = fs::create_dir_all(token_cache_path().parent().unwrap());
            let _ = fs::write(token_cache_path(), format!("{}|{}", hc.server, tok));
            tok
        }
    };

    let machine = hostname();
    println!("ccd daemon started. Machine: {machine}");

    loop {
        heartbeat(&hc.server, &auth, &machine);
        thread::sleep(Duration::from_secs(30));
    }
}

fn start() -> Result<()> {
    let pid_path = pid_file();
    if pid_path.exists() {
        let pid = fs::read_to_string(&pid_path).unwrap_or_default().trim().to_string();
        if !pid.is_empty() {
            // Check if process is still running
            let status = Command::new("kill").arg("-0").arg(&pid).status();
            if status.map(|s| s.success()).unwrap_or(false) {
                println!("ccd is already running (PID: {pid})");
                return Ok(());
            }
        }
    }

    let exe = env::current_exe()?;
    let child = Command::new(&exe)
        .arg("daemon-run")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("failed to spawn daemon")?;

    let _ = fs::create_dir_all(pid_path.parent().unwrap());
    fs::write(&pid_path, child.id().to_string())?;
    println!("ccd started (PID: {})", child.id());
    Ok(())
}

fn stop() -> Result<()> {
    let pid_path = pid_file();
    if !pid_path.exists() {
        println!("ccd is not running.");
        return Ok(());
    }
    let pid = fs::read_to_string(&pid_path).unwrap_or_default().trim().to_string();
    if !pid.is_empty() {
        let _ = Command::new("kill").arg(&pid).status();
        let _ = fs::remove_file(&pid_path);
        println!("ccd stopped.");
    }
    Ok(())
}

fn status() -> Result<()> {
    let pid_path = pid_file();
    if !pid_path.exists() {
        println!("ccd: not running");
        return Ok(());
    }
    let pid = fs::read_to_string(&pid_path).unwrap_or_default().trim().to_string();
    let running = Command::new("kill").arg("-0").arg(&pid).status().map(|s| s.success()).unwrap_or(false);
    if running {
        println!("ccd: running (PID: {pid})");
    } else {
        println!("ccd: stale PID file (process not found)");
        let _ = fs::remove_file(&pid_path);
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let sub = args.get(1).map(|s| s.as_str()).unwrap_or("");

    let result = match sub {
        "start" => start(),
        "stop" => stop(),
        "status" => status(),
        "daemon-run" => run_daemon(), // internal: run the actual daemon loop
        _ => {
            println!("Usage: ccd <start|stop|status>");
            Ok(())
        }
    };

    if let Err(e) = result {
        eprintln!("ccd: {e:#}");
        std::process::exit(1);
    }
}
