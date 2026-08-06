//! ccd bridge — bidirectional message pump between webui and claude code.
//! Holds a persistent ClaudeProcess per session and forwards messages via stream-json.

use anyhow::{Context, Result};
use crate::claude_process::ClaudeProcess;
use crate::config;
use serde_json::json;
use std::process::Command;
use std::time::Duration;
use std::fs;
use tokio::time;

fn hostname() -> String {
    Command::new("hostname").output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

fn token_cache_path() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".cch").join("token")
}

fn bootstrap(server: &str, token: &str) -> Result<String> {
    let client = reqwest::blocking::Client::builder().no_proxy().build().expect("reqwest");
    let resp = client.post(format!("{server}/v1/auth/bootstrap"))
        .json(&json!({ "token": token, "hostname": hostname() }))
        .timeout(Duration::from_secs(15)).send()
        .context("cannot reach server — is it running?")?;
    anyhow::ensure!(resp.status().is_success(), "bootstrap returned {} — token may be invalid", resp.status());
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

struct BridgeSession {
    session_id: String,
    claude_session_id: String,
    cwd: String,
    profile_name: String,
    last_message_id: String,
}

fn load_latest_session() -> Option<BridgeSession> {
    let track_dir = dirs::home_dir().unwrap_or_default().join(".ccd").join("ccd_sessions");
    let latest = std::fs::read_dir(&track_dir).into_iter().flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|e| e == "json"))
        .max_by_key(|e| e.metadata().ok().and_then(|m| m.created().ok()).unwrap_or(std::time::UNIX_EPOCH))?;
    let track: serde_json::Value = serde_json::from_str(&fs::read_to_string(latest.path()).ok()?).ok()?;
    Some(BridgeSession {
        session_id: track["sessionId"].as_str()?.to_string(),
        claude_session_id: track["claudeSessionId"].as_str().unwrap_or("").to_string(),
        cwd: track["cwd"].as_str()?.to_string(),
        profile_name: track["profile"].as_str().unwrap_or("").to_string(),
        last_message_id: String::new(),
    })
}

fn fetch_new_messages(server: &str, auth: &str, session_id: &str, after: &str) -> Result<Vec<serde_json::Value>> {
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let url = format!("{server}/v1/sessions/{session_id}/plaintext-messages?role=user&limit=50");
    let url = if after.is_empty() { url } else { format!("{url}&after={after}") };
    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {auth}"))
        .timeout(Duration::from_secs(10))
        .send()
        .context("fetch messages failed")?;
    anyhow::ensure!(resp.status().is_success(), "fetch messages returned {}", resp.status());
    let data: serde_json::Value = resp.json()?;
    Ok(data["messages"].as_array().cloned().unwrap_or_default())
}

fn post_message(server: &str, auth: &str, session_id: &str, role: &str, content: &str, metadata: &serde_json::Value) -> Result<()> {
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    client.post(format!("{server}/v1/sessions/{session_id}/plaintext-messages"))
        .header("Authorization", format!("Bearer {auth}"))
        .json(&json!({ "role": role, "content": content, "metadata": metadata }))
        .timeout(Duration::from_secs(10))
        .send()
        .context("post message failed")?;
    Ok(())
}

fn send_activity(server: &str, auth: &str, session_id: &str) {
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let _ = client.post(format!("{server}/v1/sessions/{session_id}/activity"))
        .header("Authorization", format!("Bearer {auth}"))
        .timeout(Duration::from_secs(3)).send();
}

fn load_profile(profile_name: &str) -> Option<config::Profile> {
    config::load_profiles().ok()?.into_iter().find(|p| p.name.eq_ignore_ascii_case(profile_name))
}

pub async fn run_bridge() -> Result<()> {
    let hc = config::load_happy_config().context("Not connected. Run 'ccd connect <url>' first.")?;
    let auth = get_or_bootstrap_auth(&hc)?;

    // Wait for an active session to appear
    let session = loop {
        match load_latest_session() {
            Some(s) => break s,
            None => {
                eprintln!("ccd bridge: waiting for session...");
                time::sleep(Duration::from_secs(3)).await;
            }
        }
    };

    println!("ccd bridge: session={} claude={} cwd={}", session.session_id, session.claude_session_id, session.cwd);

    let server = hc.server.clone();
    let auth_tok = auth.clone();
    let session_id = session.session_id.clone();
    let claude_session_id = session.claude_session_id.clone();
    let cwd = session.cwd.clone();
    let profile_name = session.profile_name.clone();
    let mut last_id = session.last_message_id.clone();

    // Load profile for spawning claude
    let profile = load_profile(&profile_name).context("Profile not found")?;

    // Spawn persistent claude process with stream-json
    let resume_id = if claude_session_id.is_empty() { None } else { Some(claude_session_id.as_str()) };
    let mut claude = ClaudeProcess::spawn(&profile, &cwd, resume_id)?;

    // Capture session_id from init event
    if claude.session_id.is_empty() {
        if let Ok(Some(event)) = claude.read_event() {
            if let crate::claude_process::ClaudeEvent::Init { session_id: sid } = event {
                claude.session_id = sid;
            }
        }
    }
    eprintln!("ccd bridge: claude session_id={}", claude.session_id);

    let mut poll_tick = time::interval(Duration::from_secs(2));
    let mut activity_tick = time::interval(Duration::from_secs(30));

    loop {
        tokio::select! {
            _ = poll_tick.tick() => {
                if session_id.is_empty() { continue; }
                let srv = server.clone();
                let tok = auth_tok.clone();
                let sid = session_id.clone();
                let last = last_id.clone();
                let result = tokio::task::spawn_blocking(move || {
                    fetch_new_messages(&srv, &tok, &sid, &last)
                }).await;
                match result {
                    Ok(Ok(messages)) => {
                        for msg in messages {
                            let id = msg["id"].as_str().unwrap_or("").to_string();
                            let content = msg["content"].as_str().unwrap_or("");
                            if id.is_empty() || content.is_empty() { continue; }
                            eprintln!("ccd bridge: webui → claude: {}", &content[..content.len().min(80)]);

                            // Send to claude via stream-json
                            if let Err(e) = claude.send_message(content) {
                                eprintln!("ccd bridge: send to claude failed: {e}");
                                let srv2 = server.clone();
                                let tok2 = auth_tok.clone();
                                let sid2 = session_id.clone();
                                let _ = post_message(&srv2, &tok2, &sid2, "assistant", &format!("[error] {e}"), &json!({}));
                                continue;
                            }

                            // Read response
                            match claude.read_response() {
                                Ok(Some((text, metadata))) => {
                                    let srv2 = server.clone();
                                    let tok2 = auth_tok.clone();
                                    let sid2 = session_id.clone();
                                    if let Err(e) = post_message(&srv2, &tok2, &sid2, "assistant", &text, &metadata) {
                                        eprintln!("ccd bridge: post assistant failed: {e}");
                                    }
                                }
                                Ok(None) => {
                                    eprintln!("ccd bridge: claude EOF");
                                    let srv2 = server.clone();
                                    let tok2 = auth_tok.clone();
                                    let sid2 = session_id.clone();
                                    let _ = post_message(&srv2, &tok2, &sid2, "assistant", "[error] claude exited", &json!({}));
                                    break;
                                }
                                Err(e) => {
                                    eprintln!("ccd bridge: claude read error: {e}");
                                    let srv2 = server.clone();
                                    let tok2 = auth_tok.clone();
                                    let sid2 = session_id.clone();
                                    let _ = post_message(&srv2, &tok2, &sid2, "assistant", &format!("[error] {e}"), &json!({}));
                                }
                            }
                            last_id = id;
                        }
                    }
                    Ok(Err(e)) => eprintln!("ccd bridge: fetch error: {e}"),
                    Err(e) => eprintln!("ccd bridge: task error: {e}"),
                }
            }
            _ = activity_tick.tick() => {
                if !session_id.is_empty() {
                    let srv = server.clone();
                    let tok = auth_tok.clone();
                    let sid = session_id.clone();
                    tokio::task::spawn_blocking(move || send_activity(&srv, &tok, &sid)).await.ok();
                }
            }
        }

        if !claude.is_running() {
            eprintln!("ccd bridge: claude exited, restarting...");
            // Restart with --resume
            let resume_id = if claude.session_id.is_empty() { None } else { Some(claude.session_id.as_str()) };
            match ClaudeProcess::spawn(&profile, &cwd, resume_id) {
                Ok(p) => claude = p,
                Err(e) => {
                    eprintln!("ccd bridge: restart failed: {e}");
                    break;
                }
            }
        }
    }

    Ok(())
}
